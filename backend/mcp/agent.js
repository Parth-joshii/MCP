const axios = require('axios');
const { toolDefinitions } = require('./tools');
const { executeTool } = require('./toolExecutor');
const { describeDocument } = require('./documentRegistry');
const { optimizePrompt, formatPromptLayerForModel } = require('./promptWriter');

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim());

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || MODEL;
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 768);
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 256);
const DB_AGENT_TIMEOUT_MS = Number(process.env.MCP_DB_AGENT_TIMEOUT_MS || 8000);
const TABLE_ANSWER_LIMIT = Number(process.env.MCP_TABLE_ANSWER_LIMIT || 100);
const LLM_PROMPT_ENHANCER_ENABLED = isTruthy(process.env.MCP_LLM_PROMPT_ENHANCER);
const PROMPT_ENHANCER_TIMEOUT_MS = Number(process.env.MCP_PROMPT_ENHANCER_TIMEOUT_MS || 6000);
const PROMPT_ENHANCER_MAX_LENGTH = Number(process.env.MCP_PROMPT_ENHANCER_MAX_LENGTH || 420);
const LLM_MONGO_PLANNER_ENABLED = isTruthy(process.env.MCP_LLM_MONGO_PLANNER);
const MONGO_PLANNER_TIMEOUT_MS = Number(process.env.MCP_MONGO_PLANNER_TIMEOUT_MS || 8000);
const MONGO_PLANNER_SCHEMA_SOURCE_LIMIT = Number(process.env.MCP_MONGO_PLANNER_SCHEMA_SOURCE_LIMIT || 3);
const MONGO_PLANNER_SCHEMA_FIELD_LIMIT = Number(process.env.MCP_MONGO_PLANNER_SCHEMA_FIELD_LIMIT || 20);
const MONGO_FINAL_ANSWER_TIMEOUT_MS = Number(process.env.MCP_MONGO_FINAL_ANSWER_TIMEOUT_MS || 8000);
const MONGO_RESULT_CONTEXT_ROW_LIMIT = Number(process.env.MCP_MONGO_RESULT_CONTEXT_ROW_LIMIT || 25);
const MONGO_RESULT_CONTEXT_MAX_CHARS = Number(process.env.MCP_MONGO_RESULT_CONTEXT_MAX_CHARS || 12000);
const MONGO_FINAL_NUM_PREDICT = Number(process.env.MCP_MONGO_FINAL_NUM_PREDICT || 512);

const systemPrompt = `You are a generic database MCP client connected to a database MCP server.
Your job is to follow the MCP workflow: discover available database connections, inspect schemas/resources when needed, call tools with valid arguments, and then explain the result.
You are not tied to any specific application domain. Treat collection/table names as unknown until discovered or provided by the user.

AVAILABLE TOOLS:
${JSON.stringify(toolDefinitions, null, 2)}

INSTRUCTIONS:
1. If the user asks a question that requires database data, schema inspection, or database mutation, output ONLY a JSON object specifying the tool to call.
2. The JSON object must have this EXACT format:
   {
     "tool": "toolName",
     "parameters": { "param1": "value1" }
   }
3. DO NOT output any text other than the JSON object if you decide to use a tool.
4. Start with database.list_connections when the user asks what you can access.
5. Use database.describe before database.query when you need to discover tables, collections, fields, or relationships.
6. Prefer read-only operations against live databases.
7. For safe database edits, create or use a database snapshot first, preview snapshot updates, then update the snapshot working copy only after explicit confirmation.
8. Only use live database.write when the user clearly asks to mutate the live database and writes are enabled.
9. For document edits, preview with document.preview_update_cell first. Only use document.update_cell, document.add_row, or document.delete_rows after explicit confirmation.
10. Do not invent table/collection names. Discover them or ask the user for the database/table name.
11. Use document.answer_text_question for PDF, Word, text, and markdown questions. Use document.answer_table_question only for Excel/CSV table questions.
12. If no tool is needed (e.g. general conversation), respond normally in plain text.
13. Final user-facing answers should be structured with short sections when possible:
    Answer
    - direct result

    Details
    - source, matched rows, filters, or tool context

    Next
    - only include this when the user needs to confirm or take action

EXAMPLES:
User: "What databases can you access?"
{"tool": "database.list_connections", "parameters": {}}

User: "What collections and fields are available in default?"
{"tool": "database.describe", "parameters": {"databaseId": "default"}}

User: "How many rows are in my database?"
{"tool": "database.count_rows", "parameters": {"databaseId": "default"}}

User: "Show 5 rows from the customers collection in default"
{"tool": "database.query", "parameters": {"databaseId": "default", "collection": "customers", "operation": "find", "limit": 5}}

User: "How many documents are in customers?"
{"tool": "database.query", "parameters": {"databaseId": "default", "collection": "customers", "operation": "count"}}

User: "Group orders by city and sum totalAmount"
{"tool": "database.query", "parameters": {"databaseId": "default", "collection": "orders", "operation": "aggregate", "pipeline": [{"$group": {"_id": "$city", "total": {"$sum": "$totalAmount"}, "count": {"$sum": 1}}}, {"$sort": {"total": -1}}], "limit": 20}}

User: "Create a safe working copy of default database"
{"tool": "database.create_snapshot", "parameters": {"databaseId": "default"}}

User: "What documents are uploaded?"
{"tool": "document.list_sources", "parameters": {}}

User: "Search documents for payment terms"
{"tool": "document.search", "parameters": {"query": "payment terms", "limit": 5}}

User: "Show rows from the uploaded sales sheet"
{"tool": "document.query_table", "parameters": {"documentId": "DOCUMENT_ID", "limit": 20}}

User: "What is the product on date 02-03-2023?"
{"tool": "document.answer_table_question", "parameters": {"documentId": "DOCUMENT_ID", "question": "What is the product on date 02-03-2023?"}}

User: "What skills are mentioned in this resume PDF?"
{"tool": "document.answer_text_question", "parameters": {"documentId": "DOCUMENT_ID", "question": "What skills are mentioned in this resume PDF?", "limit": 5}}

User: "Preview changing product on date 02-03-2023 to Snacks"
{"tool": "document.preview_update_cell", "parameters": {"documentId": "DOCUMENT_ID", "filters": {"Sale Date": "02-03-2023"}, "column": "Product", "value": "Snacks"}}
`;

const knownToolNames = new Set(toolDefinitions.map((tool) => tool.name));

const ollamaOptions = {
  num_ctx: OLLAMA_NUM_CTX,
  num_predict: OLLAMA_NUM_PREDICT,
  temperature: 0
};

const withTimeout = async (promise, timeoutMs, label) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const pendingDocumentMutations = new Map();
const pendingDatabaseMutations = new Map();
const PENDING_MUTATION_TTL_MS = Number(process.env.MCP_PENDING_MUTATION_TTL_MS || 15 * 60 * 1000);

const getSessionKey = (context = {}) => context.sessionId || context.clientId || 'local-chat';

const normalizeForIntent = (value = '') => String(value).trim().toLowerCase();

const isConfirmMessage = (query) => /^(yes|y|confirm|apply|do it|ok|okay|save)$/i.test(query.trim());

const isCancelMessage = (query) => /^(no|n|cancel|stop|discard|never mind)$/i.test(query.trim());

const stripUserValue = (value = '') => String(value)
  .trim()
  .replace(/^["']|["']$/g, '')
  .replace(/[.?!]\s*$/g, '')
  .trim();

const extractDateValueFromQuery = (query) => {
  const patterns = [
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/,
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match) return match[0];
  }

  return null;
};

const normalizeLabel = (value = '') => String(value)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const compactLabel = (value = '') => normalizeLabel(value).replace(/\s+/g, '');

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const labelBoundaryRegex = (label) => new RegExp(`(^|\\s)${escapeRegex(label)}(?=\\s|$)`, 'i');

const singularizeToken = (token = '') => {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
};

const labelTokens = (value = '') => normalizeLabel(value)
  .split(/\s+/)
  .filter(Boolean)
  .map(singularizeToken);

const genericFieldTokens = new Set([
  'code',
  'date',
  'id',
  'name',
  'number',
  'status',
  'type',
  'value'
]);

const meaningfulTokenOverlap = (candidateTokens = [], fieldTokens = []) => {
  const meaningful = candidateTokens.filter((token) => !genericFieldTokens.has(token));
  if (meaningful.length === 0) return true;
  return meaningful.some((token) => fieldTokens.includes(token));
};

const fieldTokenMatchAllowed = (candidateTokens = [], fieldTokens = [], overlap = 0, ratio = 0) => {
  if (!meaningfulTokenOverlap(candidateTokens, fieldTokens)) return false;
  if (candidateTokens.length > 1 && fieldTokens.length > 1 && overlap < candidateTokens.length) return false;
  return overlap > 0 && (ratio > 0.5 || overlap === candidateTokens.length);
};

const findFieldByLabel = (fields = [], candidate) => {
  const normalizedCandidate = normalizeLabel(candidate);
  const compactCandidate = compactLabel(candidate);
  if (!normalizedCandidate) return null;

  const exact = fields.find((field) => (
    normalizeLabel(field) === normalizedCandidate ||
    compactLabel(field) === compactCandidate
  ));
  if (exact) return exact;

  const contains = fields.find((field) => {
    const normalizedField = normalizeLabel(field);
    const compactField = compactLabel(field);
    const fieldTokens = labelTokens(field);
    const candidateTokens = labelTokens(candidate);
    const fieldOnlyGeneric = fieldTokens.length > 0 && fieldTokens.every((token) => genericFieldTokens.has(token));
    const candidateHasMeaningful = candidateTokens.some((token) => !genericFieldTokens.has(token));
    if (fieldOnlyGeneric && candidateHasMeaningful) return false;
    return (
      normalizedField.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedField) ||
      compactField.includes(compactCandidate) ||
      compactCandidate.includes(compactField)
    );
  });
  if (contains) return contains;

  const candidateTokens = labelTokens(candidate);
  if (candidateTokens.length === 0) return null;

  return fields
    .map((field) => {
      const fieldTokens = labelTokens(field);
      const overlap = candidateTokens.filter((token) => fieldTokens.includes(token)).length;
      const score = overlap / Math.max(candidateTokens.length, 1);
      return {
        field,
        overlap,
        score,
        fieldTokenCount: fieldTokens.length,
        allowed: fieldTokenMatchAllowed(candidateTokens, fieldTokens, overlap, score)
      };
    })
    .filter((item) => item.allowed)
    .sort((a, b) => b.score - a.score || a.fieldTokenCount - b.fieldTokenCount)[0]?.field || null;
};

