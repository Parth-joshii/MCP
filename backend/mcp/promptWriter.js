const MAX_PROMPT_LENGTH = Number(process.env.MCP_PROMPT_WRITER_MAX_LENGTH || 600);

const typoReplacements = [
  [/\bteh\b/gi, 'the'],
  [/\baare\b/gi, 'are'],
  [/\bplz\b|\bpls\b/gi, 'please'],
  [/\bdatebase\b|\bdatabse\b|\bdatbase\b/gi, 'database'],
  [/\bdocumnet\b|\bdocment\b/gi, 'document'],
  [/\bqunatity\b|\bquantiy\b|\bqty\b/gi, 'quantity'],
  [/\bprodcut\b|\bprdct\b/gi, 'product'],
  [/\bcust\b|\bcustmer\b|\bcoustomer\b/gi, 'customer'],
  [/\bacct\b|\baccnt\b/gi, 'account'],
  [/\btxn\b|\btrxn\b/gi, 'transaction'],
  [/\bamt\b/gi, 'amount'],
  [/\bbal\b/gi, 'balance'],
  [/\bcoloumn\b|\bcloumn\b|\bcolmn\b/gi, 'column'],
  [/\bstatuz\b|\bstauts\b/gi, 'status'],
  [/\bpayement\b/gi, 'payment'],
  [/\bgrater\b|\bgretar\b/gi, 'greater'],
  [/\blesser\b/gi, 'less'],
  [/\bbetwen\b|\bbtween\b/gi, 'between'],
  [/\beqaul\b|\bequel\b/gi, 'equal'],
  [/\bgreater\s+then\b/gi, 'greater than'],
  [/\bmore\s+then\b/gi, 'more than'],
  [/\bless\s+then\b/gi, 'less than'],
  [/\bwho['’]?s\b|\bwhos\b/gi, 'whose']
];

const phraseReplacements = [
  [/\bhow much rows\b/gi, 'how many rows'],
  [/\bhow many row\b/gi, 'how many rows'],
  [/\bnumber of row\b/gi, 'number of rows'],
  [/\bcustomer names\b/gi, 'customer_name'],
  [/\bcustomer name\b/gi, 'customer_name'],
  [/\baccount type\b/gi, 'account_type'],
  [/\baccount id\b/gi, 'account_id'],
  [/\border id\b/gi, 'order_id'],
  [/\btransaction id\b/gi, 'transaction_id'],
  [/\bpayment method\b/gi, 'payment_method'],
  [/\bsale amount\b|\bsales amount\b/gi, 'sales amount'],
  [/\bwhat all\b/gi, 'show'],
  [/\bshow me all\b/gi, 'show'],
  [/\bgive me all\b/gi, 'show'],
  [/\bin the date\b/gi, 'on date'],
  [/\bin date\b/gi, 'on date'],
  [/\bwhere date\b/gi, 'where date'],
  [/\bfull table format\b/gi, 'table'],
  [/\btable format\b/gi, 'table']
];

const normalizeOperators = (text) => text
  .replace(/>=/g, ' greater than or equal to ')
  .replace(/<=/g, ' less than or equal to ')
  .replace(/!=/g, ' not equal to ')
  .replace(/>/g, ' greater than ')
  .replace(/</g, ' less than ')
  .replace(/\s+[-:]\s+/g, ' equals ')
  .replace(/\s+=\s+/g, ' equals ');

const trimFiller = (text) => text
  .replace(/^(?:hey|hello|hi|please|can you|could you|would you|i want to|i need to)\s+/i, '')
  .replace(/\s+(?:please|pls)\s*$/i, '')
  .trim();

const normalizeSpacing = (text) => text
  .replace(/[ \t]+/g, ' ')
  .replace(/\s+([?,.])/g, '$1')
  .replace(/([?,.]){2,}/g, '$1')
  .trim();

const addActionHint = (text, context = {}) => {
  const normalized = text.toLowerCase();
  const hasQuestionAction = /^(what|which|who|when|where|how many|count|number of|show|list|find|get|tell|give|provide|search|describe|change|update|set|replace|edit|delete|add|confirm|cancel)\b/.test(normalized);
  if (hasQuestionAction) return text;

  if (context.scope === 'document') {
    return `show ${text}`;
  }

  if (context.scope === 'database') {
    return `show ${text}`;
  }

  return text;
};

const shortenPrompt = (text) => {
  if (text.length <= MAX_PROMPT_LENGTH) return text;
  return text.slice(0, MAX_PROMPT_LENGTH).replace(/\s+\S*$/, '').trim();
};

const applyReplacements = (text, replacements, notes) => {
  let rewritten = text;

  for (const [pattern, replacement] of replacements) {
    const before = rewritten;
    rewritten = rewritten.replace(pattern, replacement);
    if (before !== rewritten) notes.add('normalized wording');
  }

  return rewritten;
};

const keywordStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'for', 'from',
  'give', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please',
  'provide', 'show', 'tell', 'the', 'this', 'to', 'want', 'what', 'which', 'with',
  'you'
]);