const fieldMatchQuality = (fields = [], candidate) => {
  const normalizedCandidate = normalizeLabel(candidate);
  const compactCandidate = compactLabel(candidate);
  if (!normalizedCandidate) return { field: null, score: 0 };

  const exact = fields.find((field) => normalizeLabel(field) === normalizedCandidate);
  if (exact) return { field: exact, score: 100 };

  const compactExact = fields.find((field) => compactLabel(field) === compactCandidate);
  if (compactExact) return { field: compactExact, score: 95 };

  const contains = fields
    .map((field) => {
      const normalizedField = normalizeLabel(field);
      const compactField = compactLabel(field);
      let score = 0;
      if (normalizedField.includes(normalizedCandidate)) score = 75;
      else if (normalizedCandidate.includes(normalizedField)) score = 62;
      else if (compactField.includes(compactCandidate)) score = 72;
      else if (compactCandidate.includes(compactField)) score = 58;
      return { field, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (contains) return contains;

  const candidateTokens = labelTokens(candidate);
  if (candidateTokens.length === 0) return { field: null, score: 0 };

  const tokenMatch = fields
    .map((field) => {
      const fieldTokens = labelTokens(field);
      const overlap = candidateTokens.filter((token) => fieldTokens.includes(token)).length;
      const ratio = overlap / Math.max(candidateTokens.length, 1);
      const allowed = fieldTokenMatchAllowed(candidateTokens, fieldTokens, overlap, ratio);
      return {
        field,
        score: allowed
          ? Math.round(40 + ratio * 20)
          : 0
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  return tokenMatch || { field: null, score: 0 };
};

const isExactFieldLabelMatch = (field, candidate) => {
  const normalizedField = normalizeLabel(field);
  const normalizedCandidate = normalizeLabel(candidate);
  if (!normalizedField || !normalizedCandidate) return false;
  return normalizedField === normalizedCandidate || compactLabel(field) === compactLabel(candidate);
};

const extractDatabaseRequestedField = (query, fields = []) => {
  const normalized = normalizeLabel(query);
  const phraseMatch = normalized.match(
    /^(?:what is|what are|whats|which|show|show me|tell|tell me|give|give me|get|find|how many)\s+(?:the\s+)?(.+?)(?=\s+(?:of|for|by|where|when|with|whose|that|which|from|in|on)\s+|$)/
  );
  const fieldFromPhrase = findFieldByLabel(fields, phraseMatch?.[1]);
  if (fieldFromPhrase) return fieldFromPhrase;

  const mentioned = fields
    .map((field) => {
      const label = normalizeLabel(field);
      const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
      return match ? { field, index: match.index + match[1].length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  return mentioned[0]?.field || null;
};

const uniqueValues = (values = []) => Array.from(new Set(values.filter(Boolean)));

const entityRequestedFieldHints = [
  { pattern: /\b(players?|batters?|batsmen|bowlers?|keepers?|all rounders?|allrounders?)\b/, labels: ['player_name', 'player name'] },
  { pattern: /\b(customers?|clients?|users?)\b/, labels: ['customer_name', 'customer name', 'user_name', 'user name', 'name'] },
  { pattern: /\b(products?|items?|line items?)\b/, labels: ['product_name', 'product name', 'item_name', 'item name', 'name'] },
  { pattern: /\b(teams?|clubs?)\b/, labels: ['team_name', 'team name'] },
  { pattern: /\b(accounts?)\b/, labels: ['account_id', 'account id', 'account_name', 'account name'] },
  { pattern: /\b(orders?)\b/, labels: ['order_id', 'order id'] },
  { pattern: /\b(transactions?)\b/, labels: ['transaction_id', 'transaction id'] },
  { pattern: /\bmatches?(?!\s+played)\b/, labels: ['match_id', 'match id'] }
];

const inferDatabaseEntityRequestedFields = (query, fields = []) => {
  const normalized = normalizeLabel(query);
  const isEntityQuestion = /\b(who|which|what|show|list|find|get|provide|give|how many|count|number of)\b/.test(normalized);
  if (!isEntityQuestion) return [];

  const inferred = [];
  for (const hint of entityRequestedFieldHints) {
    if (!hint.pattern.test(normalized)) continue;
    for (const label of hint.labels) {
      const field = findFieldByLabel(fields, label);
      if (field) {
        inferred.push(field);
        break;
      }
    }
  }

  if (inferred.length === 0 && /\bwho\b/.test(normalized)) {
    const nameField = fields.find((field) => /\bname\b/.test(normalizeLabel(field)));
    if (nameField) inferred.push(nameField);
  }

  return uniqueValues(inferred);
};

const implicitFilterStopWords = new Set([
  'the', 'a', 'an', 'this', 'that', 'selected', 'database', 'document', 'record',
  'row', 'rows', 'table', 'collection', 'details', 'detail', 'info', 'information', 'informations',
  'account', 'accounts', 'client', 'clients', 'customer', 'customers', 'order', 'orders',
  'item', 'items', 'line', 'product', 'products', 'player', 'players', 'transaction',
  'transactions', 'user', 'users'
]);

const cleanImplicitFilterValue = (value = '') => normalizeLabel(value)
  .split(/\s+/)
  .filter((token) => token && !implicitFilterStopWords.has(token))
  .join(' ')
  .trim();

const findImplicitIdentifierField = (fields = [], requestedFields = [], contextPhrase = '', sources = []) => {
  const requested = new Set(requestedFields.filter(Boolean));
  const context = normalizeLabel(contextPhrase);
  const contextualCandidates = [
    { pattern: /\baccounts?\b/, labels: ['account_id', 'account id', 'account_name', 'account name'] },
    { pattern: /\bclients?\b|\bcustomers?\b/, labels: ['customer_name', 'customer name', 'name'] },
    { pattern: /\bmatches?\b/, labels: ['match_id', 'match id'] },
    { pattern: /\borders?\b/, labels: ['order_id', 'order id'] },
    { pattern: /\bproducts?\b|\bitems?\b|\bline items?\b/, labels: ['product_name', 'product name', 'item_name', 'item name', 'name'] },
    { pattern: /\bplayers?\b/, labels: ['player_name', 'player name', 'name'] },
    { pattern: /\bteams?\b/, labels: ['team_name', 'team name', 'name'] },
    { pattern: /\btransactions?\b|\btxn\b/, labels: ['transaction_id', 'transaction id'] },
    { pattern: /\busers?\b/, labels: ['user_name', 'user name', 'name'] }
  ];

  for (const candidateGroup of contextualCandidates) {
    if (!candidateGroup.pattern.test(context)) continue;
    for (const label of candidateGroup.labels) {
      const field = findFieldByLabel(fields, label);
      if (field && !requested.has(field)) return field;
    }
  }

  const candidates = [
    'player_name',
    'player name',
    'customer_name',
    'customer name',
    'product_name',
    'product name',
    'item_name',
    'item name',
    'user_name',
    'user name',
    'team_name',
    'team name',
    'account_id',
    'account id',
    'order_id',
    'order id',
    'transaction_id',
    'transaction id',
    'match_id',
    'match id',
    'name',
    'id'
  ];

  const coOccursWithRequested = (field) => {
    if (!field || requested.size === 0 || sources.length === 0) return false;
    return sources.some((source) => {
      const sourceFields = source.fields || [];
      if (!findFieldByLabel(sourceFields, field)) return false;
      return Array.from(requested).some((requestedField) => findFieldByLabel(sourceFields, requestedField));
    });
  };

  const bestCandidate = candidates
    .map((candidate, index) => {
      const field = findFieldByLabel(fields, candidate);
      if (!field || requested.has(field)) return null;
      return { field, index, coOccurs: coOccursWithRequested(field) };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.coOccurs) - Number(a.coOccurs) || a.index - b.index)[0];

  if (bestCandidate) return bestCandidate.field;

  return fields.find((field) => (
    !requested.has(field) &&
    /\b(name|id)\b/.test(normalizeLabel(field))
  )) || null;
};

const extractImplicitEntityFilters = (query, fields = [], requestedFields = [], sources = []) => {
  const normalized = normalizeLabel(query);
  if (!/\b(of|for|about|by|named|called)\b/.test(normalized)) return [];

  const requested = requestedFields.filter(Boolean);
  const patterns = [
    /\b(?:of|for|about|by)\s+(?:the\s+)?(.+?)(?=\s+(?:where|with|whose|who|which|that|having|and)\b|$)/,
    /\b(?:named|called)\s+(.+?)(?=\s+(?:where|with|whose|who|which|that|having|and)\b|$)/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const rawValue = match?.[1] || '';
    const identifierField = findImplicitIdentifierField(fields, requested, rawValue, sources);
    if (!identifierField) return [];
    const value = cleanImplicitFilterValue(rawValue);
    if (!value) continue;
    if (findFieldByLabel(fields, value)) continue;
    if (requested.some((field) => normalizeLabel(field) === value)) continue;

    return [{
      field: identifierField,
      value,
      type: 'value',
      operator: value.split(/\s+/).length > 1 ? 'exact' : 'contains'
    }];
  }

  return [];
};

const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeConditionText = (value = '') => String(value)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_]+/g, ' ')
  .replace(/>=/g, ' greater than or equal to ')
  .replace(/<=/g, ' less than or equal to ')
  .replace(/>/g, ' greater than ')
  .replace(/</g, ' less than ')
  .replace(/=/g, ' equals ')
  .replace(/[^a-zA-Z0-9./\-\s]+/g, ' ')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const conditionValuePattern = '([a-z0-9./-]+(?:\\s+[a-z0-9./-]+){0,3})';

const cleanConditionValue = (value = '') => String(value)
  .trim()
  .replace(/\s+(?:and|where|with|for|on|in|then|to|as|into)\b.*$/i, '')
  .trim();

const parseComparisonFragment = (fragment = '') => {
  const hasEqualityLanguage = /^(?:is|are|was|were|equals|equal to|with|for|of|on|where|as|to|in|the)\s+/i.test(fragment.trim());
  const text = fragment
    .replace(/^(?:is|are|was|were|equals|equal to|with|for|of|on|where|as|to|in|the)\s+/, '')
    .trim();

  const between = text.match(new RegExp(`^between\\s+${conditionValuePattern}\\s+and\\s+${conditionValuePattern}\\b`, 'i'));
  if (between) {
    return {
      operator: 'between',
      value: {
        min: cleanConditionValue(between[1]),
        max: cleanConditionValue(between[2])
      },
      type: 'comparison'
    };
  }

  const patterns = [
    { operator: 'gte', regex: new RegExp(`^(?:greater than or equal to|greater than equal to|at least|minimum|min)\\s+${conditionValuePattern}`, 'i') },
    { operator: 'lte', regex: new RegExp(`^(?:less than or equal to|less than equal to|at most|maximum|max)\\s+${conditionValuePattern}`, 'i') },
    { operator: 'gt', regex: new RegExp(`^(?:greater than|more than|above|over|after)\\s+${conditionValuePattern}`, 'i') },
    { operator: 'lt', regex: new RegExp(`^(?:less than|below|under|before)\\s+${conditionValuePattern}`, 'i') }
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return {
        operator: pattern.operator,
        value: cleanConditionValue(match[1]),
        type: 'comparison'
      };
    }
  }

  if (hasEqualityLanguage && text) {
    return {
      operator: 'equals',
      value: cleanConditionValue(text).split(/\s+/).slice(0, 4).join(' '),
      type: 'comparison'
    };
  }

  return null;
};

const extractComparisonFiltersFromFields = (query, fields = [], ignoredFields = []) => {
  const normalized = normalizeConditionText(query);
  const ignored = new Set(ignoredFields.filter(Boolean));
  const filters = [];

  for (const field of fields) {
    if (!field || ignored.has(field) || filters.some((filter) => filter.field === field)) continue;
    const label = normalizeLabel(field);
    const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
    if (!match) continue;

    const comparison = parseComparisonFragment(normalized.slice(match.index + match[0].length).trim());
    if (comparison) filters.push({ field, ...comparison });
  }

  return filters;
};

const coerceQueryValue = (value) => {
  const numeric = toNumber(value);
  return numeric !== null && String(value ?? '').trim() !== '' ? numeric : value;
};

const extractDatabaseRequestedFields = (query, fields = []) => {
  const normalized = normalizeLabel(query);
  const phraseMatch = normalized.match(
    /^(?:what is|what are|whats|which|show|show me|tell|tell me|give|give me|get|find|how many)\s+(?:the\s+)?(.+?)(?=\s+(?:of|for|by|where|when|with|whose|that|which|from|in|on)\s+|$)/
  );
  const phrase = phraseMatch?.[1] || '';
  const fromPhrase = phrase
    .split(/\s+(?:and|or)\s+|[,/&]+/)
    .map((part) => findFieldByLabel(fields, part))
    .filter(Boolean);

  const mentioned = fields
    .map((field) => {
      const label = normalizeLabel(field);
      const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
      if (!match) return null;
      const before = normalized.slice(0, match.index).trim();
      if (/\b(where|whose|with|having|that|which)\b/.test(before)) return null;
      return { field, index: match.index + match[1].length };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.field);

  return uniqueValues([...fromPhrase, ...mentioned]);
};

const wantsDatabaseFullRowDetails = (query) => {
  const normalized = normalizeLabel(query);
  return /\b(details|detail|full details|record|records|row|rows|all data|all details|information|informations|info|profile)\b/.test(normalized);
};

const getDatabaseSourcesFromSchema = (schema = {}) => {
  if (Array.isArray(schema.collections)) {
    return schema.collections.map((collection) => ({
      name: collection.name,
      kind: 'collection',
      fields: collection.fields || Object.keys(collection.sample || {}),
      rowCountEstimate: collection.rowCountEstimate || 0
    }));
  }

  if (Array.isArray(schema.tables)) {
    return schema.tables.map((table) => ({
      name: table.schema ? `${table.schema}.${table.name}` : table.name,
      schema: table.schema,
      table: table.name,
      kind: 'table',
      fields: (table.columns || []).map((column) => column.name || column.column_name).filter(Boolean),
      rowCountEstimate: table.rowCountEstimate || 0
    }));
  }

  return [];
};

const sourceMentionScore = (query, source) => {
  const normalized = normalizeLabel(query);
  const labels = [source.name, source.table].filter(Boolean).map(normalizeLabel);
  let score = labels.some((label) => label && normalized.includes(label)) ? 35 : 0;

  const sourceName = normalizeLabel(source.name || source.table || '');
  const sourceHints = [
    { source: 'match', hints: ['match', 'matches', 'winner', 'won', 'toss', 'season', 'margin', 'player of match'] },
    { source: 'inning', hints: ['innings', 'inning', 'run rate', 'overs', 'extras'] },
    { source: 'performance', hints: ['performance', 'performances', 'scored', 'runs', 'wickets', 'balls', 'fours', 'sixes', 'catches', 'stumpings', 'economy rate', 'strike rate'] },
    { source: 'player', hints: ['player', 'players', 'batter', 'batters', 'bowler', 'bowlers', 'role', 'country', 'age', 'batting style', 'bowling style', 'matches played', 'total runs'] },
    { source: 'team', hints: ['team', 'teams', 'coach', 'home ground'] },
    { source: 'customer', hints: ['customer', 'customers', 'segment', 'loyalty', 'city', 'state', 'region'] },
    { source: 'product', hints: ['product', 'products', 'category', 'brand', 'stock', 'price', 'supplier'] },
    { source: 'order', hints: ['order', 'orders', 'sales', 'revenue', 'subtotal', 'discount', 'profit', 'channel', 'status'] },
    { source: 'item', hints: ['item', 'items', 'line item', 'quantity', 'product', 'category', 'sales amount', 'profit'] },
    { source: 'payment', hints: ['payment', 'payments', 'payment method', 'transaction reference', 'paid', 'refunded'] },
    { source: 'shipment', hints: ['shipment', 'shipments', 'carrier', 'delivery', 'delivered', 'shipping'] },
    { source: 'return', hints: ['return', 'returns', 'refund', 'reason', 'returned'] },
    { source: 'transaction', hints: ['transaction', 'transactions', 'amount', 'merchant', 'payment', 'category'] },
    { source: 'account', hints: ['account', 'accounts', 'balance', 'account type'] },
    { source: 'investment', hints: ['investment', 'investments', 'symbol', 'asset', 'market value'] },
    { source: 'budget', hints: ['budget', 'budgets', 'planned', 'variance'] }
  ];

  for (const hint of sourceHints) {
    if (!sourceName.includes(hint.source)) continue;
    if (hint.hints.some((item) => normalized.includes(item))) score += 8;
  }

  if (/\bmatches played\b/.test(normalized)) {
    if (sourceName.includes('player')) score += 30;
    if (sourceName.includes('match') && !sourceName.includes('player')) score -= 20;
  }

  return score;
};

const selectDatabaseSources = (query, sources, requestedFields, filters) => {
  const requestedList = Array.isArray(requestedFields)
    ? requestedFields.filter(Boolean)
    : [requestedFields].filter(Boolean);
  const normalized = normalizeLabel(query);
  const exactRequestedAvailable = new Set(requestedList.filter((requestedField) => (
    sources.some((source) => (source.fields || []).some((field) => isExactFieldLabelMatch(field, requestedField)))
  )).map(normalizeLabel));
  return sources
    .map((source, index) => {
      const fields = source.fields || [];
      const matchedRequested = requestedList.filter((field) => {
        const matchedField = findFieldByLabel(fields, field);
        if (!matchedField) return false;
        if (!exactRequestedAvailable.has(normalizeLabel(field))) return true;
        return isExactFieldLabelMatch(matchedField, field);
      }).length;
      const matchedFilters = filters.filter((filter) => findFieldByLabel(fields, filter.field)).length;
      const profileBoost = /\b(details|detail|information|informations|profile|all data|all details)\b/.test(normalized)
        ? filters.reduce((score, filter) => {
          const fieldLabel = normalizeLabel(filter.field);
          const sourceLabel = normalizeLabel(source.name || source.table || '');
          if (fieldLabel.includes('player') && sourceLabel.includes('player')) return score + 20;
          if (fieldLabel.includes('customer') && sourceLabel.includes('customer')) return score + 20;
          if (fieldLabel.includes('account') && sourceLabel.includes('account')) return score + 20;
          if (fieldLabel.includes('transaction') && sourceLabel.includes('transaction')) return score + 20;
          if (fieldLabel.includes('team') && sourceLabel.includes('team')) return score + 20;
          return score;
        }, 0)
        : 0;
      const hasEnoughRequestedFields = requestedList.length <= 1
        ? matchedRequested > 0 || requestedList.length === 0
        : matchedRequested === requestedList.length;
      const hasEnoughFilters = filters.length === 0 || matchedFilters === filters.length;
      const score = sourceMentionScore(query, source) + matchedRequested * 5 + matchedFilters * 3 + Math.min(source.rowCountEstimate || 0, 1000) / 1000;
      return { source, score: score + profileBoost, index, hasEnoughRequestedFields, hasEnoughFilters };
    })
    .filter((item) => item.score > 0 && item.hasEnoughRequestedFields && item.hasEnoughFilters)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.source);
};

const nextDateString = (dateValue) => {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const dateVariants = (dateValue) => {
  if (!dateValue) return [];
  const [year, month, day] = String(dateValue).split(/[-/]/);
  if (year?.length === 4 && month && day) {
    return [
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      `${day.padStart(2, '0')}-${month.padStart(2, '0')}-${year}`,
      `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`
    ];
  }
  return [dateValue];
};

const mongoTextRegex = (value = '', { exact = true } = {}) => {
  const tokens = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegex);
  if (tokens.length === 0) return exact ? '^$' : '';
  const body = tokens.join('[-_\\s]*');
  return exact ? `^${body}$` : body;
};

const buildMongoFilter = (filters = []) => {
  const clauses = [];

  for (const filter of filters) {
    if (filter.type === 'date') {
      const variants = dateVariants(filter.value);
      const next = nextDateString(variants[0]);
      const dateClauses = variants.map((value) => ({ [filter.field]: value }));

      if (next) {
        dateClauses.push({
          [filter.field]: {
            $gte: new Date(`${variants[0]}T00:00:00.000Z`),
            $lt: new Date(`${next}T00:00:00.000Z`)
          }
        });
      }

      clauses.push({ $or: dateClauses });
    } else if (filter.operator === 'between') {
      clauses.push({
        [filter.field]: {
          $gte: coerceQueryValue(filter.value?.min),
          $lte: coerceQueryValue(filter.value?.max)
        }
      });
    } else if (['gt', 'gte', 'lt', 'lte'].includes(filter.operator)) {
      const mongoOperator = {
        gt: '$gt',
        gte: '$gte',
        lt: '$lt',
        lte: '$lte'
      }[filter.operator];
      clauses.push({
        [filter.field]: {
          [mongoOperator]: coerceQueryValue(filter.value)
        }
      });
    } else {
      const numeric = Number(filter.value);
      const stringValue = String(filter.value ?? '').trim();
      const regex = filter.operator === 'contains'
        ? mongoTextRegex(stringValue, { exact: false })
        : mongoTextRegex(stringValue, { exact: true });
      clauses.push({
        [filter.field]: Number.isFinite(numeric) && String(filter.value).trim() !== ''
          ? { $in: [filter.value, numeric] }
          : { $regex: regex, $options: 'i' }
      });
    }
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
};

const sqlParam = (index, type) => (type === 'postgres' ? `$${index}` : '?');

const quoteSqlIdentifier = (identifier, type) => {
  const value = String(identifier);
  if (type === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
  return `"${value.replace(/"/g, '""')}"`;
};

const quoteSqlSource = (source, type) => {
  if (source.schema && type !== 'sqlite') {
    return `${quoteSqlIdentifier(source.schema, type)}.${quoteSqlIdentifier(source.table, type)}`;
  }
  return quoteSqlIdentifier(source.table || source.name, type);
};

const buildSqlWhere = (filters = [], type) => {
  const params = [];
  const clauses = [];

  for (const filter of filters) {
    const column = quoteSqlIdentifier(filter.field, type);
    if (filter.type === 'date') {
      params.push(filter.value);
      const placeholder = sqlParam(params.length, type);
      clauses.push(`DATE(${column}) = ${placeholder}`);
    } else if (filter.operator === 'between') {
      params.push(coerceQueryValue(filter.value?.min), coerceQueryValue(filter.value?.max));
      const minPlaceholder = sqlParam(params.length - 1, type);
      const maxPlaceholder = sqlParam(params.length, type);
      clauses.push(`${column} BETWEEN ${minPlaceholder} AND ${maxPlaceholder}`);
    } else if (['gt', 'gte', 'lt', 'lte'].includes(filter.operator)) {
      params.push(coerceQueryValue(filter.value));
      const placeholder = sqlParam(params.length, type);
      const sqlOperator = {
        gt: '>',
        gte: '>=',
        lt: '<',
        lte: '<='
      }[filter.operator];
      clauses.push(`${column} ${sqlOperator} ${placeholder}`);
    } else {
      params.push(filter.value);
      const placeholder = sqlParam(params.length, type);
      clauses.push(`${column} = ${placeholder}`);
    }
  }

  return {
    params,
    where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  };
};

const formatFilterValue = (value) => {
  if (value && typeof value === 'object' && 'min' in value && 'max' in value) {
    return `${value.min} and ${value.max}`;
  }
  return String(value ?? '');
};

const formatFilter = (filter = {}) => {
  if (filter.operator === 'between') {
    return `${filter.field} between ${formatFilterValue(filter.value)}`;
  }

  const operatorText = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    equals: '=',
    exact: '=',
    dateEquals: '='
  }[filter.operator] || '=';

  return `${filter.field} ${operatorText} ${formatFilterValue(filter.value)}`;
};

const dedupeSpecificFilters = (filters = []) => filters.filter((filter, index) => {
  const label = normalizeLabel(filter.field);
  const value = JSON.stringify(filter.value ?? '');
  const operator = filter.operator || '';
  const hasMoreSpecificDuplicate = filters.some((other, otherIndex) => {
    if (otherIndex === index) return false;
    const otherLabel = normalizeLabel(other.field);
    const otherValue = JSON.stringify(other.value ?? '');
    const otherOperator = other.operator || '';
    return otherValue === value &&
      otherOperator === operator &&
      otherLabel !== label &&
      otherLabel.endsWith(` ${label}`);
  });
  return !hasMoreSpecificDuplicate;
});

const countFieldValueAliases = [
  'age',
  'amount',
  'average',
  'balance',
  'budget',
  'economy rate',
  'fours',
  'income',
  'matches played',
  'played',
  'price',
  'quantity',
  'rate',
  'revenue',
  'runs',
  'salary',
  'score',
  'sixes',
  'strike rate',
  'total',
  'wickets'
];

const countQuestionWantsFieldValue = (query, requestedField, filters = []) => {
  const normalized = normalizeLabel(query);
  const requestedLabel = normalizeLabel(requestedField);
  if (!/\b(how many|count|number of)\b/.test(normalized)) return false;
  if (!requestedField || filters.length === 0) return false;
  if (/\b(id|name)\b/.test(requestedLabel)) return false;

  return countFieldValueAliases.some((alias) => (
    requestedLabel.includes(alias) || normalized.includes(alias)
  ));
};

const countQuestionWantsRowCount = (query, requestedField, filters = []) => {
  const normalized = normalizeLabel(query);
  const requestedLabel = normalizeLabel(requestedField);
  if (!/\b(how many|count|number of)\b/.test(normalized)) return false;
  if (/\b(rows|documents|records)\b/.test(normalized)) return true;
  if (filters.length > 0 && (!requestedField || filters.some((filter) => findFieldByLabel([requestedField], filter.field)))) return true;
  if (!requestedField) return false;
  if (countQuestionWantsFieldValue(query, requestedField, filters)) return false;
  return /\b(name|id)\b/.test(requestedLabel);
};

const extractDatabaseQuestion = (query, schema) => {
  const normalized = normalizeLabel(query);
  const sources = getDatabaseSourcesFromSchema(schema);
  const allFields = Array.from(new Set(sources.flatMap((source) => source.fields || [])));
  const fullRowDetails = wantsDatabaseFullRowDetails(query);
  const entityRequestedFields = inferDatabaseEntityRequestedFields(query, allFields);
  const explicitRequestedFields = extractDatabaseRequestedFields(query, allFields);
  let requestedFields = explicitRequestedFields.length
    ? explicitRequestedFields
    : entityRequestedFields;
  let requestedField = requestedFields[0] || extractDatabaseRequestedField(query, allFields);
  if (fullRowDetails) {
    requestedFields = [];
    requestedField = null;
  }
  const isCountQuery = /\b(how many|count|number of)\b/.test(normalized);
  const dateValue = extractDateValueFromQuery(query);
  const filters = [];

  if (dateValue) {
    const dateField = findFieldByLabel(allFields, 'date') ||
      allFields.find((field) => normalizeLabel(field).includes('date'));
    if (dateField) filters.push({ field: dateField, value: dateValue, type: 'date' });
  }

  const comparisonFilters = extractComparisonFiltersFromFields(query, allFields, [
    ...(isCountQuery ? [] : [requestedField, ...requestedFields]),
    ...filters.map((filter) => filter.field)
  ]);
  filters.push(...comparisonFilters);
  filters.push(...extractImplicitEntityFilters(query, allFields, [requestedField, ...requestedFields], sources));

  for (const field of allFields) {
    if (
      field === requestedField ||
      requestedFields.some((requested) => field === requested || Boolean(findFieldByLabel([field], requested))) ||
      filters.some((filter) => filter.field === field)
    ) continue;
    const label = normalizeLabel(field);
    const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
    if (!match) continue;

    let fragment = normalized.slice(match.index + match[0].length).trim();
    fragment = fragment.replace(/^(is|equals|equal to|equal|with|for|of|by|on|where|as|to|in)\s+/, '').trim();
    if (!fragment) continue;

    const stopMatch = fragment.match(/\s+(?:and|where|with|in|on|for|by)\s+/);
    if (stopMatch) fragment = fragment.slice(0, stopMatch.index).trim();
    const value = fragment.split(/\s+/).slice(0, 4).join(' ');
    if (value) filters.push({ field, value, type: 'value' });
  }

  filters.splice(0, filters.length, ...dedupeSpecificFilters(filters));

  requestedFields = uniqueValues(requestedFields).filter((field) => (
    !filters.some((filter) => findFieldByLabel([field], filter.field))
  ));
  requestedField = requestedFields[0] || requestedField;

  const wantsFieldValueForCount = countQuestionWantsFieldValue(query, requestedField, filters);
  const wantsRowCount = countQuestionWantsRowCount(query, requestedField, filters);
  const wantsDistinctCount = isCountQuery &&
    !wantsFieldValueForCount &&
    !wantsRowCount &&
    requestedFields.length <= 1 &&
    requestedField &&
    !/\b(rows|documents|records)\b/.test(normalized);

  return {
    sources,
    requestedField,
    requestedFields,
    filters,
    fullRowDetails,
    wantsFieldValueForCount,
    wantsRowCount,
    wantsDistinctCount
  };
};

const mutationColumnAliases = [
  { column: 'Product', aliases: ['product name', 'name of product', 'product', 'item name', 'item'] },
  { column: 'Sales Amount', aliases: ['sales amount', 'sale amount', 'total sales', 'total revenue', 'revenue', 'amount', 'sales'] },
  { column: 'Price per Unit', aliases: ['price per unit', 'unit price', 'price', 'rate'] },
  { column: 'Quantity', aliases: ['quantity', 'qty', 'units', 'number of units'] },
  { column: 'City', aliases: ['city', 'town'] },
  { column: 'State', aliases: ['state', 'province'] },
  { column: 'Region', aliases: ['region', 'zone'] },
  { column: 'Sale Date', aliases: ['sale date', 'order date', 'date'] }
];

const includesIntentPhrase = (text, phrase) => {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
};

const findMutationColumn = (query) => {
  for (const group of mutationColumnAliases) {
    if (group.aliases.some((alias) => includesIntentPhrase(query, alias))) {
      return group.column;
    }
  }

  return null;
};

const extractMutationFieldPhrase = (query) => {
  const match = query.match(/\b(?:update|change|set|replace|edit|correct|modify)\s+(?:the\s+)?(.+?)\s+(?:to|as|into)\b/i);
  return match?.[1] ? stripUserValue(match[1]) : null;
};

const extractMutationValue = (query) => {
  const quoted = query.match(/\b(?:to|as|into)\s+["']([^"']+)["']/i);
  if (quoted?.[1]) return stripUserValue(quoted[1]);

  const valueMatch = query.match(/\b(?:to|as|into)\s+(.+?)(?=\s+(?:where|when|for|on|in|with)\b|$)/i);
  if (valueMatch?.[1]) return stripUserValue(valueMatch[1]);

  return null;
};

const extractRowIndex = (query) => {
  const match = query.match(/\brow\s+index\s+(\d+)\b/i);
  if (!match) return undefined;
  return Number(match[1]);
};

const fieldsForSnapshotSource = (source = {}) => {
  if (Array.isArray(source.fields) && source.fields.length > 0) return source.fields;
  if (Array.isArray(source.columns)) {
    return source.columns.map((column) => column.name || column.column_name || column).filter(Boolean);
  }
  return [];
};

const latestSnapshotForDatabase = (snapshots = [], databaseId) => {
  return snapshots
    .filter((snapshot) => !databaseId || snapshot.databaseId === databaseId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
};

const getLatestOrCreateDatabaseSnapshot = async (databaseId, { refreshEmpty = false } = {}) => {
  const createSnapshot = async () => {
    const createResult = await withTimeout(
      executeTool('database.create_snapshot', { databaseId }),
      DB_AGENT_TIMEOUT_MS,
      `Creating database working copy for ${databaseId}`
    ).catch((error) => ({
      isError: true,
      structuredContent: { error: error.message },
      content: [{ type: 'text', text: error.message }]
    }));

    if (createResult.isError) {
      return {
        isError: true,
        databaseId,
        toolUsed: 'database.create_snapshot',
        toolResult: createResult,
        error: createResult.structuredContent?.error || createResult.content?.[0]?.text || 'Unknown snapshot error.'
      };
    }

    return {
      isError: false,
      databaseId,
      snapshot: createResult.structuredContent,
      snapshotToolResult: createResult,
      createdSnapshot: true,
      toolUsed: 'database.create_snapshot'
    };
  };

  const snapshotsResult = await executeTool('database.list_snapshots', { databaseId });
  let snapshot = latestSnapshotForDatabase(snapshotsResult.structuredContent || [], databaseId);
  let snapshotToolResult = snapshotsResult;
  let createdSnapshot = false;

  if (!snapshot) {
    return createSnapshot();
  }

  if (refreshEmpty && (snapshot.sources || []).length === 0) {
    const describeResult = await executeTool('database.describe', { databaseId }).catch(() => null);
    if (describeResult && !describeResult.isError && getDatabaseSourceCount(describeResult.structuredContent) > 0) {
      return createSnapshot();
    }
  }

  return {
    isError: false,
    databaseId,
    snapshot,
    snapshotToolResult,
    createdSnapshot,
    toolUsed: createdSnapshot ? 'database.create_snapshot' : 'database.list_snapshots'
  };
};

const extractSnapshotFilters = (query, fields, targetField) => {
  const normalized = normalizeLabel(query);
  const filters = [];
  const dateValue = extractDateValueFromQuery(query);

  if (dateValue) {
    const dateField = findFieldByLabel(fields, 'date') ||
      fields.find((field) => normalizeLabel(field).includes('date'));
    if (dateField && dateField !== targetField) {
      filters.push({ field: dateField, value: dateValue, operator: 'dateEquals' });
    }
  }

  filters.push(...extractComparisonFiltersFromFields(query, fields, [
    targetField,
    ...filters.map((filter) => filter.field)
  ]));

  for (const field of fields) {
    if (field === targetField || filters.some((filter) => filter.field === field)) continue;
    const label = normalizeLabel(field);
    const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
    if (!match) continue;

    let fragment = normalized.slice(match.index + match[0].length).trim();
    fragment = fragment.replace(/^(is|equals|equal to|equal|with|for|of|on|where|as|to|in|the)\s+/, '').trim();
    if (!fragment) continue;

    const stopMatch = fragment.match(/\s+(?:and|where|with|in|on|for|to|as|into)\s+/);
    if (stopMatch) fragment = fragment.slice(0, stopMatch.index).trim();

    const value = fragment.split(/\s+/).slice(0, 4).join(' ');
    if (value) filters.push({ field, value, operator: 'equals' });
  }

  return filters;
};

const objectFromFilters = (filters = []) => filters.reduce((acc, filter) => {
  acc[filter.field] = filter.value;
  return acc;
}, {});

const detectDocumentMutationIntent = (query, context = {}) => {
  const normalized = normalizeForIntent(query);
  const selectedDocumentId = context.documentId;
  const scope = context.scope || 'auto';

  if (!/\b(update|change|set|replace|edit|correct|modify)\b/.test(normalized)) return null;

  if (scope === 'database') {
    return null;
  }

  if (!selectedDocumentId) {
    return {
      error: 'Select the document you want to edit first, then ask me the change again.'
    };
  }

  const column = findMutationColumn(query);
  const value = extractMutationValue(query);
  const date = extractDateValueFromQuery(query);
  const rowIndex = extractRowIndex(query);

  if (!column || value === null || value === '') {
    return {
      error: 'Tell me the column and new value clearly, for example: change product on date 02-03-2023 to Snacks.'
    };
  }

  let actualColumn = column;
  let documentColumns = [];
  try {
    const documentSummary = describeDocument(selectedDocumentId);
    documentColumns = documentSummary.sheets?.[0]?.columns || [];
    actualColumn = findFieldByLabel(documentColumns, column) || column;
  } catch {
    documentColumns = [];
  }

  const parameters = {
    documentId: selectedDocumentId,
    column: actualColumn,
    value
  };

  const filters = [];
  if (date) {
    filters.push({ column: 'Sale Date', value: date, operator: 'dateEquals' });
  }

  if (documentColumns.length > 0) {
    filters.push(...extractComparisonFiltersFromFields(query, documentColumns, [actualColumn])
      .map((filter) => ({
        column: filter.field,
        value: filter.value,
        operator: filter.operator
      })));
  }

  if (filters.length > 0) {
    parameters.filters = filters;
  }

  if (Number.isInteger(rowIndex)) {
    parameters.rowIndex = rowIndex;
  }

  if (!parameters.filters && !Number.isInteger(parameters.rowIndex)) {
    return {
      error: 'I need a safe target for the edit. Include a date, condition, or zero-based row index, for example: change product to Snacks where quantity greater than 10.'
    };
  }

  return {
    previewTool: 'document.preview_update_cell',
    applyTool: 'document.update_cell',
    previewParameters: { ...parameters, limit: 10 },
    applyParameters: parameters
  };
};

const isOllamaMemoryError = (error) => {
  const detail = error.response ? JSON.stringify(error.response.data) : error.message;
  return /requires more system memory|not enough memory|out of memory/i.test(detail);
};

const postToOllama = async (payload, axiosConfig = {}) => {
  const { options: payloadOptions = {}, ...requestPayload } = payload;
  try {
    return await axios.post(OLLAMA_API_URL, {
      ...requestPayload,
      model: MODEL,
      options: { ...ollamaOptions, ...payloadOptions }
    }, axiosConfig);
  } catch (error) {
    if (!FALLBACK_MODEL || FALLBACK_MODEL === MODEL || !isOllamaMemoryError(error)) {
      throw error;
    }

    console.warn(`Ollama model ${MODEL} did not fit in memory. Retrying with ${FALLBACK_MODEL}.`);
    return await axios.post(OLLAMA_API_URL, {
      ...requestPayload,
      model: FALLBACK_MODEL,
      options: { ...ollamaOptions, ...payloadOptions }
    }, axiosConfig);
  }
};

const parseLooseJsonObject = (text = '') => {
  const clean = String(text || '').trim();
  if (!clean) return null;

  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end <= start) return null;

    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch {
      return null;
    }
  }
};

const cleanEnhancedPrompt = (value = '') => String(value || '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^["']|["']$/g, '')
  .trim()
  .slice(0, PROMPT_ENHANCER_MAX_LENGTH)
  .trim();

const firstNonEmptyString = (...values) => values
  .find((value) => typeof value === 'string' && value.trim().length > 0);

const isSafeEnhancedPrompt = (enhanced = '') => {
  const text = String(enhanced || '').trim();
  if (!text || /^(true|false|null|undefined)$/i.test(text)) return false;
  if (/\bselect\b[\s\S]+\bfrom\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b/i.test(text)) return false;
  if (/\bdb\.\w+\s*\(|\$\w+/.test(text)) return false;
  if (/[{};]/.test(text)) return false;
  return true;
};

const SAFE_ADDED_PROMPT_TERMS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'me', 'my', 'of', 'on', 'or', 'the', 'this', 'to', 'with',
  'what', 'which', 'who', 'when', 'where', 'how',
  'ask', 'count', 'data', 'detail', 'equal', 'each', 'field', 'filter', 'find',
  'get', 'give', 'greater', 'has', 'have', 'highest', 'least', 'less', 'list', 'lowest',
  'many', 'matching', 'more', 'number', 'per', 'provide', 'record', 'row',
  'result', 'search', 'selected', 'show', 'sum', 'table', 'than', 'top', 'total', 'value'
]);

const stemPromptToken = (token = '') => {
  const singular = singularizeToken(token.toLowerCase());
  if (singular.endsWith('ed') && singular.length > 4) return singular.slice(0, -1);
  if (singular.endsWith('ing') && singular.length > 5) return singular.slice(0, -3);
  return singular;
};

const safetyPromptTokens = (text = '') => Array.from(new Set(labelTokens(text)
  .map(stemPromptToken)
  .filter((token) => token.length > 1)));

const enhancedAddsOnlySafeTerms = (before = {}, after = {}) => {
  const beforeTokens = new Set(safetyPromptTokens(`${before.original || ''} ${before.optimized || ''}`));
  const addedTerms = safetyPromptTokens(after.optimized || '')
    .filter((token) => !beforeTokens.has(token) && !SAFE_ADDED_PROMPT_TERMS.has(token));

  return addedTerms.length === 0;
};

const promptConstraintsPreserved = (before = {}, after = {}) => {
  const beforeKeywords = before.keywords || {};
  const afterKeywords = after.keywords || {};
  const afterOptimized = normalizeForIntent(after.optimized || '');

  if (!enhancedAddsOnlySafeTerms(before, after)) return false;

  const dates = beforeKeywords.dates || [];
  if (dates.some((date) => !afterOptimized.includes(normalizeForIntent(date)))) {
    return false;
  }

  const comparisons = beforeKeywords.comparisons || [];
  if (comparisons.length === 0) return true;

  const afterComparisons = afterKeywords.comparisons || [];
  if (afterComparisons.length < comparisons.length) return false;

  return comparisons.every((beforeComparison) => afterComparisons.some((afterComparison) => (
    compactLabel(afterComparison.field) === compactLabel(beforeComparison.field) &&
    afterComparison.operator === beforeComparison.operator &&
    normalizeForIntent(afterComparison.value) === normalizeForIntent(beforeComparison.value)
  )));
};

const promptEnhancerRequested = (context = {}) => (
  context.enhancePrompt === true ||
  context.aiPromptEnhancer === true ||
  context.promptEnhancer === true ||
  LLM_PROMPT_ENHANCER_ENABLED
);

const shouldEnhancePromptWithLlm = (query, context = {}, promptRewrite = {}) => {
  const text = String(query || '').trim();
  if (!promptEnhancerRequested(context)) return false;
  if (!text || isConfirmMessage(text) || isCancelMessage(text)) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay)$/i.test(text)) return false;
  if (
    (context.useLlmMongoPlanner === true || LLM_MONGO_PLANNER_ENABLED) &&
    (context.scope === 'database' || (context.databaseId && context.scope !== 'document'))
  ) {
    return false;
  }

  // Keep edit values deterministic. A model rewrite could turn "process" into
  // "processing" or normalize an ID, which is unsafe for mutation previews.
  if (promptRewrite.keywords?.action === 'mutation') return false;

  return true;
};

const enhancePromptWithLlm = async (query, context = {}, promptRewrite = {}) => {
  if (!shouldEnhancePromptWithLlm(query, context, promptRewrite)) return promptRewrite;

  const source = context.scope && context.scope !== 'auto' ? context.scope : promptRewrite.keywords?.source || 'auto';
  const selected = [
    context.databaseId ? `databaseId=${context.databaseId}` : null,
    context.documentId ? `documentId=${context.documentId}` : null
  ].filter(Boolean).join(', ') || 'none';

  const system = [
    'You rewrite user questions into precise MCP database/document questions.',
    'Return only JSON with keys: enhanced, keywords, reason.',
    'Do not answer the question.',
    'The enhanced value must be a plain natural-language question, not SQL, MongoDB syntax, JSON, code, or a boolean.',
    'Do not invent collection names, table names, fields, filters, or values that are not present in the prompt.',
    'Preserve exact names, IDs, dates, numbers, quoted text, and filter values.',
    'If the deterministic rewrite contains a condition like field equals value, keep the same field/operator/value wording.',
    'Keep the enhanced prompt short and directly executable by a database/document tool planner.'
  ].join(' ');

  const prompt = `Original user prompt: ${query}
Fast deterministic rewrite: ${promptRewrite.optimized || query}
Selected source type: ${source}
Selected source id: ${selected}
Detected action: ${promptRewrite.keywords?.action || 'query'}
Detected dates: ${(promptRewrite.keywords?.dates || []).join(', ') || 'none'}
Detected conditions: ${(promptRewrite.keywords?.comparisons || []).map((item) => `${item.field} ${item.operator} ${item.value}`).join(', ') || 'none'}
  Detected keywords: ${(promptRewrite.keywords?.terms || []).join(', ') || 'none'}

Rewrite this as one clear database/document query. Prefer exact-match wording for names and IDs, explicit filters, and concise output intent.`;

  const controller = new AbortController();
  try {
    const response = await withTimeout(
      postToOllama({
        prompt,
        system,
        stream: false,
        format: 'json'
      }, { signal: controller.signal }),
      PROMPT_ENHANCER_TIMEOUT_MS,
      'AI prompt enhancer'
    );

    const parsed = parseLooseJsonObject(response.data?.response);
    const rawEnhanced = firstNonEmptyString(parsed?.enhanced, parsed?.prompt, parsed?.rewritten);
    const enhanced = cleanEnhancedPrompt(rawEnhanced || '');
    if (!enhanced) {
      return {
        ...promptRewrite,
        enhancerError: 'AI prompt enhancer returned no usable rewrite.'
      };
    }

    if (!isSafeEnhancedPrompt(enhanced)) {
      return {
        ...promptRewrite,
        enhancerError: 'AI prompt enhancer returned an unsafe rewrite, so the fast rewrite was used.'
      };
    }

    const enhancedRewrite = optimizePrompt(enhanced, context);
    const notes = Array.from(new Set([
      ...(promptRewrite.notes || []),
      'AI enhanced prompt',
      ...(enhancedRewrite.notes || [])
    ]));
    const keywords = enhancedRewrite.keywords || promptRewrite.keywords;
    const optimized = enhancedRewrite.optimized || enhanced;

    if (!promptConstraintsPreserved(promptRewrite, enhancedRewrite)) {
      return {
        ...promptRewrite,
        enhancerError: 'AI prompt enhancer changed detected constraints or added unsupported terms, so the fast rewrite was used.'
      };
    }

    return {
      ...enhancedRewrite,
      original: promptRewrite.original,
      optimized,
      changed: optimized !== promptRewrite.original,
      deterministicOptimized: promptRewrite.optimized,
      llmEnhanced: true,
      llmModel: MODEL,
      enhanced,
      enhancerReason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
      enhancerKeywords: Array.isArray(parsed?.keywords) ? parsed.keywords.slice(0, 12) : undefined,
      notes,
      keywords
    };
  } catch (error) {
    controller.abort();
    const detail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.warn('AI prompt enhancer unavailable:', detail);
    return {
      ...promptRewrite,
      enhancerError: detail
    };
  }
};

const preparePromptForQuery = async (query, context = {}) => {
  const deterministicRewrite = optimizePrompt(query, context);
  return enhancePromptWithLlm(query, context, deterministicRewrite);
};

const shouldExposePromptRewrite = (promptRewrite = {}) => (
  Boolean(promptRewrite.changed || promptRewrite.llmEnhanced || promptRewrite.enhancerError)
);

const directToolIntent = (query, context = {}) => {
  const normalized = query.trim().toLowerCase();
  const defaultDatabaseId = context.databaseId || process.env.MCP_DEFAULT_DATABASE_ID || 'default';
  const selectedDocumentId = context.documentId;
  const scope = context.scope || 'auto';
  let selectedDocumentKind = null;

  if (selectedDocumentId) {
    try {
      selectedDocumentKind = describeDocument(selectedDocumentId).kind;
    } catch {
      selectedDocumentKind = null;
    }
  }

  if (/what databases|which databases|list databases|database connections|what can you access/.test(normalized)) {
    return { tool: 'database.list_connections', parameters: {} };
  }

  if (scope !== 'document' && /\b(list|show).*(database )?(snapshots|working copies|copies)\b/.test(normalized)) {
    return { tool: 'database.list_snapshots', parameters: context.databaseId ? { databaseId: defaultDatabaseId } : {} };
  }

  if (scope !== 'document' && /\b(create|make|generate).*(database )?(snapshot|working copy|copy|backup)\b/.test(normalized)) {
    return { tool: 'database.create_snapshot', parameters: { databaseId: defaultDatabaseId } };
  }

  if (scope !== 'document' && /describe.*schema|schema|collections|tables|fields/.test(normalized)) {
    return { tool: 'database.describe', parameters: { databaseId: defaultDatabaseId } };
  }

  if (scope !== 'document' && /how many.*(rows|documents|records)|count.*(rows|documents|records)|total.*(rows|documents|records)/.test(normalized)) {
    return { tool: 'database.count_rows', parameters: { databaseId: defaultDatabaseId } };
  }

  if (scope !== 'database' && /what documents|list documents|uploaded documents|document sources|files uploaded/.test(normalized)) {
    return { tool: 'document.list_sources', parameters: {} };
  }

  if (scope !== 'database' && selectedDocumentId && /describe|metadata|columns|sheets|chunks|pages/.test(normalized)) {
    return { tool: 'document.describe', parameters: { documentId: selectedDocumentId } };
  }

  const hasConditionalPhrase = /\b(where|if|greater than|less than|more than|between|above|below|over|under|at least|at most|minimum|maximum)\b|[<>]=?|=/.test(normalized);

  if (scope !== 'database' && selectedDocumentId && selectedDocumentKind === 'table' && !hasConditionalPhrase && /show.*rows|list.*rows|table|sheet|excel|csv/.test(normalized)) {
    return { tool: 'document.query_table', parameters: { documentId: selectedDocumentId, limit: 20 } };
  }

  if (scope !== 'database' && selectedDocumentId && selectedDocumentKind === 'table' && /(what|which|who|when|where|show|list|find|get|how many|name|product|date|amount|price|quantity|row)/.test(normalized)) {
    return {
      tool: 'document.answer_table_question',
      parameters: {
        documentId: selectedDocumentId,
        question: query,
        limit: TABLE_ANSWER_LIMIT
      }
    };
  }

  const searchMatch = normalized.match(/(?:search|find).*(?:document|file|pdf|word|excel|sheet).*?(?:for|about)\s+(.+)/);
  if (scope !== 'database' && searchMatch?.[1]) {
    return {
      tool: 'document.search',
      parameters: {
        query: searchMatch[1],
        documentId: selectedDocumentId,
        limit: 5
      }
    };
  }

  if (scope !== 'database' && selectedDocumentId && selectedDocumentKind !== 'table' && /(what|which|who|when|where|why|how|summarize|explain|tell|give|find|list|name|skills|experience|profile|project)/.test(normalized)) {
    return {
      tool: 'document.answer_text_question',
      parameters: {
        question: query,
        documentId: selectedDocumentId,
        limit: 5
      }
    };
  }

  if (scope === 'document' && selectedDocumentId) {
    if (selectedDocumentKind === 'table') {
      return {
        tool: 'document.answer_table_question',
        parameters: {
          question: query,
          documentId: selectedDocumentId,
          limit: TABLE_ANSWER_LIMIT
        }
      };
    }

    return {
      tool: 'document.answer_text_question',
      parameters: {
        question: query,
        documentId: selectedDocumentId,
        limit: 5
      }
    };
  }

  return null;
};

const analyzeSnapshotMutation = (query, snapshot, requestedFieldPhrase) => {
  const sources = snapshot?.sources || [];
  const allFields = Array.from(new Set(sources.flatMap(fieldsForSnapshotSource)));
  const targetField = findFieldByLabel(allFields, requestedFieldPhrase);
  const candidateSources = targetField
    ? sources
      .map((source, index) => {
        const fields = fieldsForSnapshotSource(source);
        const actualTargetField = findFieldByLabel(fields, targetField);
        const filters = extractSnapshotFilters(query, fields, actualTargetField);
        const matchedFilters = filters.filter((filter) => findFieldByLabel(fields, filter.field)).length;
        return {
          source,
          fields,
          actualTargetField,
          filters,
          score: (actualTargetField ? 5 : 0) + matchedFilters * 3 + (sourceMentionScore(query, source) || 0) + Math.min(source.rowCount || source.rowCountEstimate || 0, 1000) / 1000,
          index
        };
      })
      .filter((item) => item.actualTargetField)
      .sort((a, b) => b.score - a.score || a.index - b.index)
    : [];

  return {
    sources,
    allFields,
    targetField,
    candidateSources
  };
};

const findFallbackDatabaseSnapshotForMutation = async (query, currentDatabaseId, requestedFieldPhrase) => {
  const connectionsResult = await executeTool('database.list_connections', {});
  const connections = Array.isArray(connectionsResult.structuredContent)
    ? connectionsResult.structuredContent
    : [];

  for (const connection of connections) {
    if (!connection.id || connection.id === currentDatabaseId) continue;

    try {
      const snapshotInfo = await getLatestOrCreateDatabaseSnapshot(connection.id, { refreshEmpty: true });
      if (snapshotInfo.isError) continue;

      const analysis = analyzeSnapshotMutation(query, snapshotInfo.snapshot, requestedFieldPhrase);
      if (analysis.sources.length > 0 && analysis.targetField && analysis.candidateSources.length > 0) {
        return {
          ...snapshotInfo,
          analysis
        };
      }
    } catch (error) {
      // Ignore fallback databases that cannot be inspected or snapshotted.
    }
  }

  return null;
};

const prepareDatabaseMutation = async (query, context = {}) => {
  const normalized = normalizeForIntent(query);
  const scope = context.scope || 'auto';
  if (scope === 'document') return null;
  if (scope !== 'database' && context.documentId) return null;
  if (!/\b(update|change|set|replace|edit|correct|modify)\b/.test(normalized)) return null;

  const selectedDatabaseId = context.databaseId || process.env.MCP_DEFAULT_DATABASE_ID || 'default';
  let activeDatabaseId = selectedDatabaseId;
  const requestedFieldPhrase = extractMutationFieldPhrase(query);
  const value = extractMutationValue(query);
  const rowIndex = extractRowIndex(query);
  let fallbackFromDatabaseId = null;

  if (!requestedFieldPhrase || value === null || value === '') {
    return {
      response: 'Tell me the database field and new value clearly, for example: change status to process on date 2023-01-07.'
    };
  }

  const allowFallback = shouldUseDatabaseFallback(context);
  let snapshotInfo = await getLatestOrCreateDatabaseSnapshot(activeDatabaseId, { refreshEmpty: true });
  if (snapshotInfo.isError) {
    return {
      response: `I could not create a safe database working copy for "${activeDatabaseId}": ${snapshotInfo.error}`,
      toolUsed: snapshotInfo.toolUsed,
      toolResult: snapshotInfo.toolResult
    };
  }

  let snapshot = snapshotInfo.snapshot;
  let snapshotToolResult = snapshotInfo.snapshotToolResult;
  let createdSnapshot = snapshotInfo.createdSnapshot;
  let analysis = analyzeSnapshotMutation(query, snapshot, requestedFieldPhrase);
  let { sources, allFields, targetField, candidateSources } = analysis;

  if (sources.length === 0) {
    const fallback = allowFallback
      ? await findFallbackDatabaseSnapshotForMutation(query, activeDatabaseId, requestedFieldPhrase)
      : null;
    if (fallback) {
      fallbackFromDatabaseId = activeDatabaseId;
      activeDatabaseId = fallback.databaseId;
      snapshot = fallback.snapshot;
      snapshotToolResult = fallback.snapshotToolResult;
      createdSnapshot = fallback.createdSnapshot;
      analysis = fallback.analysis;
      ({ sources, allFields, targetField, candidateSources } = analysis);
    } else {
      return {
        response: `The selected database "${activeDatabaseId}" has no collections or tables in its working copy, and I could not find another configured database with matching editable data.`,
        toolUsed: createdSnapshot ? 'database.create_snapshot' : 'database.list_snapshots',
        toolResult: snapshotToolResult
      };
    }
  }

  if (!targetField && !fallbackFromDatabaseId) {
    const fallback = allowFallback
      ? await findFallbackDatabaseSnapshotForMutation(query, activeDatabaseId, requestedFieldPhrase)
      : null;
    if (fallback) {
      fallbackFromDatabaseId = activeDatabaseId;
      activeDatabaseId = fallback.databaseId;
      snapshot = fallback.snapshot;
      snapshotToolResult = fallback.snapshotToolResult;
      createdSnapshot = fallback.createdSnapshot;
      analysis = fallback.analysis;
      ({ sources, allFields, targetField, candidateSources } = analysis);
    }
  }

  if (sources.length === 0) {
    return {
      response: `The selected database "${activeDatabaseId}" has no collections or tables in its working copy, so there is nothing I can edit yet.`,
      toolUsed: createdSnapshot ? 'database.create_snapshot' : 'database.list_snapshots',
      toolResult: snapshotToolResult
    };
  }

  if (!targetField) {
    return {
      response: `I could not find a field matching "${requestedFieldPhrase}" in the database working copy. Available fields include: ${allFields.slice(0, 30).join(', ')}.`,
      toolUsed: createdSnapshot ? 'database.create_snapshot' : 'database.list_snapshots',
      toolResult: snapshotToolResult
    };
  }

  if (candidateSources.length === 0) {
    return {
      response: `I found "${targetField}" in the snapshot metadata, but I could not find a source that can be edited with that field.`,
      toolUsed: 'database.list_snapshots',
      toolResult: snapshotToolResult
    };
  }

  const selected = candidateSources[0];
  const filters = selected.filters;

  if (!Number.isInteger(rowIndex) && filters.length === 0) {
    return {
      response: 'I need a safe target for the database edit. Include a date, id, or row index, for example: change status to process where order_id 256184.'
    };
  }

  const previewParameters = {
    snapshotId: snapshot.id,
    source: selected.source.name,
    field: selected.actualTargetField,
    value,
    limit: 10
  };

  if (Number.isInteger(rowIndex)) {
    previewParameters.rowIndex = rowIndex;
  } else {
    previewParameters.filters = filters;
  }

  const previewResult = await executeTool('database.preview_snapshot_update', previewParameters);
  const applyParameters = { ...previewParameters };
  delete applyParameters.limit;

  return {
    previewTool: 'database.preview_snapshot_update',
    applyTool: 'database.update_snapshot_rows',
    previewParameters,
    applyParameters,
    previewResult,
    createdSnapshot,
    fallbackFromDatabaseId,
    activeDatabaseId
  };
};

const getDatabaseSourceCount = (schema = {}) => {
  const sources = getDatabaseSourcesFromSchema(schema);
  return sources.length;
};

const questionMatchesSchema = (query, schema = {}) => {
  const question = extractDatabaseQuestion(query, schema);
  const requestedFields = question.requestedFields?.length
    ? question.requestedFields
    : [question.requestedField].filter(Boolean);
  if (question.sources.length === 0) return false;
  if (requestedFields.length === 0) return true;
  return selectDatabaseSources(query, question.sources, requestedFields, question.filters).length > 0;
};

const findFallbackDatabaseForQuestion = async (query, currentDatabaseId) => {
  const connectionsResult = await executeTool('database.list_connections', {});
  const connections = Array.isArray(connectionsResult.structuredContent)
    ? connectionsResult.structuredContent
    : [];

  const candidates = [];
  for (const connection of connections) {
    if (!connection.id || connection.id === currentDatabaseId) continue;

    try {
      const describeResult = await withTimeout(
        executeTool('database.describe', { databaseId: connection.id }),
        DB_AGENT_TIMEOUT_MS,
        `Inspecting fallback database ${connection.id}`
      );

      if (describeResult.isError) continue;
      const schema = describeResult.structuredContent;
      const sourceCount = getDatabaseSourceCount(schema);
      if (sourceCount === 0) continue;

      candidates.push({
        databaseId: connection.id,
        schema,
        sourceCount,
        matchesQuestion: questionMatchesSchema(query, schema)
      });
    } catch (error) {
      // Ignore unavailable fallback connections; the selected connection response will explain the issue.
    }
  }

  return candidates.find((candidate) => candidate.matchesQuestion) || candidates[0] || null;
};

const shouldUseDatabaseFallback = (context = {}) => (
  context.allowDatabaseFallback === true &&
  !context.databaseId &&
  (context.scope || 'auto') !== 'database'
);

const extractLimitFromQuery = (query, fallback = 20) => {
  const match = normalizeLabel(query).match(/\b(?:top|first|limit)\s+(\d{1,3})\b/);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, TABLE_ANSWER_LIMIT);
};

const extractPhraseAfterGroupingKeyword = (normalized = '') => {
  const match = normalized.match(/\b(?:group\s+by|by|per|for each|each)\s+(?:the\s+)?(.+?)(?=\s+(?:where|with|on|in|from|ordered|sorted|sort|top|limit)\b|$)/);
  return match?.[1]?.trim() || '';
};

const findGroupingFieldByPhrase = (fields = [], phrase = '') => {
  const normalizedPhrase = normalizeLabel(phrase);
  const tokens = labelTokens(normalizedPhrase);
  if (tokens.some((token) => ['bowler', 'batter', 'batsman', 'keeper'].includes(token)) || normalizedPhrase.includes('all rounder')) {
    const playerNameField = fields.find((field) => {
      const fieldTokens = labelTokens(field);
      return fieldTokens.includes('player') && fieldTokens.includes('name');
    });
    if (playerNameField) return playerNameField;
  }

  const primary = tokens[0];
  if (primary) {
    const nameField = fields.find((field) => {
      const fieldTokens = labelTokens(field);
      return fieldTokens.includes(primary) && fieldTokens.includes('name');
    });
    if (nameField) return nameField;
  }

  return findFieldByLabel(fields, phrase);
};

const roleFilterFromGroupingPhrase = (phrase = '') => {
  const normalized = normalizeLabel(phrase);
  if (/\b(bowler|bowlers)\b/.test(normalized)) return 'bowler';
  if (/\b(batter|batters|batsman|batsmen)\b/.test(normalized)) return 'batter';
  if (/\b(wicket keeper|wicket keepers|keeper|keepers)\b/.test(normalized)) return 'wicket_keeper';
  if (/\b(all rounder|all rounders|allrounder|allrounders)\b/.test(normalized)) return 'all_rounder';
  return null;
};

const inferGroupingPhrase = (normalized = '') => {
  const topMatch = normalized.match(/\btop\s+\d{0,3}\s*(.+?)\s+by\s+(.+?)(?=\s+(?:where|with|on|in|from)\b|$)/);
  if (topMatch?.[1]) return topMatch[1];

  const highestMatch = normalized.match(/\b(?:which|what)\s+(.+?)\s+(?:has|have|scored|made|took|hit|won)\s+(?:the\s+)?(?:highest|most|best|lowest|least)\b/);
  if (highestMatch?.[1]) return highestMatch[1];

  const byPhrase = extractPhraseAfterGroupingKeyword(normalized);
  if (byPhrase) return byPhrase;

  if (/\bwho\b|\bplayer|players|batter|batters|batsman|batsmen|bowler|bowlers|keeper|keepers|all rounder|all rounders\b/.test(normalized)) {
    return 'player';
  }
  if (/\bteam|teams\b/.test(normalized)) return 'team';
  if (/\bcustomer|customers\b/.test(normalized)) return 'customer';
  if (/\bvenue|venues|ground|grounds|stadium|stadiums\b/.test(normalized)) return 'venue';
  if (/\bcity|cities\b/.test(normalized)) return 'city';
  if (/\bcountry|countries\b/.test(normalized)) return 'country';
  if (/\brole|roles\b/.test(normalized)) return 'role';
  if (/\bformat|formats\b/.test(normalized)) return 'format';
  if (/\bwinner|won|wins|win\b/.test(normalized)) return 'winner';

  return '';
};

const extractAggregationMetricPhrase = (normalized = '') => {
  const top = normalized.match(/\btop\s+\d{0,3}\s*.+?\s+by\s+(.+?)(?=\s+(?:where|with|on|in|from)\b|$)/);
  if (top?.[1]) return top[1].trim();

  const ranking = normalized.match(/\b(?:highest|most|best|lowest|least)\s+(.+?)(?=\s+(?:by|per|for each|each|where|with|on|in|from)\b|$)/);
  if (ranking?.[1]) return ranking[1].trim();

  const actorRanking = normalized.match(/\b(?:has|have|scored|made|took|hit|won)\s+(?:the\s+)?(?:highest|most|best|lowest|least)\s+(.+?)(?=\s+(?:by|per|for each|each|where|with|on|in|from)\b|$)/);
  if (actorRanking?.[1]) return actorRanking[1].trim();

  const explicit = normalized.match(/\b(?:sum|total|average|avg|mean|minimum|min|maximum|max)\s+(?:of\s+)?(?:the\s+)?(.+?)(?=\s+(?:by|per|for each|each|where|with|on|in|from)\b|$)/);
  if (explicit?.[1]) return explicit[1].trim();

  return '';
};

const findLikelyMetricField = (fields = [], query = '', operation = 'sum') => {
  const normalized = normalizeLabel(query);
  const explicitPhrase = extractAggregationMetricPhrase(normalized);
  const explicitField = fieldMatchQuality(fields, explicitPhrase).field;
  if (explicitField) return explicitField;

  const aliases = operation === 'avg'
    ? ['strike rate', 'run rate', 'economy rate', 'average', 'quantity', 'amount', 'price', 'total', 'sales', 'revenue']
    : ['runs', 'total runs', 'wickets', 'sixes', 'fours', 'catches', 'matches', 'wins', 'total amount', 'sales amount', 'amount', 'total', 'sales', 'revenue', 'quantity', 'price'];

  for (const alias of aliases) {
    if (!normalized.includes(alias)) continue;
    const field = fieldMatchQuality(fields, alias).field;
    if (field) return field;
  }

  return fields.find((field) => /\b(amount|total|sales|revenue|price|quantity|qty|cost|value|runs|wickets|sixes|fours|catches|rate|average)\b/i.test(normalizeLabel(field))) || null;
};

const metricLooksLikeRate = (metric = '') => /\b(rate|average|avg|economy|strike|run rate|margin|age)\b/.test(normalizeLabel(metric));

const inferAggregationOperation = (normalized = '', metricPhrase = '') => {
  if (/\b(average|avg|mean)\b/.test(normalized)) return 'avg';
  if (/\b(minimum|min)\b/.test(normalized)) return 'min';
  if (/\b(maximum|max)\b/.test(normalized)) return 'max';
  if (/\b(best|highest|lowest|least)\b/.test(normalized) && metricLooksLikeRate(metricPhrase)) {
    return /\b(lowest|least)\b/.test(normalized) ? 'min' : 'max';
  }
  if (/\b(count|how many|number of)\b/.test(normalized)) return 'count';
  if (/\b(won|wins|winner|winners)\b/.test(normalized) && /\b(most|highest|top|by)\b/.test(normalized)) return 'count';
  if (/\b(total|sum|sales|revenue|top|highest|most|best|lowest|least)\b/.test(normalized)) return 'sum';
  return 'count';
};

const detectMongoAggregationIntent = (query, schema, question) => {
  if (schema.type !== 'mongodb') return null;

  const normalized = normalizeLabel(query);
  const hasAggregateLanguage = /\b(aggregate|group|group by|per|each|for each|total|sum|sales|revenue|average|avg|mean|minimum|min|maximum|max|top|highest|lowest|best|most|least|count|how many|number of|won|winner|winners|scored|took|hit)\b/.test(normalized);
  const hasGroupingLanguage = /\b(group by|by|per|each|for each|top|highest|lowest|best|most|least|who|which)\b/.test(normalized);
  const hasMetricLanguage = /\b(total|sum|average|avg|mean|minimum|min|maximum|max|highest|lowest|best|most|least|won|scored|took|hit)\b/.test(normalized);

  if (!hasAggregateLanguage || (!hasGroupingLanguage && !hasMetricLanguage)) return null;

  const sources = getDatabaseSourcesFromSchema(schema);
  const allFields = Array.from(new Set(sources.flatMap((source) => source.fields || [])));
  const groupPhrase = inferGroupingPhrase(normalized);
  const metricPhrase = extractAggregationMetricPhrase(normalized);
  const operation = inferAggregationOperation(normalized, metricPhrase);
  const roleFilterValue = roleFilterFromGroupingPhrase(groupPhrase);
  let groupField = findGroupingFieldByPhrase(allFields, groupPhrase);

  if (/\b(won|wins|winner|winners)\b/.test(normalized)) {
    groupField = findFieldByLabel(allFields, 'winner') || groupField;
  }

  const metricField = operation === 'count'
    ? null
    : (
        fieldMatchQuality(allFields, metricPhrase).field ||
        findLikelyMetricField(allFields, query, operation)
      );

  if (!groupField) return null;
  if (operation !== 'count' && !metricField) return null;

  const filters = (question.filters || []).filter((filter) => (
    ![groupField, metricField].some((field) => field && findFieldByLabel([field], filter.field))
  ));
  const roleField = roleFilterValue ? findFieldByLabel(allFields, 'role') : null;
  if (roleField && !filters.some((filter) => findFieldByLabel([roleField], filter.field))) {
    filters.push({ field: roleField, value: roleFilterValue, type: 'value', operator: 'equals' });
  }

  return {
    operation,
    groupField,
    metricField,
    filters,
    limit: extractLimitFromQuery(query, /\b(highest|lowest|most|least|best)\b/.test(normalized) ? 1 : 20),
    sortDirection: /\b(lowest|least|minimum|min|asc|ascending)\b/.test(normalized) ? 1 : -1
  };
};

const selectAggregationSource = (query, sources = [], intent = {}) => {
  return sources
    .map((source, index) => {
      const fields = source.fields || [];
      const groupMatch = intent.groupField
        ? fieldMatchQuality(fields, intent.groupField)
        : { field: null, score: 100 };
      const metricMatch = intent.metricField
        ? fieldMatchQuality(fields, intent.metricField)
        : { field: null, score: 100 };
      const hasGroup = !intent.groupField || Boolean(groupMatch.field);
      const hasMetric = !intent.metricField || Boolean(metricMatch.field);
      const matchedFilters = intent.filters.filter((filter) => findFieldByLabel(fields, filter.field)).length;
      const score = sourceMentionScore(query, source) +
        (hasGroup ? groupMatch.score / 8 : 0) +
        (hasMetric ? metricMatch.score / 4 : 0) +
        (intent.metricField && metricMatch.score >= 95 ? 10 : 0) +
        (intent.metricField && metricMatch.score > 0 && metricMatch.score < 80 ? -4 : 0) +
        matchedFilters * 3 +
        Math.min(source.rowCountEstimate || 0, 1000) / 1000;
      return { source, index, score, hasGroup, hasMetric };
    })
    .filter((item) => item.hasGroup && item.hasMetric && item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.source)[0] || null;
};

const numericAggregationExpression = (field, fallbackValue = 0) => ({
  $convert: {
    input: `$${field}`,
    to: 'double',
    onError: fallbackValue,
    onNull: fallbackValue
  }
});

const buildMongoAggregationPipeline = (intent = {}, filters = []) => {
  const metricNames = {
    count: 'count',
    sum: 'total',
    avg: 'average',
    min: 'minimum',
    max: 'maximum'
  };
  const metricName = metricNames[intent.operation] || 'count';
  const pipeline = [];
  const match = buildMongoFilter(filters);

  if (Object.keys(match).length > 0) {
    pipeline.push({ $match: match });
  }

  const group = {
    _id: intent.groupField ? `$${intent.groupField}` : null,
    count: { $sum: 1 }
  };

  if (intent.operation === 'sum') {
    group[metricName] = { $sum: numericAggregationExpression(intent.metricField, 0) };
  } else if (intent.operation === 'avg') {
    group[metricName] = { $avg: numericAggregationExpression(intent.metricField, null) };
  } else if (intent.operation === 'min') {
    group[metricName] = { $min: numericAggregationExpression(intent.metricField, null) };
  } else if (intent.operation === 'max') {
    group[metricName] = { $max: numericAggregationExpression(intent.metricField, null) };
  }

  pipeline.push({ $group: group });

  const project = { _id: 0 };
  if (intent.groupField) project[intent.groupField] = '$_id';
  project[metricName] = 1;
  if (intent.operation !== 'count') project.count = 1;

  pipeline.push({ $project: project });
  pipeline.push({ $sort: { [metricName]: intent.sortDirection || -1 } });

  return { pipeline, metricName };
};

const formatDisplayValue = (value) => {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const humanizeFieldName = (field = '') => normalizeLabel(field).replace(/\s+/g, ' ').trim() || String(field || 'value');

const aggregationMetricLabel = (intent = {}) => {
  const metricLabel = humanizeFieldName(intent.metricField);
  if (intent.operation === 'count') return 'count';
  if (intent.operation === 'sum') return metricLabel.startsWith('total ') ? metricLabel : `total ${metricLabel}`;
  if (intent.operation === 'avg') return `average ${metricLabel}`;
  if (intent.operation === 'max') return `highest ${metricLabel}`;
  if (intent.operation === 'min') return `lowest ${metricLabel}`;
  return metricLabel || 'value';
};

const aggregationRowLabel = (row = {}, intent = {}, metricName = 'count', metricLabel = metricName) => {
  const groupValue = intent.groupField ? row[intent.groupField] : 'Result';
  const metricValue = row[metricName];
  const countText = intent.operation !== 'count' && row.count !== undefined
    ? ` (${formatDisplayValue(row.count)} record${Number(row.count) === 1 ? '' : 's'})`
    : '';
  return `${formatDisplayValue(groupValue)}: ${metricLabel} ${formatDisplayValue(metricValue)}${countText}`;
};

const summarizeAggregationResult = ({ rows = [], databaseLabel, sourceName, intent, metricName, filters }) => {
  const groupText = intent.groupField ? ` grouped by ${intent.groupField}` : '';
  const metricText = intent.operation === 'count'
    ? 'count'
    : `${intent.operation} of ${intent.metricField}`;
  const metricLabel = aggregationMetricLabel(intent);
  const shownRows = rows.slice(0, Math.min(rows.length, 5));
  const rankingText = intent.sortDirection === 1 ? 'lowest' : 'top';
  const answer = (() => {
    if (rows.length === 0) {
      return `No matching aggregation results found for ${metricLabel}${groupText}.`;
    }

    if (rows.length === 1) {
      return `${aggregationRowLabel(rows[0], intent, metricName, metricLabel)}.`;
    }

    return `${rankingText[0].toUpperCase()}${rankingText.slice(1)} ${shownRows.length}: ${shownRows.map((row) => aggregationRowLabel(row, intent, metricName, metricLabel)).join('; ')}.`;
  })();

  return structuredAnswer({
    answer,
    details: [
      `Database: ${databaseLabel}`,
      `Collection: ${sourceName}`,
      `Matched groups: ${rows.length}`,
      `Aggregation: ${metricText}${groupText}`,
      filters.length ? `Filter: ${filters.map(formatFilter).join(', ')}` : null,
      `Sorted by: ${metricName}`
    ]
  });
};

const mongoPlannerRequested = (context = {}) => (
  context.useLlmMongoPlanner === true ||
  context.mongoPlanner === true ||
  context.enhancePrompt === true ||
  LLM_MONGO_PLANNER_ENABLED
);

const fieldPlannerScore = (field = '', queryTokens = []) => {
  const fieldTokens = labelTokens(field);
  return queryTokens.filter((token) => fieldTokens.includes(token)).length;
};

const prioritizePlannerFields = (fields = [], query = '') => {
  const queryTokens = labelTokens(query);
  return fields
    .map((field, index) => ({
      field,
      index,
      score: fieldPlannerScore(field, queryTokens)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.field)
    .slice(0, MONGO_PLANNER_SCHEMA_FIELD_LIMIT);
};

const summarizeSchemaForMongoPlanner = (schema = {}, query = '') => {
  const queryTokens = labelTokens(query);
  const sources = getDatabaseSourcesFromSchema(schema)
    .map((source, index) => {
      const fieldScore = (source.fields || [])
        .reduce((score, field) => score + fieldPlannerScore(field, queryTokens), 0);
      return {
        source,
        index,
        score: sourceMentionScore(query, source) + fieldScore
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.source);

  return sources
    .slice(0, MONGO_PLANNER_SCHEMA_SOURCE_LIMIT)
    .map((source) => ({
      collection: source.name,
      rowsApprox: source.rowCountEstimate,
      fields: prioritizePlannerFields(source.fields || [], query)
    }));
};

const validateMongoFieldKey = (key, fields = []) => {
  if (key.startsWith('$')) return true;
  const root = key.split('.')[0];
  return fields.some((field) => field === root || field === key);
};

const unsafeMongoKeys = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$merge',
  '$out',
  '$eval',
  '$lookup',
  '$graphLookup',
  '$redact',
  '$geoNear'
]);

const allowedMongoOperators = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$and',
  '$or',
  '$not',
  '$nor',
  '$exists',
  '$type',
  '$regex',
  '$options'
]);

const allowedMongoStages = new Set([
  '$match',
  '$group',
  '$project',
  '$sort',
  '$limit',
  '$skip',
  '$count',
  '$unwind',
  '$addFields'
]);

const isSafeMongoReadValue = (value, fields = [], { stageContext = false } = {}, depth = 0) => {
  if (depth > 12) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isSafeMongoReadValue(item, fields, { stageContext }, depth + 1));
  }
  if (typeof value !== 'object') return false;

  return Object.entries(value).every(([key, nested]) => {
    if (unsafeMongoKeys.has(key)) return false;

    if (key.startsWith('$')) {
      if (stageContext && depth === 0) return allowedMongoStages.has(key);
      if (allowedMongoStages.has(key) || allowedMongoOperators.has(key)) {
        return isSafeMongoReadValue(nested, fields, { stageContext: false }, depth + 1);
      }

      // Aggregation expression operators such as $sum, $avg, $toDouble, $convert,
      // and $ifNull are read-only. Keep them blocked only if they are known unsafe.
      return !unsafeMongoKeys.has(key) && isSafeMongoReadValue(nested, fields, { stageContext: false }, depth + 1);
    }

    if (!validateMongoFieldKey(key, fields) && !['_id', 'count', 'total', 'average', 'minimum', 'maximum', 'value'].includes(key)) {
      return false;
    }

    return isSafeMongoReadValue(nested, fields, { stageContext: false }, depth + 1);
  });
};

const isSafeMongoFilter = (filter, fields = [], depth = 0) => {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;

  return Object.entries(filter).every(([key, value]) => {
    if (unsafeMongoKeys.has(key)) return false;

    if (key.startsWith('$')) {
      if (!['$and', '$or', '$nor'].includes(key)) return false;
      return Array.isArray(value) &&
        value.length <= 20 &&
        value.every((item) => isSafeMongoFilter(item, fields, depth + 1));
    }

    if (!validateMongoFieldKey(key, fields)) return false;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([operator, operatorValue]) => (
        !unsafeMongoKeys.has(operator) &&
        (
          !operator.startsWith('$') ||
          allowedMongoOperators.has(operator)
        ) &&
        isSafeMongoReadValue(operatorValue, fields, { stageContext: false }, depth + 1)
      ));
    }

    return isSafeMongoReadValue(value, fields, { stageContext: false }, depth + 1);
  });
};

const normalizeMongoPlannerFilter = (filter, fields = []) => {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return {};
  const normalized = {};

  for (const [key, value] of Object.entries(filter)) {
    if (['$and', '$or', '$nor'].includes(key) && Array.isArray(value)) {
      normalized[key] = value.map((item) => normalizeMongoPlannerFilter(item, fields));
      continue;
    }

    if (
      ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [field, fieldValue] of Object.entries(value)) {
        if (!validateMongoFieldKey(field, fields)) continue;
        normalized[field] = {
          ...(normalized[field] && typeof normalized[field] === 'object' && !Array.isArray(normalized[field])
            ? normalized[field]
            : {}),
          [key]: fieldValue
        };
      }
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
};

const normalizeMongoPlannerOperation = (operation = '') => {
  const normalized = String(operation || 'find').trim().toLowerCase();
  if (['aggregate', 'aggregation', 'aggregate_pipeline', 'pipeline', 'group', 'groupby', 'group_by', 'sum', 'avg', 'average', 'max', 'maximum', 'min', 'minimum', 'sort', 'sortby', 'sort_by', 'top', 'highest', 'lowest', 'most'].includes(normalized)) {
    return 'aggregate';
  }
  if (['count', 'countdocuments', 'count_documents', 'countdocuments()'].includes(normalized)) return 'count';
  if (['distinct', 'unique', 'distinctvalues', 'distinct_values'].includes(normalized)) return 'distinct';
  if (['find', 'findone', 'search', 'details', 'list'].includes(normalized)) return 'find';
  return normalized;
};

const convertSimplePipelineToFindPlan = (pipeline = []) => {
  const converted = { filter: {}, projection: {}, sort: {}, limit: undefined };
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return null;
    const keys = Object.keys(stage);
    if (keys.length !== 1) return null;
    const key = keys[0];
    if (key === '$match') converted.filter = stage.$match || {};
    else if (key === '$project') converted.projection = stage.$project || {};
    else if (key === '$sort') converted.sort = stage.$sort || {};
    else if (key === '$limit') converted.limit = stage.$limit;
    else if (key === '$skip') continue;
    else return null;
  }
  return converted;
};