const detectAction = (text = '') => {
  const normalized = text.toLowerCase();
  if (/\b(change|update|set|replace|edit|modify|delete|add)\b/.test(normalized)) return 'mutation';
  if (/\b(total|sum|average|avg|group|top|highest|lowest|count|how many|number of)\b/.test(normalized)) return 'analytics';
  if (/\b(details|detail|record|row|all data|information|info)\b/.test(normalized)) return 'details';
  if (/\b(describe|schema|columns|fields|tables|collections)\b/.test(normalized)) return 'schema';
  if (/\b(search|find)\b/.test(normalized)) return 'search';
  return 'query';
};

const detectSource = (context = {}, text = '') => {
  if (context.scope && context.scope !== 'auto') return context.scope;
  const normalized = text.toLowerCase();
  if (/\b(pdf|word|docx|excel|csv|file|document|sheet)\b/.test(normalized)) return 'document';
  if (/\b(database|mongodb|mongo|collection|table)\b/.test(normalized)) return 'database';
  return 'auto';
};

const extractDates = (text = '') => Array.from(new Set(String(text).match(/\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/g) || []));

const cleanComparisonField = (field = '') => String(field)
  .replace(/^.*\b(?:of|for|where|with|and)\s+/i, '')
  .replace(/^(?:show|provide|details|detail|get|find|list|tell|me|the|a|an)\s+/i, '')
  .trim();

const cleanComparisonValue = (value = '') => String(value)
  .replace(/\s+and\s+.*$/i, '')
  .trim();

const extractComparisons = (text = '') => {
  const comparisons = [];
  const prefix = '(?:^|\\b(?:and|where|with|for|on|in)\\s+)';
  const field = '([a-zA-Z_][\\w]*(?:\\s+[a-zA-Z_][\\w]*){0,8})';
  const value = '([a-zA-Z0-9./-]+(?:\\s+[a-zA-Z0-9./-]+){0,4})';
  const patterns = [
    ['>=', new RegExp(`${prefix}${field}\\s+greater than or equal to\\s+${value}`, 'gi')],
    ['<=', new RegExp(`${prefix}${field}\\s+less than or equal to\\s+${value}`, 'gi')],
    ['>', new RegExp(`${prefix}${field}\\s+(?:greater than|more than|above|over)\\s+${value}`, 'gi')],
    ['<', new RegExp(`${prefix}${field}\\s+(?:less than|below|under)\\s+${value}`, 'gi')],
    ['=', new RegExp(`${prefix}${field}\\s+equals\\s+${value}`, 'gi')]
  ];

  for (const [operator, pattern] of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const normalizedField = cleanComparisonField(match[1]);
      const normalizedValue = cleanComparisonValue(match[2]);
      if (!normalizedField || !normalizedValue) continue;
      comparisons.push({
        field: normalizedField,
        operator,
        value: normalizedValue
      });
    }
  }

  return comparisons.slice(0, 8);
};