const normalizeMongoExtractionPlan = (plan = {}) => {
  const nestedQuery = plan.mongoQuery && typeof plan.mongoQuery === 'object' && !Array.isArray(plan.mongoQuery)
    ? plan.mongoQuery
    : plan.query && typeof plan.query === 'object' && !Array.isArray(plan.query)
      ? plan.query
      : {};
  const intent = plan.intent && typeof plan.intent === 'object' && !Array.isArray(plan.intent)
    ? plan.intent
    : {};
  const responsePlan = plan.response && typeof plan.response === 'object' && !Array.isArray(plan.response)
    ? plan.response
    : plan.answer && typeof plan.answer === 'object' && !Array.isArray(plan.answer)
      ? plan.answer
      : {};

  return {
    ...plan,
    ...nestedQuery,
    version: plan.version || 'mongo-extraction-v1',
    extractionPrompt: plan.extractionPrompt || intent.extractionPrompt || plan.instruction || '',
    answerIntent: plan.answerIntent || intent.answerIntent || responsePlan.intent || '',
    collection: nestedQuery.collection || plan.collection || plan.table || '',
    operation: nestedQuery.operation || plan.operation || '',
    filter: nestedQuery.filter || plan.filter || {},
    projection: nestedQuery.projection || plan.projection || {},
    sort: nestedQuery.sort || plan.sort || {},
    field: nestedQuery.field || plan.field || '',
    pipeline: nestedQuery.pipeline || plan.pipeline || [],
    limit: nestedQuery.limit || plan.limit || 20,
    intent,
    responsePlan
  };
};

const validateMongoPlannerPlan = (plan = {}, schema = {}, query = '') => {
  plan = normalizeMongoExtractionPlan(plan);
  const sources = getDatabaseSourcesFromSchema(schema);
  const collection = String(plan.collection || plan.table || '').trim();
  const source = sources.find((item) => item.name === collection);
  if (!source) return { ok: false, reason: 'Planner selected a collection that is not in the selected database schema.' };

  let operation = normalizeMongoPlannerOperation(plan.operation);
  if (!['find', 'count', 'distinct', 'aggregate'].includes(operation)) {
    if (Array.isArray(plan.pipeline) && plan.pipeline.length > 0) operation = 'aggregate';
    else if (plan.field) operation = 'distinct';
    else operation = 'find';
  }
  if (!['find', 'count', 'distinct', 'aggregate'].includes(operation)) {
    return { ok: false, reason: 'Planner selected an unsupported MongoDB operation.' };
  }

  const normalizedQuery = normalizeLabel(query);
  const needsAggregation = /\b(top|highest|lowest|most|least|best|total|sum|average|avg|mean|group by|per|for each)\b/.test(normalizedQuery);
  if (needsAggregation && !['aggregate', 'count'].includes(operation)) {
    return { ok: false, reason: 'Planner returned a non-aggregation plan for an aggregation/ranking question.' };
  }

  const fields = source.fields || [];
  const limit = Math.max(1, Math.min(Number(plan.limit || 20) || 20, TABLE_ANSWER_LIMIT));
  const expectedEntityFields = inferDatabaseEntityRequestedFields(query, fields);
  const deterministicQuestion = extractDatabaseQuestion(query, schema);
  const deterministicRequestedFields = deterministicQuestion.requestedFields?.length
    ? deterministicQuestion.requestedFields
    : [deterministicQuestion.requestedField].filter(Boolean);
  const sourceHasExpectedFilters = (deterministicQuestion.filters || [])
    .every((filter) => Boolean(findFieldByLabel(fields, filter.field)));
  const sourceHasExpectedRequestedField = deterministicQuestion.fullRowDetails ||
    deterministicRequestedFields.length === 0 ||
    deterministicRequestedFields.some((field) => Boolean(findFieldByLabel(fields, field)));
  if (!sourceHasExpectedFilters) {
    return { ok: false, reason: 'Planner selected a collection that cannot apply the requested filter.' };
  }
  if (!sourceHasExpectedRequestedField) {
    return { ok: false, reason: 'Planner selected a collection that cannot return the requested field.' };
  }
  if (deterministicQuestion.wantsFieldValueForCount && deterministicRequestedFields.length > 0) {
    const sourceHasRequestedField = deterministicRequestedFields.some((field) => findFieldByLabel(fields, field));
    if (!sourceHasRequestedField) {
      return { ok: false, reason: 'Planner selected a collection that cannot return the requested count/stat field.' };
    }
  }
  const args = {
    collection,
    operation,
    limit
  };

  if (operation === 'aggregate' && !needsAggregation) {
    const simpleFind = Array.isArray(plan.pipeline) ? convertSimplePipelineToFindPlan(plan.pipeline) : null;
    if (simpleFind) {
      operation = 'find';
      args.operation = operation;
      args.limit = Math.max(1, Math.min(Number(simpleFind.limit || limit) || limit, TABLE_ANSWER_LIMIT));
      plan = {
        ...plan,
        operation,
        filter: simpleFind.filter,
        projection: simpleFind.projection,
        sort: simpleFind.sort,
        limit: args.limit
      };
    }
  }

  if (operation === 'aggregate') {
    const pipeline = Array.isArray(plan.pipeline) ? plan.pipeline : [];
    if (pipeline.length === 0 || pipeline.length > 8) {
      return { ok: false, reason: 'Planner returned an empty or too-large aggregation pipeline.' };
    }

    const stagesOk = pipeline.every((stage) => {
      if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return false;
      const stageKeys = Object.keys(stage);
      if (stageKeys.length !== 1 || !allowedMongoStages.has(stageKeys[0])) return false;
      if (stageKeys[0] === '$match') return isSafeMongoFilter(stage.$match, fields);
      return isSafeMongoReadValue(stage, fields, { stageContext: true });
    });

    if (!stagesOk) return { ok: false, reason: 'Planner returned an unsafe aggregation pipeline.' };
    args.pipeline = pipeline;
    return { ok: true, source, args, plan: { ...plan, collection, operation, limit, pipeline } };
  }

  const filter = plan.filter && typeof plan.filter === 'object' && !Array.isArray(plan.filter)
    ? normalizeMongoPlannerFilter(plan.filter, fields)
    : {};
  if (!isSafeMongoFilter(filter, fields)) {
    return { ok: false, reason: 'Planner returned an unsafe filter.' };
  }
  args.filter = filter;

  if (operation === 'find') {
    const projection = plan.projection && typeof plan.projection === 'object' && !Array.isArray(plan.projection)
      ? plan.projection
      : {};
    if (!isSafeMongoReadValue(projection, fields)) {
      return { ok: false, reason: 'Planner returned an unsafe projection.' };
    }
    if (
      deterministicRequestedFields.length > 0 &&
      Object.keys(projection).some((key) => projection[key]) &&
      deterministicRequestedFields
        .map((field) => findFieldByLabel(fields, field))
        .filter(Boolean)
        .every((field) => !projection[field])
    ) {
      return { ok: false, reason: 'Planner projection dropped the requested field.' };
    }
    if (
      expectedEntityFields.length > 0 &&
      Object.keys(projection).some((key) => projection[key]) &&
      expectedEntityFields.every((field) => !projection[field])
    ) {
      return { ok: false, reason: 'Planner projection dropped the requested entity field.' };
    }
    if (Object.keys(projection).length > 0) args.projection = projection;

    const sort = plan.sort && typeof plan.sort === 'object' && !Array.isArray(plan.sort)
      ? plan.sort
      : {};
    if (!isSafeMongoReadValue(sort, fields)) {
      return { ok: false, reason: 'Planner returned an unsafe sort.' };
    }
    if (Object.keys(sort).length > 0) args.sort = sort;
  }

  if (operation === 'distinct') {
    const field = String(plan.field || '').trim();
    if (!field || !validateMongoFieldKey(field, fields)) {
      return { ok: false, reason: 'Planner returned an invalid distinct field.' };
    }
    if (
      deterministicRequestedFields.length > 0 &&
      !deterministicRequestedFields.some((expected) => findFieldByLabel([field], expected))
    ) {
      return { ok: false, reason: 'Planner selected the wrong distinct field.' };
    }
    if (expectedEntityFields.length > 0 && !expectedEntityFields.some((expected) => findFieldByLabel([field], expected))) {
      return { ok: false, reason: 'Planner selected the filter field instead of the requested entity field.' };
    }
    args.field = field;
  }

  return { ok: true, source, args, plan: { ...plan, collection, operation, limit, filter } };
};