const extractTerms = (text = '') => Array.from(new Set(String(text)
  .toLowerCase()
  .replace(/[^a-z0-9_./-\s]+/g, ' ')
  .split(/\s+/)
  .filter((term) => term.length > 2 && !keywordStopWords.has(term))
)).slice(0, 16);

const extractKeywords = (original, optimized, context = {}) => ({
  action: detectAction(optimized),
  source: detectSource(context, optimized),
  dates: extractDates(optimized),
  comparisons: extractComparisons(optimized),
  terms: extractTerms(optimized)
});

const formatPromptLayerForModel = (promptRewrite = {}) => {
  if (!promptRewrite.keywords) return '';
  const { keywords } = promptRewrite;
  const lines = [
    `${promptRewrite.llmEnhanced ? 'AI-enhanced prompt' : 'Corrected prompt'}: ${promptRewrite.optimized || promptRewrite.original || ''}`,
    promptRewrite.llmEnhanced && promptRewrite.deterministicOptimized
      ? `Fast rewrite before AI: ${promptRewrite.deterministicOptimized}`
      : null,
    `Detected action: ${keywords.action || 'query'}`,
    `Detected source: ${keywords.source || 'auto'}`,
    keywords.terms?.length ? `Keywords: ${keywords.terms.join(', ')}` : null,
    promptRewrite.enhancerKeywords?.length ? `AI prompt keywords: ${promptRewrite.enhancerKeywords.join(', ')}` : null,
    keywords.dates?.length ? `Dates: ${keywords.dates.join(', ')}` : null,
    keywords.comparisons?.length ? `Conditions: ${keywords.comparisons.map((item) => `${item.field} ${item.operator} ${item.value}`).join(', ')}` : null
  ].filter(Boolean);

  return lines.length ? `\n\nPROMPT LAYER:\n${lines.join('\n')}` : '';
};

const optimizePrompt = (prompt, context = {}) => {
  const original = String(prompt || '').trim();
  const notes = new Set();

  if (!original) {
    return {
      original,
      optimized: original,
      changed: false,
      notes: [],
      keywords: extractKeywords(original, original, context)
    };
  }

  const confirmation = original.match(/^(yes|y|confirm|apply|do it|ok|okay|save|no|n|cancel|stop|discard|never mind)(?:\s+(?:please|pls))?$/i);
  if (confirmation) {
    const optimized = confirmation[1].toLowerCase();
    return {
      original,
      optimized,
      changed: optimized !== original,
      notes: optimized !== original ? ['normalized confirmation'] : [],
      keywords: extractKeywords(original, optimized, context)
    };
  }

  if (/^(hi|hello|hey|thanks|thank you|ok|okay)$/i.test(original)) {
    return {
      original,
      optimized: original,
      changed: false,
      notes: [],
      keywords: extractKeywords(original, original, context)
    };
  }

  let optimized = normalizeSpacing(original);
  optimized = trimFiller(optimized);
  optimized = applyReplacements(optimized, typoReplacements, notes);
  optimized = applyReplacements(optimized, phraseReplacements, notes);
  optimized = trimFiller(optimized);

  const beforeOperators = optimized;
  optimized = normalizeOperators(optimized);
  if (beforeOperators !== optimized) notes.add('expanded comparison operators');

  optimized = normalizeSpacing(optimized);
  optimized = addActionHint(optimized, context);

  const beforeShorten = optimized;
  optimized = shortenPrompt(normalizeSpacing(optimized));
  if (beforeShorten !== optimized) notes.add('shortened long prompt');

  const changed = optimized !== original;
  return {
    original,
    optimized,
    changed,
    notes: Array.from(notes),
    keywords: extractKeywords(original, optimized, context)
  };
};

module.exports = {
  optimizePrompt,
  formatPromptLayerForModel
};