const applyDetectedMongoConstraints = (validation = {}, query = '', schema = {}) => {
  if (!validation.ok) return validation;

  const fields = validation.source?.fields || [];
  const question = extractDatabaseQuestion(query, schema);
  const detectedFilters = (question.filters || [])
    .map((filter) => {
      const actualField = findFieldByLabel(fields, filter.field);
      return actualField ? { ...filter, field: actualField } : null;
    })
    .filter(Boolean);

  const expectedEntityFields = inferDatabaseEntityRequestedFields(query, fields);
  const args = { ...(validation.args || {}) };
  const plan = { ...(validation.plan || {}) };

  if (detectedFilters.length > 0) {
    const detectedMongoFilter = buildMongoFilter(detectedFilters);
    if (['find', 'count', 'distinct'].includes(args.operation)) {
      args.filter = detectedMongoFilter;
      plan.filter = detectedMongoFilter;
    } else if (args.operation === 'aggregate') {
      const pipeline = Array.isArray(args.pipeline) ? [...args.pipeline] : [];
      const firstStage = pipeline[0] || {};
      if ('$match' in firstStage) pipeline[0] = { $match: detectedMongoFilter };
      else pipeline.unshift({ $match: detectedMongoFilter });
      args.pipeline = pipeline;
      plan.pipeline = pipeline;
    }
  }

  const implicitIdentifierFields = detectedFilters
    .filter((filter) => filter.operator === 'contains' && /\b(name|id)\b/.test(normalizeLabel(filter.field)))
    .map((filter) => filter.field);

  if (question.wantsFieldValueForCount) {
    const deterministicRequestedFields = question.requestedFields?.length
      ? question.requestedFields
      : [question.requestedField].filter(Boolean);
    const actualRequestedFields = deterministicRequestedFields
      .map((field) => findFieldByLabel(fields, field))
      .filter(Boolean);
    if (actualRequestedFields.length === 0) {
      return {
        ...validation,
        ok: false,
        reason: 'Planner selected a collection that cannot return the requested count/stat field.'
      };
    }

    args.operation = 'find';
    plan.operation = 'find';
    args.projection = uniqueValues([...implicitIdentifierFields, ...actualRequestedFields]).reduce((acc, field) => {
      acc[field] = 1;
      return acc;
    }, { _id: 0 });
    plan.projection = args.projection;
    delete args.field;
    delete plan.field;
    delete args.pipeline;
    delete plan.pipeline;
  }

  if (question.wantsRowCount) {
    args.operation = 'count';
    plan.operation = 'count';
    delete args.projection;
    delete plan.projection;
    delete args.field;
    delete plan.field;
    delete args.pipeline;
    delete plan.pipeline;
  }

  if (args.operation === 'distinct' && implicitIdentifierFields.length > 0 && args.field) {
    args.operation = 'find';
    plan.operation = 'find';
    args.projection = uniqueValues([...implicitIdentifierFields, args.field]).reduce((acc, field) => {
      acc[field] = 1;
      return acc;
    }, { _id: 0 });
    plan.projection = args.projection;
    delete args.field;
    delete plan.field;
  }

  if (
    args.operation === 'find' &&
    expectedEntityFields.length > 0 &&
    (!args.projection || Object.keys(args.projection).length === 0)
  ) {
    args.projection = expectedEntityFields.reduce((acc, field) => {
      acc[field] = 1;
      return acc;
    }, { _id: 0 });
    plan.projection = args.projection;
  }

  if (args.operation !== 'aggregate') delete plan.pipeline;
  if (args.operation !== 'distinct') delete plan.field;

  return {
    ...validation,
    args,
    plan
  };
};

const hasPlannerRows = (operation, data) => {
  if (operation === 'count') return data && typeof data.count === 'number';
  if (Array.isArray(data)) return data.length > 0;
  return Boolean(data);
};

const summarizeLlmMongoPlannerResult = ({ databaseLabel, sourceName, plan, toolResult }) => {
  const data = toolResult.structuredContent;

  if (plan.operation === 'count') {
    return structuredAnswer({
      answer: `Count: ${formatDisplayValue(data?.count || 0)}.`,
      details: [
        `Database: ${databaseLabel}`,
        `Collection: ${sourceName}`,
        'Planner: LLM Mongo read plan'
      ]
    });
  }

  if (plan.operation === 'distinct') {
    const values = Array.isArray(data) ? data.map(formatDisplayValue) : [];
    return structuredAnswer({
      answer: values.length
        ? `${plan.field}: ${values.slice(0, 20).join(', ')}`
        : `No distinct ${plan.field} values matched.`,
      details: [
        `Database: ${databaseLabel}`,
        `Collection: ${sourceName}`,
        `Matched values: ${values.length}`,
        'Planner: LLM Mongo read plan'
      ]
    });
  }

  const rows = Array.isArray(data) ? data : [];
  return structuredAnswer({
    answer: rows.length
      ? `Showing ${rows.length} result row${rows.length === 1 ? '' : 's'} in the table below.`
      : 'No matching MongoDB rows were found.',
    details: [
      `Database: ${databaseLabel}`,
      `Collection: ${sourceName}`,
      `Operation: ${plan.operation}`,
      'Planner: LLM Mongo read plan'
    ]
  });
};

const truncateForModel = (text = '', maxChars = MONGO_RESULT_CONTEXT_MAX_CHARS) => {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...truncated...`;
};

const mongoResultForModel = (toolResult = {}, operation = 'find') => {
  const data = toolResult.structuredContent;
  if (operation === 'count') return data || { count: 0 };
  if (operation === 'distinct') {
    return {
      values: Array.isArray(data) ? data.slice(0, MONGO_RESULT_CONTEXT_ROW_LIMIT) : [],
      returnedValues: Array.isArray(data) ? data.length : 0
    };
  }
  if (Array.isArray(data)) {
    const rows = data.slice(0, MONGO_RESULT_CONTEXT_ROW_LIMIT);
    const columns = Array.from(new Set(rows.flatMap((row) => (
      row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : []
    ))));
    const singleValueField = columns.length === 1 ? columns[0] : null;
    return {
      valueField: singleValueField,
      values: singleValueField
        ? rows.map((row) => row?.[singleValueField]).filter((value) => value !== null && value !== undefined)
        : undefined,
      rows,
      returnedRows: data.length
    };
  }
  return data || null;
};

const professionalMongoFallbackAnswer = ({ databaseLabel, sourceName, plan, toolResult }) => {
  const extracted = mongoResultForModel(toolResult, plan.operation);
  if (plan.operation === 'count') {
    return structuredAnswer({
      answer: `Count: ${formatDisplayValue(extracted?.count || 0)}.`,
      details: [
        `Database: ${databaseLabel}`,
        `Collection: ${sourceName}`,
        'Answered from MongoDB extraction.'
      ]
    });
  }

  if (Array.isArray(extracted?.values) && extracted.values.length > 0) {
    const label = extracted.valueField || plan.field || 'values';
    return structuredAnswer({
      answer: `${label}: ${extracted.values.map(formatDisplayValue).join(', ')}`,
      details: [
        `Matched rows: ${extracted.returnedRows || extracted.returnedValues || extracted.values.length}`,
        `Database: ${databaseLabel}`,
        `Collection: ${sourceName}`,
        'Answered from MongoDB extraction.'
      ]
    });
  }

  if (Array.isArray(extracted?.rows) && extracted.rows.length > 0) {
    const rowLines = extracted.rows.slice(0, 20).map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return formatDisplayValue(row);
      return Object.entries(row)
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
        .map(([field, value]) => `${field}: ${formatDisplayValue(value)}`)
        .join(', ');
    }).filter(Boolean);

    if (rowLines.length > 0) {
      return structuredAnswer({
        answer: rowLines,
        details: [
          `Matched rows: ${extracted.returnedRows || rowLines.length}`,
          `Database: ${databaseLabel}`,
          `Collection: ${sourceName}`,
          'Answered from MongoDB extraction.'
        ]
      });
    }
  }

  return summarizeLlmMongoPlannerResult({ databaseLabel, sourceName, plan, toolResult });
};

const finalAnswerCoversMongoValues = (answer = '', extracted = {}) => {
  if (!Array.isArray(extracted.values) || extracted.values.length === 0 || extracted.values.length > 25) return true;
  const normalizedAnswer = normalizeForIntent(answer);
  return extracted.values.every((value) => normalizedAnswer.includes(normalizeForIntent(value)));
};

const finalAnswerCoversMongoRows = (answer = '', extracted = {}) => {
  if (!Array.isArray(extracted.rows) || extracted.rows.length === 0 || extracted.rows.length > 10) return true;
  const normalizedAnswer = normalizeForIntent(answer);
  const values = extracted.rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [row];
    return Object.values(row);
  }).filter((value) => value !== null && value !== undefined && String(value).trim() !== '');

  return values.every((value) => normalizedAnswer.includes(normalizeForIntent(value)));
};

const answerWithLlmFromMongoExtraction = async ({ query, databaseLabel, sourceName, plan, toolResult, extractionPrompt }) => {
  const fallback = professionalMongoFallbackAnswer({ databaseLabel, sourceName, plan, toolResult });
  const controller = new AbortController();
  const extractedData = mongoResultForModel(toolResult, plan.operation);
  const extractedJson = truncateForModel(JSON.stringify(extractedData, null, 2));
  const planJson = truncateForModel(JSON.stringify({
    collection: plan.collection,
    operation: plan.operation,
    filter: plan.filter,
    projection: plan.projection,
    sort: plan.sort,
    field: plan.field,
    pipeline: plan.pipeline,
    limit: plan.limit,
    extractionPrompt
  }, null, 2), 5000);

  try {
    const response = await withTimeout(
      postToOllama({
        prompt: `User question: ${query}

MongoDB extraction plan:
${planJson}

Extracted MongoDB data:
${extractedJson}

Write the final user-facing answer from the extracted MongoDB data only.
If "values" is present, use those values as the direct answer and include every returned value unless there are more than 25.`,
        system: [
          'You are a professional data assistant.',
          'Use only the extracted MongoDB data. Do not guess or invent missing values.',
          'Do not output raw JSON unless the user asks for JSON.',
          'When the data contains a values array, list the values exactly as provided.',
          'Do not skip the first value. Do not add markdown bold markers.',
          'If rows are available in the UI table, summarize the result and mention the matched count.',
          'Always format the answer with short sections:',
          'Answer',
          '- direct answer in clear language',
          '',
          'Details',
          '- database, collection, filter/aggregation, matched rows or values',
          '',
          'Next',
          '- include only if the user needs to refine the question'
        ].join('\n'),
        stream: false,
        options: {
          num_predict: MONGO_FINAL_NUM_PREDICT
        }
      }, { signal: controller.signal }),
      MONGO_FINAL_ANSWER_TIMEOUT_MS,
      'LLM Mongo final answer'
    );

    const answer = formatModelAnswer(response.data?.response);
    if (
      !answer ||
      !finalAnswerCoversMongoValues(answer, extractedData) ||
      !finalAnswerCoversMongoRows(answer, extractedData)
    ) {
      return fallback;
    }
    return answer;
  } catch (error) {
    controller.abort();
    const detail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.warn('LLM Mongo final answer unavailable:', detail);
    return fallback;
  }
};

const normalizeExtractionPrompt = (value, query) => {
  const prompt = typeof value === 'string' ? cleanEnhancedPrompt(value) : '';
  if (
    !prompt ||
    /^precise extraction instruction/i.test(prompt) ||
    /^extract data for:/i.test(prompt)
  ) {
    return `Extract the MongoDB records needed to answer: ${query}`;
  }
  return prompt;
};

const runLlmMongoPlannerQuestion = async (query, { databaseId, databaseLabel, schema, context = {} }) => {
  if (!mongoPlannerRequested(context)) return null;
  if (schema.type !== 'mongodb') return null;
  if (isConfirmMessage(query) || isCancelMessage(query)) return null;

  const schemaSummary = summarizeSchemaForMongoPlanner(schema, query);
  if (schemaSummary.length === 0) return null;

  const controller = new AbortController();
  const promptRewrite = context.promptRewrite || {};
  const system = [
    'You are a MongoDB read-only query planner for an MCP server.',
    'Return only JSON.',
    'You do not answer the user.',
    'You do not inspect raw database rows.',
    'Use only the provided collection names and fields.',
    'A valid plan must use a collection that contains every requested answer field and every filter field.',
    'First rewrite the user request into an extractionPrompt: a precise one-sentence MongoDB extraction instruction.',
    'Only read operations are allowed: find, count, distinct, aggregate.',
    'Never use write operations, $where, $function, $lookup, $graphLookup, $out, or $merge.',
    'Prefer exact filters for names, IDs, dates, and numbers. Use case-insensitive regex only for user text values when exact casing is unknown.',
    'For "how many <entity>" questions, use count with a tight filter. For "how many <numeric/stat field> of <entity>", use find and return that field.',
    'For detail questions, use find with a tight filter and return useful projection fields.',
    'For top, total, average, highest, lowest, or group questions, use aggregate.'
  ].join(' ');

  const prompt = `Selected database id: ${databaseId}
Selected database name: ${databaseLabel}
User question: ${promptRewrite.original || query}
Corrected question: ${query}

MongoDB schema:
${JSON.stringify(schemaSummary, null, 2)}

Return this exact mongo-extraction-v1 JSON shape:
{
  "version": "mongo-extraction-v1",
  "extractionPrompt": "one precise sentence describing exactly which MongoDB records/values to extract",
  "intent": {
    "answerType": "single_value | row_list | count | distinct_values | aggregate",
    "requestedFields": ["fields needed in the final answer"],
    "filterFields": ["fields used to restrict rows"],
    "reason": "short reason for choosing the collection and operation"
  },
  "mongoQuery": {
    "collection": "one collection from schema",
    "operation": "find | count | distinct | aggregate",
    "filter": {},
    "projection": {},
    "sort": {},
    "field": "field for distinct only",
    "pipeline": [],
    "limit": 20
  },
  "response": {
    "answerFields": ["fields the final answer must include"],
    "includeTable": false,
    "format": "Answer / Details / Next"
  }
}`;

  try {
    const response = await withTimeout(
      postToOllama({
        prompt,
        system,
        stream: false,
        format: 'json'
      }, { signal: controller.signal }),
      MONGO_PLANNER_TIMEOUT_MS,
      'LLM Mongo planner'
    );

    const parsed = parseLooseJsonObject(response.data?.response);
    const normalizedPlan = normalizeMongoExtractionPlan(parsed || {});
    let validation = validateMongoPlannerPlan(normalizedPlan, schema, query);
    if (!validation.ok) {
      console.warn('LLM Mongo planner rejected:', validation.reason, normalizedPlan.operation ? `operation=${normalizedPlan.operation}` : '');
      return null;
    }
    validation = applyDetectedMongoConstraints(validation, query, schema);
    if (!validation.ok) {
      console.warn('LLM Mongo planner rejected:', validation.reason);
      return null;
    }

    const toolResult = await withTimeout(
      executeTool('database.query', {
        databaseId,
        ...validation.args
      }),
      DB_AGENT_TIMEOUT_MS,
      `Executing LLM Mongo plan for ${databaseId}`
    );

    if (toolResult.isError || !hasPlannerRows(validation.args.operation, toolResult.structuredContent)) {
      return null;
    }

    const extractionPrompt = normalizeExtractionPrompt(normalizedPlan.extractionPrompt, query);
    validation.plan.extractionPrompt = extractionPrompt;
    validation.plan.version = normalizedPlan.version || 'mongo-extraction-v1';
    validation.plan.intent = normalizedPlan.intent;
    validation.plan.responsePlan = normalizedPlan.responsePlan;
    const finalAnswer = await answerWithLlmFromMongoExtraction({
      query,
      databaseLabel,
      sourceName: validation.source.name,
      plan: validation.plan,
      toolResult,
      extractionPrompt
    });

    return {
      response: finalAnswer,
      toolUsed: 'database.query',
      toolResult,
      llmMongoPlan: validation.plan,
      llmMongoExtractionPrompt: extractionPrompt
    };
  } catch (error) {
    controller.abort();
    const detail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.warn('LLM Mongo planner unavailable:', detail);
    return null;
  }
};

const runMongoAggregationQuestion = async (query, { databaseId, databaseLabel, schema, question }) => {
  const intent = detectMongoAggregationIntent(query, schema, question);
  if (!intent) return null;

  const source = selectAggregationSource(query, question.sources, intent);
  if (!source) return null;

  const fields = source.fields || [];
  const sourceFilters = intent.filters
    .map((filter) => {
      const actualField = findFieldByLabel(fields, filter.field);
      return actualField ? { ...filter, field: actualField } : null;
    })
    .filter(Boolean);

  const actualIntent = {
    ...intent,
    groupField: intent.groupField ? fieldMatchQuality(fields, intent.groupField).field : null,
    metricField: intent.metricField ? fieldMatchQuality(fields, intent.metricField).field : null
  };

  const { pipeline, metricName } = buildMongoAggregationPipeline(actualIntent, sourceFilters);
  const toolResult = await withTimeout(
    executeTool('database.query', {
      databaseId,
      collection: source.name,
      operation: 'aggregate',
      pipeline,
      limit: actualIntent.limit
    }),
    DB_AGENT_TIMEOUT_MS,
    `Aggregating database ${databaseId}`
  );

  return {
    response: summarizeAggregationResult({
      rows: Array.isArray(toolResult.structuredContent) ? toolResult.structuredContent : [],
      databaseLabel,
      sourceName: source.name,
      intent: actualIntent,
      metricName,
      filters: sourceFilters
    }),
    toolUsed: 'database.query',
    toolResult
  };
};

const hasStrongDeterministicMongoPlan = (query, schema = {}, question = {}) => {
  if (schema.type !== 'mongodb') return false;
  if (!question || question.sources?.length === 0) return false;

  const requestedFields = question.requestedFields?.length
    ? question.requestedFields
    : [question.requestedField].filter(Boolean);

  if (detectMongoAggregationIntent(query, schema, question)) return true;
  if (question.wantsRowCount || question.wantsDistinctCount || question.wantsFieldValueForCount) return true;
  if (question.fullRowDetails && question.filters?.length > 0) return true;
  if (requestedFields.length > 0 && question.filters?.length > 0) return true;

  const normalized = normalizeLabel(query);
  return requestedFields.length > 0 &&
    /\b(what|which|who|show|list|find|get|tell|tell me|give|give me|provide)\b/.test(normalized);
};

const runDatabaseQuestion = async (query, context = {}) => {
  const scope = context.scope || 'auto';
  if (scope === 'document') return null;

  const normalized = normalizeForIntent(query);
  if (!/\b(what|which|who|when|where|how many|count|number of|show|find|get|tell|tell me|give|give me|provide me|provide)\b/.test(normalized)) {
    return null;
  }

  const hasAggregationGrouping = /\b(group by|by|per|each|for each|top|highest|lowest)\b/.test(normalized);
  if (!hasAggregationGrouping && /\b(rows|documents|records|schema|tables|collections|databases|connections|snapshots|working copies)\b/.test(normalized)) {
    return null;
  }

  const databaseId = context.databaseId || process.env.MCP_DEFAULT_DATABASE_ID || 'default';
  let describeResult;
  try {
    describeResult = await withTimeout(
      executeTool('database.describe', { databaseId }),
      DB_AGENT_TIMEOUT_MS,
      `Inspecting database ${databaseId}`
    );
  } catch (error) {
    return {
      response: `I could not inspect the selected database "${databaseId}": ${error.message}`,
      toolUsed: 'database.describe',
      toolResult: {
        isError: true,
        structuredContent: { error: error.message },
        content: [{ type: 'text', text: error.message }]
      }
    };
  }
  if (describeResult.isError) {
    return {
      response: describeResult.structuredContent?.error || 'I could not inspect the selected database.',
      toolUsed: 'database.describe',
      toolResult: describeResult
    };
  }

  const schema = describeResult.structuredContent;
  const databaseLabel = formatDatabaseLabel(databaseId, schema.database);
  const schemaSources = getDatabaseSourcesFromSchema(schema);
  if (schemaSources.length === 0) {
    if (shouldUseDatabaseFallback(context)) {
      const fallback = await findFallbackDatabaseForQuestion(query, databaseId);
      if (fallback) {
        const fallbackResult = await runDatabaseQuestion(query, {
          ...context,
          databaseId: fallback.databaseId,
          allowDatabaseFallback: false
        });

        if (fallbackResult?.response) {
          return {
            ...fallbackResult,
            response: [
              section('Note', [
                `Selected database "${databaseId}" is empty.`,
                `Used "${fallback.databaseId}" because it has matching data.`
              ]),
              fallbackResult.response
            ].filter(Boolean).join('\n\n')
          };
        }
      }
    }

    return {
      response: structuredAnswer({
        answer: `The selected database "${databaseLabel}" is connected, but it has no collections or tables to query yet.`,
        next: [
          'Select a database that has data, or add/import collections into this database.',
          'If your data is in Excel/CSV/PDF/Word, select Document instead.'
        ]
      }),
      toolUsed: 'database.describe',
      toolResult: describeResult
    };
  }

  const question = extractDatabaseQuestion(query, schema);
  const useTrustedExtractor = hasStrongDeterministicMongoPlan(query, schema, question);
  if (!useTrustedExtractor) {
    const llmMongoResult = await runLlmMongoPlannerQuestion(query, {
      databaseId,
      databaseLabel,
      schema,
      context
    });
    if (llmMongoResult) return llmMongoResult;
  }

  if (question.sources.length === 0) {
    return {
      response: structuredAnswer({
        answer: `I inspected "${databaseLabel}", but I could not match your question to a collection/table in the selected database.`,
        details: [`Available sources: ${schemaSources.map((source) => source.name).join(', ')}`],
        next: ['Try naming the collection/table explicitly, or turn on AI assist for MongoDB planning.']
      }),
      toolUsed: 'database.describe',
      toolResult: describeResult
    };
  }

  const aggregationResult = await runMongoAggregationQuestion(query, {
    databaseId,
    databaseLabel,
    schema,
    question
  });
  if (aggregationResult) return aggregationResult;

  const requestedFields = question.requestedFields?.length
    ? question.requestedFields
    : [question.requestedField].filter(Boolean);

  if (requestedFields.length === 0 && !question.fullRowDetails) {
    if (scope === 'database') {
      const availableFields = Array.from(new Set(question.sources.flatMap((source) => source.fields || [])));
      return {
        response: structuredAnswer({
          answer: `I inspected "${databaseLabel}", but I could not find a field from your question.`,
          details: availableFields.length
            ? [`Available fields: ${availableFields.slice(0, 20).join(', ')}`]
            : ['The schema did not report any fields.'],
          next: ['Ask using one of the available field names, or describe the selected database first.']
        }),
        toolUsed: 'database.describe',
        toolResult: describeResult
      };
    }

    return null;
  }

  const candidateSources = selectDatabaseSources(query, question.sources, requestedFields, question.filters);
  if (candidateSources.length === 0) {
    return {
      response: structuredAnswer({
        answer: `I found the field${requestedFields.length === 1 ? '' : 's'} "${requestedFields.join(', ')}", but no collection/table matched the filters in your question.`,
        details: [`Available sources: ${question.sources.map((source) => source.name).join(', ')}`],
        next: ['Try naming the collection/table explicitly, or use a different filter value.']
      }),
      toolUsed: 'database.describe',
      toolResult: describeResult
    };
  }

  const results = [];
  const type = schema.type;

  for (const source of candidateSources.slice(0, 3)) {
    const sourceFields = source.fields || [];
    const actualRequestedFields = question.fullRowDetails
      ? []
      : uniqueValues(requestedFields.map((field) => findFieldByLabel(sourceFields, field)));
    if (!question.fullRowDetails && actualRequestedFields.length === 0) continue;
    const requestedField = actualRequestedFields[0];

    const filters = question.filters
      .map((filter) => {
        const actualField = findFieldByLabel(sourceFields, filter.field);
        return actualField ? { ...filter, field: actualField } : null;
      })
      .filter(Boolean);
    const contextFields = uniqueValues(filters
      .filter((filter) => ['contains', 'exact'].includes(filter.operator) && /\b(name|id)\b/.test(normalizeLabel(filter.field)))
      .map((filter) => filter.field)
      .filter((field) => !actualRequestedFields.includes(field)));
    const outputFields = question.fullRowDetails
      ? []
      : uniqueValues([...contextFields, ...actualRequestedFields]);

    if (type === 'mongodb') {
      const filter = buildMongoFilter(filters);
      const projection = outputFields.reduce((acc, field) => {
        acc[field] = 1;
        return acc;
      }, { _id: 0 });
      const toolArgs = question.fullRowDetails
        ? {
            databaseId,
            collection: source.name,
            operation: 'find',
            filter,
            limit: TABLE_ANSWER_LIMIT
          }
        : question.wantsDistinctCount
        ? {
            databaseId,
            collection: source.name,
            operation: 'distinct',
            field: requestedField,
            filter,
            limit: 100
          }
        : question.wantsRowCount
        ? {
            databaseId,
            collection: source.name,
            operation: 'count',
            filter,
            limit: 1
          }
        : {
            databaseId,
            collection: source.name,
            operation: 'find',
            filter,
            projection,
            limit: 20
          };

      try {
        const toolResult = await withTimeout(
          executeTool('database.query', toolArgs),
          DB_AGENT_TIMEOUT_MS,
          `Querying database ${databaseId}`
        );
        if (!toolResult.isError) {
          results.push({ source, requestedField, requestedFields: outputFields, filters, toolResult, rows: toolResult.structuredContent || [] });
        }
      } catch (error) {
        results.push({
          source,
          requestedField,
          requestedFields: outputFields,
          filters,
          toolResult: {
            isError: true,
            structuredContent: { error: error.message },
            content: [{ type: 'text', text: error.message }]
          },
          rows: []
        });
      }
      continue;
    }

    const { where, params } = buildSqlWhere(filters, type);
    const fieldSql = question.wantsRowCount
      ? 'COUNT(*) AS count'
      : question.fullRowDetails
      ? '*'
      : outputFields
        .map((field) => `${quoteSqlIdentifier(field, type)} AS ${quoteSqlIdentifier(field, type)}`)
        .join(', ');
    const sourceSql = quoteSqlSource(source, type);
    const sql = question.wantsDistinctCount
      ? `SELECT DISTINCT ${quoteSqlIdentifier(requestedField, type)} AS value FROM ${sourceSql}${where}`
      : `SELECT ${fieldSql} FROM ${sourceSql}${where}`;
    try {
      const toolResult = await withTimeout(
        executeTool('database.query', {
          databaseId,
          sql,
          params,
          limit: question.wantsDistinctCount ? 100 : question.wantsRowCount ? 1 : 20
        }),
        DB_AGENT_TIMEOUT_MS,
        `Querying database ${databaseId}`
      );
      if (!toolResult.isError) {
        results.push({ source, requestedField, requestedFields: outputFields, filters, toolResult, rows: toolResult.structuredContent || [] });
      }
    } catch (error) {
      results.push({
        source,
        requestedField,
        requestedFields: outputFields,
        filters,
        toolResult: {
          isError: true,
          structuredContent: { error: error.message },
          content: [{ type: 'text', text: error.message }]
        },
        rows: []
      });
    }
  }

  if (results.length === 0) {
    return {
      response: structuredAnswer({
        answer: `I found the field${requestedFields.length === 1 ? '' : 's'} "${requestedFields.join(', ')}", but the query did not return a usable result.`,
        next: ['Try naming the table or collection explicitly.']
      }),
      toolUsed: 'database.query',
      toolResult: describeResult
    };
  }

  if (results.every((result) => result.toolResult?.isError)) {
    const detail = results.map((result) => result.toolResult.structuredContent?.error).filter(Boolean).join('; ');
    return {
      response: structuredAnswer({
        answer: `I found the field${requestedFields.length === 1 ? '' : 's'} "${requestedFields.join(', ')}", but the selected database query failed.`,
        details: detail ? [detail] : []
      }),
      toolUsed: 'database.query',
      toolResult: results[0].toolResult
    };
  }

  const valueFromRow = (row, field) => {
    if (row === null || row === undefined) return null;
    if (typeof row !== 'object') return row;
    return row[field] ?? row.value ?? row.VALUE ?? null;
  };

  const formatQueryValue = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
  };

  const responseFields = uniqueValues(results.flatMap((result) => (
    result.requestedFields?.length ? result.requestedFields : [result.requestedField]
  )));
  const responseFieldText = responseFields.join(', ');

  const values = Array.from(new Set(results.flatMap((result) => {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return rows.map((row) => valueFromRow(row, result.requestedField))
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      .map(formatQueryValue);
  })));

  const rowSummaries = uniqueValues(results.flatMap((result) => {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const fields = result.requestedFields?.length ? result.requestedFields : [result.requestedField];
    return rows.map((row) => fields
      .map((field) => {
        const value = valueFromRow(row, field);
        if (value === null || value === undefined || String(value).trim() === '') return null;
        return `${field}: ${formatQueryValue(value)}`;
      })
      .filter(Boolean)
      .join(', '))
      .filter(Boolean);
  })).slice(0, 20);

  const matchedRows = results.reduce((count, result) => {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return count + rows.length;
  }, 0);
  const filterText = question.filters.length > 0
    ? ` using ${question.filters.map(formatFilter).join(', ')}`
    : '';
  const sourceText = Array.from(new Set(results.map((result) => result.source.name))).join(', ');

  if (question.fullRowDetails) {
    const combinedRows = results.flatMap((result) => {
      const rows = Array.isArray(result.rows) ? result.rows : [];
      return rows.map((row) => (
        results.length > 1 && row && typeof row === 'object'
          ? { _source: result.source.name, ...row }
          : row
      ));
    });
    const combinedToolResult = results.length > 1
      ? {
          ...results[0].toolResult,
          structuredContent: combinedRows,
          content: [{ type: 'text', text: JSON.stringify(combinedRows, null, 2) }]
        }
      : results[0].toolResult;

    return {
      response: structuredAnswer({
        answer: `Showing ${combinedRows.length} matching row${combinedRows.length === 1 ? '' : 's'} in the table below.`,
        details: [
          `Database: ${databaseLabel}`,
          sourceText ? `Source: ${sourceText}` : null,
          filterText ? `Filter:${filterText.replace(/^ using/, '')}` : null
        ]
      }),
      toolUsed: 'database.query',
      toolResult: combinedToolResult
    };
  }

  if (question.wantsRowCount) {
    const totalCount = results.reduce((count, result) => {
      const data = result.toolResult?.structuredContent;
      if (data && typeof data === 'object' && !Array.isArray(data) && Number.isFinite(Number(data.count))) {
        return count + Number(data.count);
      }
      if (Array.isArray(data) && data[0] && Number.isFinite(Number(data[0].count))) {
        return count + Number(data[0].count);
      }
      return count;
    }, 0);

    return {
      response: structuredAnswer({
        answer: `Count: ${formatDisplayValue(totalCount)}.`,
        details: [
          `Database: ${databaseLabel}`,
          sourceText ? `Source: ${sourceText}` : null,
          filterText ? `Filter:${filterText.replace(/^ using/, '')}` : null
        ]
      }),
      toolUsed: 'database.query',
      toolResult: results[0].toolResult
    };
  }

  if (question.wantsDistinctCount) {
    return {
      response: structuredAnswer({
        answer: `Found ${values.length} distinct ${responseFieldText || question.requestedField} value${values.length === 1 ? '' : 's'}.`,
        details: [
          `Database: ${databaseLabel}`,
          sourceText ? `Source: ${sourceText}` : null,
          values.length ? `Values: ${values.join(', ')}` : null
        ]
      }),
      toolUsed: 'database.query',
      toolResult: results[0].toolResult
    };
  }

  if (responseFields.length > 1 && rowSummaries.length > 0) {
    return {
      response: structuredAnswer({
        answer: rowSummaries,
        details: [
          `Matched rows: ${matchedRows}`,
          `Database: ${databaseLabel}`,
          sourceText ? `Source: ${sourceText}` : null,
          filterText ? `Filter:${filterText.replace(/^ using/, '')}` : null
        ]
      }),
      toolUsed: 'database.query',
      toolResult: results[0].toolResult
    };
  }

  if (values.length > 0) {
    return {
      response: structuredAnswer({
        answer: `${responseFieldText || question.requestedField}: ${values.join(', ')}`,
        details: [
          `Matched rows: ${matchedRows}`,
          `Database: ${databaseLabel}`,
          sourceText ? `Source: ${sourceText}` : null,
          filterText ? `Filter:${filterText.replace(/^ using/, '')}` : null
        ]
      }),
      toolUsed: 'database.query',
      toolResult: results[0].toolResult
    };
  }

  return {
    response: structuredAnswer({
      answer: `I did not find matching ${responseFieldText || question.requestedField} value${responseFields.length === 1 ? '' : 's'}.`,
      details: [
        `Database: ${databaseLabel}`,
        filterText ? `Filter:${filterText.replace(/^ using/, '')}` : null
      ]
    }),
    toolUsed: 'database.query',
    toolResult: results[0].toolResult
  };
};

const summarizeDirectToolResult = (toolName, toolResult) => {
  const data = toolResult.structuredContent;
  const formatAnswerValue = (value) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? String(value)
        : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return String(value);
  };
  const hasTableRows = (value) => Array.isArray(value?.rows) && value.rows.length > 0;
  const hasConditionalFilters = (value) => Array.isArray(value?.appliedFilters) && value.appliedFilters.length > 0;

  if (toolName === 'database.list_connections' && Array.isArray(data)) {
    return structuredAnswer({
      answer: `I can access ${data.length} database${data.length === 1 ? '' : 's'}.`,
      details: data.map((db) => `${formatDatabaseLabel(db.id, db.database)} (${db.type})`)
    });
  }

  if (toolName === 'database.count_rows' && data) {
    const buckets = data.collections || data.tables || [];
    return structuredAnswer({
      answer: `Total rows/documents: ${data.totalRows ?? data.totalDocuments ?? 0}`,
      details: [
        `Database: ${formatDatabaseLabel(data.id, data.database)}`,
        ...buckets.map((item) => `${item.name}: ${item.count}`)
      ]
    });
  }

  if (toolName === 'database.describe' && data) {
    const items = data.collections || data.tables || [];
    return structuredAnswer({
      answer: `${formatDatabaseLabel(data.id, data.database)} has ${items.length} collection/table${items.length === 1 ? '' : 's'}.`,
      details: [
        `Database: ${formatDatabaseLabel(data.id, data.database)}`,
        ...(items.length
        ? items.map((item) => {
          const fields = item.fields || (item.columns || []).map((column) => column.name).filter(Boolean);
          return `${item.name}${item.rowCountEstimate !== undefined ? ` (${item.rowCountEstimate} rows approx.)` : ''}${fields?.length ? `: ${fields.slice(0, 12).join(', ')}` : ''}`;
        })
        : ['No collections/tables were found.'])
      ]
    });
  }

  if (toolName === 'database.create_snapshot' && data) {
    return structuredAnswer({
      answer: `Created database working copy ${data.id}.`,
      details: [
        `Database: ${data.databaseId}`,
        `Copied rows: ${data.rowCount || 0}`,
        `Sources: ${data.sourceCount || 0}`
      ],
      next: ['Original and updated JSON downloads are available in Database Access.']
    });
  }

  if (toolName === 'database.list_snapshots') {
    const snapshots = Array.isArray(data) ? data : [];
    if (snapshots.length === 0) {
      return structuredAnswer({
        answer: 'No database working copies have been created yet.',
        next: ['Create a snapshot before editing database data safely.']
      });
    }
    return structuredAnswer({
      answer: `Found ${snapshots.length} database working cop${snapshots.length === 1 ? 'y' : 'ies'}.`,
      details: snapshots.map((snapshot) => `${snapshot.id} | ${snapshot.databaseId} | ${snapshot.rowCount || 0} rows`)
    });
  }

  if (toolName === 'database.query_snapshot' && data) {
    return structuredAnswer({
      answer: `Showing ${data.returnedRows} of ${data.totalRows} rows.`,
      details: [`Snapshot: ${data.snapshotId}`, `Source: ${data.source}`]
    });
  }

  if (toolName === 'database.update_snapshot_rows' && data) {
    return structuredAnswer({
      answer: `Applied the update to ${data.changedRows || 0} row${data.changedRows === 1 ? '' : 's'}.`,
      details: [`Snapshot: ${data.snapshotId}`, `Source: ${data.source}`]
    });
  }

  if (toolName === 'database.add_snapshot_row' && data) {
    return `Added one row to database snapshot ${data.snapshotId}, source ${data.source}, at row index ${data.rowIndex}.`;
  }

  if (toolName === 'database.delete_snapshot_rows' && data) {
    return `Deleted ${data.deletedRows || 0} row${data.deletedRows === 1 ? '' : 's'} from database snapshot ${data.snapshotId}, source ${data.source}.`;
  }

  if (toolName === 'document.list_sources') {
    const docs = Array.isArray(data) ? data : [];
    if (docs.length === 0) {
      return structuredAnswer({
        answer: 'No documents are uploaded yet.',
        next: ['Add files from Document Access.']
      });
    }
    return structuredAnswer({
      answer: `I can access ${docs.length} document${docs.length === 1 ? '' : 's'}.`,
      details: docs.map((doc) => `${doc.name} (${doc.id})`)
    });
  }

  if (toolName === 'document.search') {
    const results = Array.isArray(data) ? data : [];
    if (results.length === 0) return 'I did not find matching content in the uploaded documents.';
    return `I found ${results.length} relevant result${results.length === 1 ? '' : 's'}: ${results.map((item) => `${item.documentName}${item.chunkIndex !== undefined ? ` chunk ${item.chunkIndex}` : ''}`).join(', ')}.`;
  }

  if (toolName === 'document.answer_text_question' && data) {
    if (!data.answer) {
      return structuredAnswer({
        answer: 'I could not find a reliable answer in the selected document.',
        details: [
          `Document: ${data.documentName}`,
          `Matched chunks: ${data.matchedChunks || 0}`
        ],
        next: ['Ask with a more specific phrase from the PDF/Word file.']
      });
    }

    const evidenceLines = (data.evidence || [])
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const answerLines = evidenceLines.length > 0
      ? evidenceLines
      : String(data.answer)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8);
    const sources = Array.from(new Set((data.evidence || data.chunks || [])
      .map((item) => item.uri || (item.chunkIndex !== undefined ? `chunk ${item.chunkIndex}` : null))
      .filter(Boolean)
      .slice(0, 5)));

    return structuredAnswer({
      answer: answerLines,
      details: [
        `Document: ${data.documentName}`,
        `Matched chunks: ${data.matchedChunks || 0}`,
        sources.length ? `Sources: ${sources.join(', ')}` : null
      ],
      note: ['This answer is based only on retrieved text from the selected document.']
    });
  }

  if (toolName === 'document.describe' && data) {
    const details = data.kind === 'table'
      ? `${data.sheetCount || 0} sheet${data.sheetCount === 1 ? '' : 's'}`
      : `${data.chunkCount || 0} text chunk${data.chunkCount === 1 ? '' : 's'}`;
    return structuredAnswer({
      answer: `${data.name} is a ${data.kind} document.`,
      details: [`Content: ${details}`, `Document id: ${data.id}`]
    });
  }

  if (toolName === 'document.query_table' && data) {
    return `Showing ${data.returnedRows} of ${data.totalRows} rows from ${data.documentName}, sheet ${data.sheet}.`;
  }

  if (toolName === 'document.answer_table_question' && data) {
    if (hasTableRows(data) && (hasConditionalFilters(data) || data.fullRowDetails)) {
      const filterText = data.appliedFilters.map((filter) => formatFilter({
        field: filter.column,
        operator: filter.operator,
        value: filter.value
      })).join(', ');
      return structuredAnswer({
        answer: `Showing ${data.returnedRows} of ${data.matchedRows} matching row${data.matchedRows === 1 ? '' : 's'} in the table below.`,
        details: [
          `Document: ${data.documentName}`,
          `Sheet: ${data.sheet}`,
          filterText ? `Filter: ${filterText}` : null
        ]
      });
    }

    if (data.answer !== null && data.answer !== undefined) {
      const columnText = data.answerType === 'count' ? '' : (data.requestedColumn ? `${data.requestedColumn}: ` : '');
      const filterText = data.appliedFilters?.length
        ? data.appliedFilters.map((filter) => formatFilter({
          field: filter.column,
          operator: filter.operator,
          value: filter.value
        })).join(', ')
        : null;
      return structuredAnswer({
        answer: `${columnText}${formatAnswerValue(data.answer)}`,
        details: [
          `Document: ${data.documentName}`,
          `Sheet: ${data.sheet}`,
          `Matched rows: ${data.matchedRows}`,
          filterText ? `Filter: ${filterText}` : null
        ]
      });
    }

    if (data.matchedRows > 0) {
      const columns = data.rows?.[0] ? Object.keys(data.rows[0]).join(', ') : 'no columns';
      return structuredAnswer({
        answer: `Matched ${data.matchedRows} row${data.matchedRows === 1 ? '' : 's'}, but I could not tell which column you wanted.`,
        details: [`Document: ${data.documentName}`, `Sheet: ${data.sheet}`, `Available columns: ${columns}`],
        next: ['Ask again with the exact column name.']
      });
    }

    return structuredAnswer({
      answer: 'I did not find a matching row.',
      details: [`Document: ${data.documentName}`, `Sheet: ${data.sheet}`]
    });
  }

  if (toolName === 'document.update_cell' && data) {
    return `Applied the update to ${data.changedRows || data.matchedRows || 0} row${(data.changedRows || data.matchedRows) === 1 ? '' : 's'} in ${data.documentName}, sheet ${data.sheet}.`;
  }

  if (toolName === 'document.add_row' && data) {
    return `Added one row to ${data.documentName}, sheet ${data.sheet}, at row index ${data.rowIndex}.`;
  }

  if (toolName === 'document.delete_rows' && data) {
    return `Deleted ${data.deletedRows || 0} row${data.deletedRows === 1 ? '' : 's'} from ${data.documentName}, sheet ${data.sheet}.`;
  }

  return toolResult.content?.[0]?.text || JSON.stringify(toolResult, null, 2);
};

const formatPreviewValue = (value) => String(value ?? '');

const summarizeMutationPreview = (toolResult) => {
  if (toolResult.isError) {
    return toolResult.structuredContent?.error || toolResult.content?.[0]?.text || 'I could not prepare that edit.';
  }

  const data = toolResult.structuredContent;
  if (!data || data.matchedRows === 0) {
    return `I did not find any matching rows in ${data?.documentName || 'the selected document'}. Nothing has been changed.`;
  }

  const examples = (data.changes || [])
    .slice(0, 5)
    .map((change) => `row ${change.rowIndex}: ${change.column} "${formatPreviewValue(change.before)}" -> "${formatPreviewValue(change.after)}"`)
    .join('; ');

  const more = data.matchedRows > (data.changes?.length || 0)
    ? ` I previewed ${data.changes?.length || 0} of them.`
    : '';

  return structuredAnswer({
    answer: 'I prepared this document change, but I have not applied it yet.',
    details: [
      `Document: ${data.documentName}`,
      `Sheet: ${data.sheet}`,
      `Rows to update: ${data.matchedRows}`,
      more.trim() || null,
      examples ? `Preview: ${examples}` : null
    ],
    next: ['Say "confirm" to apply it, or "cancel" to discard it.']
  });
};

const summarizeDatabaseMutationPreview = (toolResult, createdSnapshot = false, fallbackFromDatabaseId = null) => {
  if (toolResult.isError) {
    return toolResult.structuredContent?.error || toolResult.content?.[0]?.text || 'I could not prepare that database edit.';
  }

  const data = toolResult.structuredContent;
  if (!data || data.matchedRows === 0) {
    return `I did not find any matching rows in database working copy ${data?.snapshotId || ''}. Nothing has been changed.`;
  }

  const examples = (data.changes || [])
    .slice(0, 5)
    .map((change) => `row ${change.rowIndex}: ${change.field} "${formatPreviewValue(change.before)}" -> "${formatPreviewValue(change.after)}"`)
    .join('; ');

  const fallbackPrefix = fallbackFromDatabaseId
    ? `The selected database "${fallbackFromDatabaseId}" has no editable data, so I used "${data.databaseId}" because it has matching working-copy data. `
    : '';
  const prefix = createdSnapshot ? `I created a safe database working copy (${data.snapshotId}) and prepared this change. ` : `I prepared this change in database working copy ${data.snapshotId}. `;
  const more = data.matchedRows > (data.changes?.length || 0)
    ? ` I previewed ${data.changes?.length || 0} of them.`
    : '';

  return structuredAnswer({
    answer: `${fallbackPrefix}${prefix}`.trim(),
    details: [
      `Database: ${data.databaseId}`,
      `Snapshot: ${data.snapshotId}`,
      `Source: ${data.source}`,
      `Rows to update: ${data.matchedRows}`,
      more.trim() || null,
      examples ? `Preview: ${examples}` : null
    ],
    next: ['Say "confirm" to apply it to the working copy, or "cancel" to discard it.']
  });
};

const summarizeConfirmedMutation = (toolName, toolResult) => {
  if (toolResult.isError) {
    return toolResult.structuredContent?.error || toolResult.content?.[0]?.text || 'The confirmed edit failed.';
  }

  return summarizeDirectToolResult(toolName, toolResult);
};

const contextInstructions = (context = {}) => {
  const lines = [];

  if (context.scope && context.scope !== 'auto') {
    lines.push(`User selected source type: ${context.scope}.`);
  }

  if (context.databaseId) {
    lines.push(`Use databaseId "${context.databaseId}" for every database tool call. Do not replace it with "default".`);
  }

  if (context.documentId) {
    lines.push(`Use documentId "${context.documentId}" for every document tool call.`);
  }

  const selectedContext = lines.length > 0 ? `\n\nSELECTED CONTEXT:\n${lines.join('\n')}` : '';
  return `${selectedContext}${formatPromptLayerForModel(context.promptRewrite)}`;
};

const enforceSelectedContextOnIntent = (intent = {}, context = {}) => {
  if (!intent?.tool) return intent;

  const parameters = { ...(intent.parameters || {}) };
  if (
    intent.tool.startsWith('database.') &&
    intent.tool !== 'database.list_connections' &&
    context.databaseId
  ) {
    parameters.databaseId = context.databaseId;
  }

  if (
    intent.tool.startsWith('document.') &&
    intent.tool !== 'document.list_sources' &&
    context.documentId
  ) {
    parameters.documentId = context.documentId;
  }

  return {
    ...intent,
    parameters
  };
};

const MULTI_QUERY_INTENT_PREFIX = String.raw`(?:what\s+is|what\s+are|whats|which|who|when|where|how\s+many|count|number\s+of|show\s+me|show|find|get|tell\s+me|give\s+me|provide\s+me|provide|list|describe|search|change|update|set|replace|edit|correct|modify|delete|add|create|make|generate|confirm|cancel)`;
const MULTI_QUERY_LIMIT = Number(process.env.MCP_MULTI_QUERY_LIMIT || 6);
const MULTI_QUERY_SEPARATOR = '__MCP_QUERY_SEPARATOR__';

const splitCompoundQuery = (query) => {
  const text = String(query || '').trim();
  if (!text) return [];
  if (isConfirmMessage(text) || isCancelMessage(text)) return [text];

  const intentLookahead = new RegExp(`(?=${MULTI_QUERY_INTENT_PREFIX}\\b)`, 'i');
  const intentSplit = new RegExp(`\\s+(?:and\\s+then|then|also|plus|and)\\s+${intentLookahead.source}`, 'gi');
  const commaSplit = new RegExp(`,\\s+${intentLookahead.source}`, 'gi');
  const sentenceSplit = new RegExp(`\\.\\s+${intentLookahead.source}`, 'gi');

  const splitText = text
    .replace(/\r\n/g, '\n')
    .replace(/\n+\s*(?:[-*]|\d+[.)])?\s*/g, ` ${MULTI_QUERY_SEPARATOR} `)
    .replace(/;\s*/g, ` ${MULTI_QUERY_SEPARATOR} `)
    .replace(/\?\s+(?=\S)/g, `? ${MULTI_QUERY_SEPARATOR} `)
    .replace(sentenceSplit, `. ${MULTI_QUERY_SEPARATOR} `)
    .replace(commaSplit, ` ${MULTI_QUERY_SEPARATOR} `)
    .replace(intentSplit, ` ${MULTI_QUERY_SEPARATOR} `);

  const parts = splitText
    .split(MULTI_QUERY_SEPARATOR)
    .map((part) => part.trim().replace(/^(?:and|then|also|plus)\s+/i, '').trim())
    .filter(Boolean);

  return parts.length > 1 ? parts.slice(0, MULTI_QUERY_LIMIT) : [text];
};

const formatMultiQueryResponse = (items) => items
  .map((item, index) => {
    const answer = item.result?.response || item.result?.error || 'No response returned.';
    return `${index + 1}. ${answer}`;
  })
  .join('\n\n');

const section = (title, lines = []) => {
  const cleanLines = lines.filter((line) => line !== null && line !== undefined && String(line).trim() !== '');
  if (cleanLines.length === 0) return '';
  return `${title}\n${cleanLines.map((line) => `- ${line}`).join('\n')}`;
};

const structuredAnswer = ({ answer = [], details = [], next = [], note = [] } = {}) => {
  return [
    section('Answer', Array.isArray(answer) ? answer : [answer]),
    section('Details', details),
    section('Next', next),
    section('Note', note)
  ].filter(Boolean).join('\n\n');
};

const formatDatabaseLabel = (connectionId, databaseName) => {
  return databaseName || connectionId || 'Selected database';
};

const formatModelAnswer = (text) => {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (/^Answer\s*\n/i.test(clean)) return clean;

  const lines = clean
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return structuredAnswer({ answer: lines[0] || clean });
  }

  return structuredAnswer({
    answer: lines.slice(0, 3),
    details: lines.slice(3, 10)
  });
};

const processSingleQuery = async (query, context = {}) => {
  try {
    const sessionKey = getSessionKey(context);
    const pendingMutation = pendingDocumentMutations.get(sessionKey);
    const pendingDatabaseMutation = pendingDatabaseMutations.get(sessionKey);

    if (pendingMutation && Date.now() - pendingMutation.createdAt > PENDING_MUTATION_TTL_MS) {
      pendingDocumentMutations.delete(sessionKey);
    } else if (pendingMutation && isConfirmMessage(query)) {
      const toolResult = await executeTool(pendingMutation.applyTool, pendingMutation.applyParameters);
      pendingDocumentMutations.delete(sessionKey);
      return {
        response: summarizeConfirmedMutation(pendingMutation.applyTool, toolResult),
        toolUsed: pendingMutation.applyTool,
        toolResult
      };
    } else if (pendingMutation && isCancelMessage(query)) {
      pendingDocumentMutations.delete(sessionKey);
      return {
        response: 'Canceled. I did not change the document.'
      };
    }

    if (pendingDatabaseMutation && Date.now() - pendingDatabaseMutation.createdAt > PENDING_MUTATION_TTL_MS) {
      pendingDatabaseMutations.delete(sessionKey);
    } else if (pendingDatabaseMutation && isConfirmMessage(query)) {
      const toolResult = await executeTool(pendingDatabaseMutation.applyTool, pendingDatabaseMutation.applyParameters);
      pendingDatabaseMutations.delete(sessionKey);
      return {
        response: summarizeConfirmedMutation(pendingDatabaseMutation.applyTool, toolResult),
        toolUsed: pendingDatabaseMutation.applyTool,
        toolResult
      };
    } else if (pendingDatabaseMutation && isCancelMessage(query)) {
      pendingDatabaseMutations.delete(sessionKey);
      return {
        response: 'Canceled. I did not change the database working copy.'
      };
    }

    const databaseMutationIntent = await prepareDatabaseMutation(query, context);
    if (databaseMutationIntent?.response) {
      return databaseMutationIntent;
    }

    if (databaseMutationIntent) {
      const matchedRows = databaseMutationIntent.previewResult.structuredContent?.matchedRows || 0;
      if (!databaseMutationIntent.previewResult.isError && matchedRows > 0) {
        pendingDatabaseMutations.set(sessionKey, {
          applyTool: databaseMutationIntent.applyTool,
          applyParameters: databaseMutationIntent.applyParameters,
          createdAt: Date.now()
        });
      }

      return {
        response: summarizeDatabaseMutationPreview(
          databaseMutationIntent.previewResult,
          databaseMutationIntent.createdSnapshot,
          databaseMutationIntent.fallbackFromDatabaseId
        ),
        toolUsed: databaseMutationIntent.previewTool,
        toolResult: databaseMutationIntent.previewResult
      };
    }

    const mutationIntent = detectDocumentMutationIntent(query, context);
    if (mutationIntent?.error) {
      return { response: mutationIntent.error };
    }

    if (mutationIntent) {
      const toolResult = await executeTool(mutationIntent.previewTool, mutationIntent.previewParameters);
      const matchedRows = toolResult.structuredContent?.matchedRows || 0;

      if (!toolResult.isError && matchedRows > 0) {
        pendingDocumentMutations.set(sessionKey, {
          applyTool: mutationIntent.applyTool,
          applyParameters: mutationIntent.applyParameters,
          createdAt: Date.now()
        });
      }

      return {
        response: summarizeMutationPreview(toolResult),
        toolUsed: mutationIntent.previewTool,
        toolResult
      };
    }

    const databaseQuestionResult = await runDatabaseQuestion(query, context);
    if (databaseQuestionResult) return databaseQuestionResult;

    const directIntent = directToolIntent(query, context);
    if (directIntent) {
      const selectedIntent = enforceSelectedContextOnIntent(directIntent, context);
      const toolResult = await executeTool(selectedIntent.tool, selectedIntent.parameters);
      return {
        response: summarizeDirectToolResult(selectedIntent.tool, toolResult),
        toolUsed: selectedIntent.tool,
        toolResult
      };
    }

    // 1. Send query to LLM to determine intent/tool
    console.log(`Sending query to Ollama (${MODEL}): "${query}"`);
    
    const intentResponse = await postToOllama({
      prompt: `User Query: "${query}"${contextInstructions(context)}\n\nBased on your instructions, output the JSON to call a tool, or respond normally if no tool is needed.`,
      system: systemPrompt,
      stream: false,
      format: 'json'
    });

    const llmOutput = intentResponse.data.response.trim();
    console.log('LLM Intent Output:', llmOutput);

    let parsedIntent;
    try {
      parsedIntent = JSON.parse(llmOutput);
    } catch (e) {
      // If not JSON, assume it's a normal conversational response
      return { response: formatModelAnswer(llmOutput) };
    }

    // 2. If JSON, execute the tool
    if (parsedIntent.tool) {
      parsedIntent = enforceSelectedContextOnIntent(parsedIntent, context);
      if (!knownToolNames.has(parsedIntent.tool)) {
        return {
          response: `I could not use "${parsedIntent.tool}" because it is not a valid MCP tool. Ask me to describe the selected database first, then ask using one of its table/collection fields.`
        };
      }

      const toolResult = await executeTool(parsedIntent.tool, parsedIntent.parameters || {});
      if (toolResult.isError) {
        return {
          response: summarizeDirectToolResult(parsedIntent.tool, toolResult),
          toolUsed: parsedIntent.tool,
          toolResult
        };
      }
      
      // 3. Send tool result back to LLM to generate final natural language response
      const finalPrompt = `User Query: "${query}"
Tool Used: ${parsedIntent.tool}
Tool Result: ${JSON.stringify(toolResult)}
${contextInstructions(context)}

Please provide a helpful, natural language response to the user based on the tool result. Use the corrected prompt and keywords from the prompt layer. Keep it concise. If the tool returned an error, explain the error and what information or access is needed.`;

      const finalResponse = await postToOllama({
        prompt: finalPrompt,
        system: "You are a helpful database MCP assistant. Always format the final answer with short sections:\nAnswer\n- direct result\n\nDetails\n- source, matched rows, filters, or tool context\n\nNext\n- only include actions the user must take. Do not dump raw JSON unless the user asks for JSON. If rows are displayed in the UI table, summarize what the rows contain.",
        stream: false
      });

      return { response: formatModelAnswer(finalResponse.data.response), toolUsed: parsedIntent.tool, toolResult };
    }

    if (parsedIntent.tool_name || parsedIntent.name || parsedIntent.value || parsedIntent.context) {
      return {
        response: 'I could not map that to a valid MCP tool. Please ask with the table/collection name or field name, or ask me to describe the selected database first.'
      };
    }

    return { response: formatModelAnswer(parsedIntent.response || parsedIntent.answer || llmOutput) };

  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Error in agent processQuery:', detail);
    return { error: `Failed to process query through AI Agent: ${detail}` };
  }
};

const processQuery = async (query, context = {}) => {
  const subqueries = splitCompoundQuery(query);
  if (subqueries.length <= 1) {
    const promptRewrite = await preparePromptForQuery(query, context);
    const promptContext = { ...context, promptRewrite };
    const result = await processSingleQuery(promptRewrite.optimized, promptContext);
    return shouldExposePromptRewrite(promptRewrite) ? { ...result, promptRewrite } : result;
  }

  const sessionKey = getSessionKey(context);
  let pendingCreatedDuringBatch = false;
  const results = [];

  for (const subquery of subqueries) {
    if ((isConfirmMessage(subquery) || isCancelMessage(subquery)) && pendingCreatedDuringBatch) {
      results.push({
        query: subquery,
        result: {
          response: 'I prepared an edit above. Please send "confirm" in a new message after reviewing the preview, or send "cancel" to discard it.'
        }
      });
      continue;
    }

    const beforeDocumentMutation = pendingDocumentMutations.get(sessionKey);
    const beforeDatabaseMutation = pendingDatabaseMutations.get(sessionKey);
    const promptRewrite = await preparePromptForQuery(subquery, context);
    const promptContext = { ...context, promptRewrite };
    const result = await processSingleQuery(promptRewrite.optimized, promptContext);
    const exposePromptRewrite = shouldExposePromptRewrite(promptRewrite);
    results.push({
      query: subquery,
      promptRewrite: exposePromptRewrite ? promptRewrite : undefined,
      result: exposePromptRewrite ? { ...result, promptRewrite } : result
    });

    const afterDocumentMutation = pendingDocumentMutations.get(sessionKey);
    const afterDatabaseMutation = pendingDatabaseMutations.get(sessionKey);
    if (
      (afterDocumentMutation && afterDocumentMutation !== beforeDocumentMutation) ||
      (afterDatabaseMutation && afterDatabaseMutation !== beforeDatabaseMutation)
    ) {
      pendingCreatedDuringBatch = true;
    }
  }

  const tools = results
    .map((item) => item.result?.toolUsed)
    .filter(Boolean);

  return {
    response: formatMultiQueryResponse(results),
    toolUsed: tools.length > 0 ? Array.from(new Set(tools)).join(', ') : undefined,
    toolResult: {
      multiple: true,
      queries: results.map((item) => ({
        query: item.query,
        promptRewrite: item.promptRewrite,
        toolUsed: item.result?.toolUsed,
        toolResult: item.result?.toolResult,
        error: item.result?.error
      }))
    },
    promptRewrite: results.some((item) => item.promptRewrite)
      ? results.map((item) => item.promptRewrite).filter(Boolean)
      : undefined,
    isError: results.some((item) => item.result?.isError || item.result?.error)
  };
};

module.exports = { processQuery, optimizePrompt, preparePromptForQuery };
