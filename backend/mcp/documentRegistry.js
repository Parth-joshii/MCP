const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const pdfParseModule = require('pdf-parse');
const mammoth = require('mammoth');

const DOCUMENT_ROOT = process.env.MCP_DOCUMENT_ROOT
  ? path.resolve(process.env.MCP_DOCUMENT_ROOT)
  : path.resolve(__dirname, '..', '..', 'document-store');

const UPLOAD_DIR = path.join(DOCUMENT_ROOT, 'uploads');
const ORIGINAL_DIR = path.join(DOCUMENT_ROOT, 'originals');
const WORKING_DIR = path.join(DOCUMENT_ROOT, 'working');
const INDEX_PATH = path.join(DOCUMENT_ROOT, 'documents.json');
const DEFAULT_CHUNK_SIZE = Number(process.env.MCP_DOCUMENT_CHUNK_SIZE || 1200);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.MCP_DOCUMENT_CHUNK_OVERLAP || 160);

const ensureDocumentStore = () => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(ORIGINAL_DIR, { recursive: true });
  fs.mkdirSync(WORKING_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_PATH)) {
    fs.writeFileSync(INDEX_PATH, JSON.stringify([], null, 2));
  }
};

const safeId = (value) => {
  const base = path.basename(value, path.extname(value))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'document';
  return `${base}-${Date.now()}`;
};

const copyNameFor = (id, variant, extension) => `${id}-${variant}${extension || ''}`;

const readIndex = () => {
  ensureDocumentStore();
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
};

const writeIndex = (docs) => {
  ensureDocumentStore();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(docs, null, 2));
};

const getDocument = (documentId) => {
  const doc = readIndex().find((item) => item.id === documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);
  return doc;
};

const normalizeText = (text = '') => text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

const parsePdfBuffer = async (buffer) => {
  if (typeof pdfParseModule === 'function') {
    return pdfParseModule(buffer);
  }

  if (typeof pdfParseModule.default === 'function') {
    return pdfParseModule.default(buffer);
  }

  if (typeof pdfParseModule.PDFParse === 'function') {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return {
        numpages: result.total || result.pages?.length || 0,
        text: result.text || ''
      };
    } finally {
      await parser.destroy?.();
    }
  }

  throw new Error('Installed pdf-parse package does not expose a supported parser.');
};

const chunkText = (text, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) => {
  const normalized = normalizeText(text);
  const chunks = [];

  if (!normalized) return chunks;

  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    const textChunk = normalized.slice(start, end).trim();
    if (textChunk) {
      chunks.push({
        index: chunks.length,
        start,
        end,
        text: textChunk
      });
    }
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
};

const parseCsv = (filePath) => {
  const workbook = xlsx.readFile(filePath, { type: 'file', raw: true });
  return parseWorkbook(workbook);
};

const parseWorkbook = (workbook) => {
  const sheets = workbook.SheetNames.map((name) => {
    const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null });
    const { columns, rows } = rowsFromSheetArray(rawRows);
    return {
      name,
      rowCount: rows.length,
      columns,
      rows
    };
  });

  return {
    kind: 'table',
    sheets,
    text: sheets.map((sheet) => `${sheet.name}\n${JSON.stringify(sheet.rows.slice(0, 100), null, 2)}`).join('\n\n')
  };
};

const looksLikeDate = (value) => /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(String(value ?? '').trim());

const looksLikeHeaderRow = (row = []) => {
  const filled = row.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (filled.length === 0) return false;

  const headerLike = filled.filter((value) => {
    const text = String(value).trim();
    return Number.isNaN(Number(text.replace(/,/g, ''))) && !looksLikeDate(text);
  });

  return headerLike.length / filled.length >= 0.75;
};

const inferColumns = (row = []) => {
  if (
    row.length === 8 &&
    looksLikeDate(row[0]) &&
    typeof row[1] === 'string' &&
    typeof row[2] === 'string' &&
    typeof row[3] === 'string' &&
    typeof row[4] === 'string'
  ) {
    return ['Sale Date', 'Region', 'State', 'City', 'Product', 'Quantity', 'Price per Unit', 'Sales Amount'];
  }

  return row.map((_, index) => `Column ${index + 1}`);
};

const rowsFromSheetArray = (rawRows = []) => {
  const nonEmptyRows = rawRows.filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ''));
  if (nonEmptyRows.length === 0) return { columns: [], rows: [] };

  const hasHeader = looksLikeHeaderRow(nonEmptyRows[0]);
  const columns = hasHeader
    ? nonEmptyRows[0].map((value, index) => String(value || `Column ${index + 1}`).trim())
    : inferColumns(nonEmptyRows[0]);
  const dataRows = hasHeader ? nonEmptyRows.slice(1) : nonEmptyRows;

  const rows = dataRows.map((row) => {
    return columns.reduce((acc, column, index) => {
      acc[column] = row[index] ?? null;
      return acc;
    }, {});
  });

  return { columns, rows };
};

const parseDocumentFile = async (filePath, originalName, mimeType) => {
  const ext = path.extname(originalName).toLowerCase();

  if (['.xlsx', '.xls'].includes(ext)) {
    return parseWorkbook(xlsx.readFile(filePath));
  }

  if (ext === '.csv') {
    return parseCsv(filePath);
  }

  if (ext === '.pdf') {
    const data = await parsePdfBuffer(fs.readFileSync(filePath));
    return {
      kind: 'text',
      pageCount: data.numpages,
      text: data.text || ''
    };
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      kind: 'text',
      text: result.value || '',
      warnings: result.messages || []
    };
  }

  if (['.txt', '.md', '.json'].includes(ext) || /^text\//.test(mimeType || '')) {
    return {
      kind: 'text',
      text: fs.readFileSync(filePath, 'utf8')
    };
  }

  throw new Error(`Unsupported document type: ${ext || mimeType}`);
};

const safeSheetName = (name, fallback) => {
  const cleaned = String(name || fallback || 'Sheet1').replace(/[\[\]:*?/\\]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
};

const exportCellValue = (column, value) => {
  if (/date/i.test(String(column || '')) && typeof value === 'number' && value > 20000 && value < 80000) {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) {
      return `${String(parsed.d).padStart(2, '0')}-${String(parsed.m).padStart(2, '0')}-${parsed.y}`;
    }
  }

  return value;
};

const sheetToWorksheet = (sheet) => {
  const columns = sheet.columns || [];
  const rows = (sheet.rows || []).map((row) => columns.reduce((acc, column) => {
    acc[column] = exportCellValue(column, row[column]) ?? null;
    return acc;
  }, {}));

  return xlsx.utils.json_to_sheet(rows, { header: columns });
};

const writeTableFile = (doc, filePath) => {
  if (doc.kind !== 'table') return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (doc.extension === '.csv') {
    const sheet = doc.sheets?.[0] || { columns: [], rows: [] };
    const csv = xlsx.utils.sheet_to_csv(sheetToWorksheet(sheet));
    fs.writeFileSync(filePath, csv);
    return;
  }

  const workbook = xlsx.utils.book_new();
  const usedNames = new Set();

  for (const [index, sheet] of (doc.sheets || []).entries()) {
    let name = safeSheetName(sheet.name, `Sheet${index + 1}`);
    while (usedNames.has(name)) {
      const suffix = `_${usedNames.size + 1}`;
      name = `${name.slice(0, 31 - suffix.length)}${suffix}`;
    }
    usedNames.add(name);
    xlsx.utils.book_append_sheet(workbook, sheetToWorksheet(sheet), name);
  }

  if ((doc.sheets || []).length === 0) {
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([]), 'Sheet1');
  }

  xlsx.writeFile(workbook, filePath);
};

const ensureDocumentCopies = (doc) => {
  let changed = false;
  const extension = doc.extension || path.extname(doc.name || '');

  if (!doc.originalPath) {
    const originalPath = path.join(ORIGINAL_DIR, copyNameFor(doc.id, 'original', extension));
    if (doc.storedPath && fs.existsSync(doc.storedPath) && path.resolve(doc.storedPath) !== path.resolve(originalPath)) {
      fs.copyFileSync(doc.storedPath, originalPath);
    } else if (doc.workingPath && fs.existsSync(doc.workingPath) && path.resolve(doc.workingPath) !== path.resolve(originalPath)) {
      fs.copyFileSync(doc.workingPath, originalPath);
    } else if (doc.kind === 'table') {
      writeTableFile(doc, originalPath);
    }
    doc.originalPath = originalPath;
    changed = true;
  }

  if (!doc.workingPath) {
    doc.workingPath = path.join(WORKING_DIR, copyNameFor(doc.id, 'working', extension));
    if (doc.kind === 'table') {
      writeTableFile(doc, doc.workingPath);
    } else if (doc.originalPath && fs.existsSync(doc.originalPath)) {
      fs.copyFileSync(doc.originalPath, doc.workingPath);
    }
    doc.storedPath = doc.workingPath;
    changed = true;
  }

  return changed;
};

const rewriteWorkingCopy = (doc) => {
  ensureDocumentCopies(doc);
  if (doc.kind === 'table') {
    writeTableFile(doc, doc.workingPath);
  }
  doc.storedPath = doc.workingPath;
};

const getDocumentWithPersistedCopies = (documentId) => {
  const docs = readIndex();
  const documentIndex = docs.findIndex((item) => item.id === documentId);
  if (documentIndex === -1) throw new Error(`Document not found: ${documentId}`);

  const doc = docs[documentIndex];
  const changed = ensureDocumentCopies(doc);
  if (changed) {
    docs[documentIndex] = doc;
    writeIndex(docs);
  }

  return doc;
};

const saveUploadedDocument = async (file) => {
  ensureDocumentStore();
  const id = safeId(file.originalname);
  const ext = path.extname(file.originalname).toLowerCase();
  const originalPath = path.join(ORIGINAL_DIR, copyNameFor(id, 'original', ext));
  const workingPath = path.join(WORKING_DIR, copyNameFor(id, 'working', ext));

  fs.renameSync(file.path, originalPath);
  fs.copyFileSync(originalPath, workingPath);

  const parsed = await parseDocumentFile(workingPath, file.originalname, file.mimetype);
  const text = parsed.text || '';
  const chunks = chunkText(text);
  const document = {
    id,
    name: file.originalname,
    mimeType: file.mimetype,
    extension: ext,
    kind: parsed.kind,
    originalPath,
    workingPath,
    storedPath: workingPath,
    uploadedAt: new Date().toISOString(),
    updatedAt: null,
    size: file.size,
    textLength: text.length,
    chunkCount: chunks.length,
    sheetCount: parsed.sheets?.length || 0,
    pageCount: parsed.pageCount,
    sheets: parsed.sheets,
    chunks,
    warnings: parsed.warnings
  };

  const docs = readIndex().filter((item) => item.id !== id);
  docs.push(document);
  writeIndex(docs);

  return summarizeDocument(document);
};

const summarizeDocument = (doc) => ({
  id: doc.id,
  name: doc.name,
  mimeType: doc.mimeType,
  extension: doc.extension,
  kind: doc.kind,
  uploadedAt: doc.uploadedAt,
  updatedAt: doc.updatedAt,
  size: doc.size,
  textLength: doc.textLength,
  chunkCount: doc.chunkCount,
  sheetCount: doc.sheetCount,
  pageCount: doc.pageCount,
  sheets: doc.sheets?.map((sheet) => {
    const normalizedSheet = normalizeStoredSheet(sheet);
    return {
      name: normalizedSheet.name,
      rowCount: normalizedSheet.rowCount,
      columns: normalizedSheet.columns
    };
  }),
  copies: {
    original: {
      fileName: `${doc.id}-original${doc.extension || ''}`,
      downloadPath: `/api/documents/${doc.id}/download/original`
    },
    working: {
      fileName: `${doc.id}-working${doc.extension || ''}`,
      downloadPath: `/api/documents/${doc.id}/download/working`
    }
  },
  warnings: doc.warnings
});

const listDocuments = () => readIndex().map(summarizeDocument);

const describeDocument = (documentId) => summarizeDocument(getDocument(documentId));

const listResources = () => {
  const resources = [];

  for (const doc of readIndex()) {
    resources.push({
      uri: `document://${doc.id}/metadata`,
      name: `${doc.name} metadata`,
      description: `Metadata for ${doc.name}`,
      mimeType: 'application/json'
    });

    if (doc.kind === 'table') {
      for (const sheet of doc.sheets || []) {
        resources.push({
          uri: `document://${doc.id}/sheets/${encodeURIComponent(sheet.name)}`,
          name: `${doc.name} - ${sheet.name}`,
          description: `Rows from sheet ${sheet.name}`,
          mimeType: 'application/json'
        });
      }
    }

    for (const chunk of doc.chunks || []) {
      resources.push({
        uri: `document://${doc.id}/chunks/${chunk.index}`,
        name: `${doc.name} chunk ${chunk.index}`,
        description: `Text chunk ${chunk.index} from ${doc.name}`,
        mimeType: 'text/plain'
      });
    }
  }

  return resources;
};

const readResource = (uri) => {
  const match = /^document:\/\/([^/]+)\/(.+)$/.exec(uri || '');
  if (!match) throw new Error(`Unsupported document resource URI: ${uri}`);

  const doc = getDocument(match[1]);
  const rest = match[2];

  if (rest === 'metadata') {
    const metadata = describeDocument(doc.id);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(metadata, null, 2) }],
      structuredContent: metadata
    };
  }

  if (rest.startsWith('sheets/')) {
    const sheetName = decodeURIComponent(rest.slice('sheets/'.length));
    const sheet = (doc.sheets || []).find((item) => item.name === sheetName);
    if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(sheet, null, 2) }],
      structuredContent: sheet
    };
  }

  if (rest.startsWith('chunks/')) {
    const index = Number(rest.slice('chunks/'.length));
    const chunk = (doc.chunks || []).find((item) => item.index === index);
    if (!chunk) throw new Error(`Chunk not found: ${index}`);
    return {
      contents: [{ uri, mimeType: 'text/plain', text: chunk.text }],
      structuredContent: chunk
    };
  }

  throw new Error(`Unknown document resource URI: ${uri}`);
};

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'could',
  'do',
  'does',
  'file',
  'for',
  'from',
  'give',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'pdf',
  'please',
  'show',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'want',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'word',
  'you'
]);

const tokenize = (value = '') => normalizeText(value)
  .toLowerCase()
  .split(/[^a-z0-9]+/i)
  .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));

const scoreText = (text, queryTokens) => {
  const lower = normalizeText(text).toLowerCase();
  let score = 0;
  const uniqueTokens = Array.from(new Set(queryTokens || []));

  if (uniqueTokens.length === 0 || !lower) return 0;

  const exactPhrase = uniqueTokens.length > 1 ? uniqueTokens.join(' ') : null;
  if (exactPhrase && lower.includes(exactPhrase)) {
    score += exactPhrase.length * 8;
  }

  for (const token of uniqueTokens) {
    const tokenPattern = new RegExp(`\\b${escapeRegex(token)}\\b`, 'g');
    const exactMatches = lower.match(tokenPattern) || [];
    score += exactMatches.length * (token.length + 6);

    let index = lower.indexOf(token);
    while (index !== -1) {
      score += token.length;
      index = lower.indexOf(token, index + token.length);
    }
  }

  return score;
};

const snippetFromText = (text, queryTokens, maxLength = 500) => {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) return normalized;

  const lower = normalized.toLowerCase();
  const positions = (queryTokens || [])
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0);
  const firstHit = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, firstHit - Math.floor(maxLength / 3));
  const end = Math.min(normalized.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
};

const rankTextChunks = (doc, query, limit = 5) => {
  const queryTokens = tokenize(query);
  return (doc.chunks || [])
    .map((chunk) => ({
      documentId: doc.id,
      documentName: doc.name,
      chunkIndex: chunk.index,
      score: scoreText(chunk.text, queryTokens),
      text: chunk.text,
      snippet: snippetFromText(chunk.text, queryTokens, 600),
      uri: `document://${doc.id}/chunks/${chunk.index}`
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)
    .slice(0, Number(limit) || 5);
};

const splitTextEvidenceSegments = (text) => {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  const segments = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    if (current.length > 12) segments.push(current);

    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    if (previous && previous.length <= 80 && current.length > 12) {
      segments.push(`${previous}: ${current}`);
    }
    if (current.length <= 80 && next && next.length > 12) {
      segments.push(`${current}: ${next}`);
    }

    for (const sentence of current
      .replace(/([.!?])\s+/g, '$1\n')
      .split(/\n+/)
      .map((part) => normalizeText(part))
      .filter((part) => part.length > 24)) {
      segments.push(sentence);
    }
  }

  return Array.from(new Set(segments));
};

const isMajorHeadingBlock = (block) => {
  const text = normalizeText(block);
  return text.length > 1 && text.length <= 80 && text === text.toUpperCase() && /[A-Z]/.test(text);
};

const extractHeadingSections = (text, queryTokens) => {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  const sections = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.length > 120 || scoreText(block, queryTokens) === 0) continue;

    const sectionBlocks = [block];
    let sectionLength = block.length;

    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      const nextBlock = blocks[cursor];
      if (cursor > index + 1 && isMajorHeadingBlock(nextBlock)) break;
      if (sectionLength + nextBlock.length > 1400) break;

      sectionBlocks.push(nextBlock);
      sectionLength += nextBlock.length;
    }

    if (sectionBlocks.length > 1) {
      sections.push(sectionBlocks.join('\n'));
    }
  }

  return sections;
};

const buildExtractiveTextAnswer = (question, chunks, limit = 4) => {
  const queryTokens = tokenize(question);
  const segments = [];

  for (const chunk of chunks) {
    for (const sectionText of extractHeadingSections(chunk.text, queryTokens)) {
      segments.push({
        text: sectionText,
        score: scoreText(sectionText, queryTokens) + 100,
        chunkIndex: chunk.chunkIndex,
        uri: chunk.uri
      });
    }

    for (const segment of splitTextEvidenceSegments(chunk.text)) {
      const score = scoreText(segment, queryTokens);
      if (score > 0) {
        segments.push({
          text: segment,
          score,
          chunkIndex: chunk.chunkIndex,
          uri: chunk.uri
        });
      }
    }
  }

  const ranked = segments
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.text === item.text) === index);
  const selected = [];

  for (const item of ranked) {
    const normalizedItem = normalizeText(item.text).toLowerCase();
    const overlapsExisting = selected.some((existing) => {
      const normalizedExisting = normalizeText(existing.text).toLowerCase();
      return normalizedExisting.includes(normalizedItem) || normalizedItem.includes(normalizedExisting);
    });

    if (!overlapsExisting) selected.push(item);
    if (selected.length >= (Number(limit) || 4)) break;
  }

  if (selected[0]?.text.includes('\n') && selected[0].text.length > 180) {
    return [selected[0]];
  }

  if (selected.length === 0) {
    return chunks.slice(0, 2).map((chunk) => ({
      text: chunk.snippet,
      chunkIndex: chunk.chunkIndex,
      uri: chunk.uri
    }));
  }

  return selected;
};

const titleCaseName = (value = '') => {
  const text = normalizeText(value);
  if (text !== text.toUpperCase()) return text;

  return text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
};

const orderedTextChunks = (doc) => [...(doc.chunks || [])]
  .filter((chunk) => chunk?.text)
  .sort((a, b) => Number(a.start || 0) - Number(b.start || 0) || Number(a.index || 0) - Number(b.index || 0));

const documentFullText = (doc) => {
  const chunks = orderedTextChunks(doc);
  if (chunks.length === 0) return '';

  let text = '';
  let cursor = 0;

  for (const chunk of chunks) {
    const start = Number.isFinite(Number(chunk.start)) ? Number(chunk.start) : cursor;
    const end = Number.isFinite(Number(chunk.end)) ? Number(chunk.end) : start + String(chunk.text || '').length;
    const chunkText = String(chunk.text || '');
    const overlap = Math.max(0, cursor - start);
    const appendText = chunkText.slice(overlap);

    if (start > cursor && text && appendText && !text.endsWith('\n')) {
      text += '\n';
    }

    text += appendText;
    cursor = Math.max(cursor, end);
  }

  return text.trim();
};

const sourceForOffset = (doc, offset = 0) => {
  const chunks = orderedTextChunks(doc);
  const chunk = chunks.find((item) => Number(item.start || 0) <= offset && Number(item.end || 0) >= offset) || chunks[0];
  const chunkIndex = chunk?.index ?? 0;
  return {
    chunkIndex,
    uri: chunk ? `document://${doc.id}/chunks/${chunkIndex}` : `document://${doc.id}/metadata`
  };
};

const documentTextBlocksWithSource = (doc) => {
  const fullText = documentFullText(doc);
  const blocks = [];
  const lineRegex = /[^\n]+/g;
  let match;

  while ((match = lineRegex.exec(fullText)) !== null) {
    const text = normalizeText(match[0]);
    if (!text) continue;
    blocks.push({
      text,
      offset: match.index,
      ...sourceForOffset(doc, match.index)
    });
  }

  return blocks;
};

const documentTextBlocks = (doc) => documentTextBlocksWithSource(doc).map((block) => block.text);

const isLikelyPersonName = (line = '') => {
  const text = normalizeText(line);
  if (!text || text.length > 80) return false;
  if (/[0-9@|:/]/.test(text)) return false;

  const lower = text.toLowerCase();
  const blockedWords = [
    'profile',
    'summary',
    'technical skills',
    'skills',
    'experience',
    'projects',
    'education',
    'certifications',
    'developer',
    'engineer',
    'resume',
    'curriculum vitae'
  ];
  if (blockedWords.some((word) => lower === word || lower.includes(word))) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  return words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word));
};

const extractResumeIdentity = (doc) => {
  const blocksWithSource = documentTextBlocksWithSource(doc);
  const blocks = blocksWithSource.map((block) => block.text);
  const nameBlock = isLikelyPersonName(blocksWithSource[0]?.text) ? blocksWithSource[0] : null;
  const name = nameBlock?.text;
  const fullText = documentFullText(doc) || blocks.join('\n');
  const email = fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null;
  const phone = fullText.match(/(?:\+\d{1,3}[\s-]?)?\d{5}[\s-]?\d{5}|\b\d{10}\b/)?.[0] || null;
  const github = fullText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|,)]+/i)?.[0] || null;
  const linkedin = fullText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,)]+/i)?.[0] || null;

  const contactLine = blocks.slice(0, 12).find((line) => line.includes('|') && (line.includes('@') || /\d/.test(line))) || '';
  const location = contactLine
    .split('|')
    .map((part) => normalizeText(part))
    .find((part) => part && !part.includes('@') && !/\d{5}/.test(part) && !/github|linkedin|http/i.test(part)) || null;

  return {
    name: name ? titleCaseName(name) : null,
    email,
    phone,
    github,
    linkedin,
    location,
    chunkIndex: nameBlock?.chunkIndex ?? blocksWithSource[0]?.chunkIndex ?? 0,
    uri: nameBlock?.uri || blocksWithSource[0]?.uri || `document://${doc.id}/metadata`
  };
};

const FIELD_QUERY_FILLERS = new Set([
  ...SEARCH_STOP_WORDS,
  'about',
  'applicant',
  'am',
  'candidate',
  'data',
  'detail',
  'details',
  'doc',
  'document',
  'extract',
  'field',
  'file',
  'info',
  'information',
  'resume',
  'value'
]);

const singularizeLabel = (value = '') => normalizeLabel(value).replace(/\b([a-z]+)s\b/g, '$1');

const requestedFieldLabels = (question = '') => {
  const normalized = normalizeLabel(question);
  const stripped = normalized
    .replace(/^(?:what is|what are|whats|which is|which are|who is|where is|when is|show me|show|tell me|give me|get|find|list|extract)\s+/, '')
    .replace(/\b(?:from|in|inside|within|on)\s+(?:this|the|my)?\s*(?:document|file|pdf|word|resume)\b.*$/, '')
    .trim();

  const parts = stripped
    .split(/\s+(?:and|or)\s+|[,/&]+/)
    .map((part) => part
      .split(/\s+/)
      .filter((token) => token && !FIELD_QUERY_FILLERS.has(token))
      .join(' ')
      .trim())
    .filter(Boolean);

  const labels = new Set(parts);
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token && !FIELD_QUERY_FILLERS.has(token));
  if (tokens.length > 0) labels.add(tokens.join(' '));

  const aliasMap = {
    name: ['name', 'full name', 'person name', 'candidate name', 'applicant name'],
    email: ['email', 'email address', 'mail id', 'e mail'],
    phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number'],
    contact: ['contact', 'contact details', 'contact information'],
    github: ['github', 'git hub'],
    linkedin: ['linkedin', 'linked in'],
    location: ['location', 'city', 'address'],
    skill: ['skill', 'skills', 'technical skills'],
    project: ['project', 'projects'],
    certification: ['certification', 'certifications', 'certificate', 'certificates'],
    experience: ['experience', 'work experience', 'employment'],
    education: ['education', 'qualification', 'qualifications'],
    profile: ['profile', 'summary', 'objective']
  };

  for (const label of Array.from(labels)) {
    const singular = singularizeLabel(label);
    for (const [key, aliases] of Object.entries(aliasMap)) {
      if (singular === key || aliases.some((alias) => singularizeLabel(alias) === singular || singular.includes(singularizeLabel(alias)))) {
        aliases.forEach((alias) => labels.add(alias));
      }
    }
  }

  return Array.from(labels).filter(Boolean);
};

const labelMatchScore = (label, requested) => {
  const left = normalizeLabel(label);
  const right = normalizeLabel(requested);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (compactLabel(left) === compactLabel(right)) return 98;

  const leftSingular = singularizeLabel(left);
  const rightSingular = singularizeLabel(right);
  if (leftSingular === rightSingular) return 96;
  if (leftSingular.includes(rightSingular) || rightSingular.includes(leftSingular)) return 82;

  const leftTokens = new Set(leftSingular.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(rightSingular.split(/\s+/).filter(Boolean));
  const overlap = Array.from(rightTokens).filter((token) => leftTokens.has(token)).length;
  if (overlap === 0) return 0;

  return Math.round((overlap / Math.max(leftTokens.size, rightTokens.size)) * 70);
};

const isLikelyGenericHeading = (line = '') => {
  const text = normalizeText(line);
  if (!text || text.length > 90 || /[@|]/.test(text) || /[.!?]$/.test(text)) return false;
  if (/^\d+([.)-]|\s)/.test(text)) return false;
  if (text.includes(':')) return false;
  if (/\d/.test(text) && text !== text.toUpperCase()) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) return true;

  const titleLikeWords = words.filter((word) => /^[A-Z][A-Za-z0-9&/().+-]*$/.test(word));
  return words.length <= 5 && titleLikeWords.length / words.length >= 0.6;
};

const createField = (doc, label, value, source = {}) => {
  const text = normalizeText(value ?? '');
  if (!label || !text) return null;
  return {
    label: normalizeText(label),
    value: text,
    chunkIndex: source.chunkIndex ?? 0,
    uri: source.uri || `document://${doc.id}/metadata`,
    scoreBoost: source.scoreBoost || 0
  };
};

const genericKnownFields = (doc) => {
  const identity = extractResumeIdentity(doc);
  const fields = [];
  const add = (label, value) => {
    const field = createField(doc, label, value, {
      chunkIndex: identity.chunkIndex,
      uri: identity.uri,
      scoreBoost: 30
    });
    if (field) fields.push(field);
  };

  add('Name', identity.name);
  add('Email', identity.email);
  add('Phone', identity.phone);
  add('GitHub', identity.github);
  add('LinkedIn', identity.linkedin);
  add('Location', identity.location);

  const contactParts = [
    identity.location && `Location: ${identity.location}`,
    identity.phone && `Phone: ${identity.phone}`,
    identity.email && `Email: ${identity.email}`,
    identity.github && `GitHub: ${identity.github}`,
    identity.linkedin && `LinkedIn: ${identity.linkedin}`
  ].filter(Boolean);
  add('Contact', contactParts.join('\n'));

  return fields;
};

const genericKeyValueFields = (doc) => {
  const blocks = documentTextBlocksWithSource(doc);
  const fields = [];

  for (const block of blocks) {
    const sameLine = block.text.match(/^([^:：]{2,80})\s*[:：]\s*(.{1,1200})$/);
    if (sameLine) {
      const field = createField(doc, sameLine[1], sameLine[2], block);
      if (field) fields.push(field);
      continue;
    }

    const dashLine = block.text.match(/^([A-Za-z][A-Za-z0-9 /_.&()-]{1,60})\s+[–—-]\s+(.{2,1200})$/);
    if (dashLine) {
      const field = createField(doc, dashLine[1], dashLine[2], block);
      if (field) fields.push(field);
    }
  }

  return fields;
};

const genericSectionFields = (doc) => {
  const blocks = documentTextBlocksWithSource(doc);
  const fields = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const heading = blocks[index];
    if (!isLikelyGenericHeading(heading.text)) continue;
    const headingIsMajor = isMajorHeadingBlock(heading.text);

    const values = [];
    let valueLength = 0;

    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      const next = blocks[cursor];
      const nextStartsNewSection = headingIsMajor
        ? isMajorHeadingBlock(next.text)
        : isLikelyGenericHeading(next.text);
      if (cursor > index + 1 && nextStartsNewSection) break;
      if (valueLength + next.text.length > 1800) break;

      values.push(next.text);
      valueLength += next.text.length;
    }

    if (values.length > 0) {
      const field = createField(doc, heading.text, values.join('\n'), {
        chunkIndex: heading.chunkIndex,
        uri: heading.uri,
        scoreBoost: 20
      });
      if (field) fields.push(field);
    }
  }

  return fields;
};

const genericDocumentFields = (doc) => [
  ...genericKnownFields(doc),
  ...genericKeyValueFields(doc),
  ...genericSectionFields(doc)
];

const answerExtractedTextField = (doc, question) => {
  const requestedLabels = requestedFieldLabels(question);
  if (requestedLabels.length === 0) return null;

  const fields = genericDocumentFields(doc);
  const matches = [];

  for (const requested of requestedLabels) {
    const best = fields
      .map((field) => ({
        ...field,
        score: labelMatchScore(field.label, requested) + (field.scoreBoost || 0)
      }))
      .filter((field) => field.score >= 62)
      .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0];

    if (best && !matches.some((match) => normalizeLabel(match.label) === normalizeLabel(best.label))) {
      matches.push(best);
    }
  }

  if (matches.length === 0) return null;

  const answers = matches
    .slice(0, 5)
    .map((field) => `${field.label}: ${field.value}`);

  return {
    answer: answers.join('\n'),
    evidence: matches.slice(0, 5).map((field) => ({
      text: `${field.label}: ${field.value}`,
      chunkIndex: field.chunkIndex,
      uri: field.uri
    }))
  };
};

const fallbackToTopDocumentIdentity = (doc, question) => {
  const normalized = normalizeText(question).toLowerCase();
  if (!/\b(who am i|my name|candidate name|applicant name|person name|resume name|whose resume)\b/.test(normalized)) {
    return null;
  }

  const identity = extractResumeIdentity(doc);
  if (!identity.name) return null;

  const text = `Name: ${identity.name}`;
  return {
    answer: text,
    evidence: [{
      text,
      chunkIndex: identity.chunkIndex,
      uri: identity.uri
    }]
  };
};

const searchDocuments = ({ query, documentId, limit = 5 }) => {
  if (!query) throw new Error('query is required.');
  const queryTokens = tokenize(query);
  const docs = documentId ? [getDocument(documentId)] : readIndex();
  const results = [];

  for (const doc of docs) {
    results.push(...rankTextChunks(doc, query, Number(limit) || 5));

    for (const sheet of doc.sheets || []) {
      sheet.rows.forEach((row, rowIndex) => {
        const rowText = JSON.stringify(row);
        const score = scoreText(rowText, queryTokens);
        if (score > 0) {
          results.push({
            documentId: doc.id,
            documentName: doc.name,
            sheet: sheet.name,
            rowIndex,
            score,
            row,
            uri: `document://${doc.id}/sheets/${encodeURIComponent(sheet.name)}`
          });
        }
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, Number(limit) || 5);
};

const answerTextQuestion = ({ documentId, question, limit = 5 }) => {
  if (!question) throw new Error('question is required.');

  const doc = getDocument(documentId);
  if (doc.kind === 'table') {
    return {
      ...answerTableQuestion({ documentId, question, limit }),
      mode: 'table'
    };
  }

  const extracted = answerExtractedTextField(doc, question) || fallbackToTopDocumentIdentity(doc, question);
  if (extracted) {
    return {
      documentId: doc.id,
      documentName: doc.name,
      question,
      mode: 'extracted_field',
      answer: extracted.answer,
      matchedChunks: 1,
      evidence: extracted.evidence,
      chunks: extracted.evidence.map((item) => ({
        chunkIndex: item.chunkIndex,
        score: 100,
        snippet: item.text,
        uri: item.uri
      }))
    };
  }

  const chunks = rankTextChunks(doc, question, limit);
  const evidence = buildExtractiveTextAnswer(question, chunks);
  const answer = evidence.map((item) => item.text).join('\n');

  return {
    documentId: doc.id,
    documentName: doc.name,
    question,
    mode: 'rag',
    answer: answer || null,
    matchedChunks: chunks.length,
    evidence,
    chunks: chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      score: chunk.score,
      snippet: chunk.snippet,
      uri: chunk.uri
    }))
  };
};

const queryTable = ({ documentId, sheetName, limit = 20, filters = {} }) => {
  const doc = getDocument(documentId);
  const storedSheet = sheetName
    ? (doc.sheets || []).find((item) => item.name === sheetName)
    : doc.sheets?.[0];

  if (!storedSheet) throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
  const sheet = normalizeStoredSheet(storedSheet);

  const rows = sheet.rows.filter((row) => {
    return Object.entries(filters || {}).every(([key, value]) => {
      const column = (sheet.columns || []).find((item) => normalizeCell(item) === normalizeCell(key)) || key;
      return filterMatchesCell(row[column], value);
    });
  }).slice(0, Number(limit) || 20);

  return {
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    columns: sheet.columns,
    totalRows: sheet.rowCount,
    returnedRows: rows.length,
    rows
  };
};

const normalizeStoredSheet = (sheet) => {
  if (!sheet || looksLikeHeaderRow(sheet.columns || [])) return sheet;

  const legacyOrder = getLegacyColumnOrder(sheet.columns || []);
  const orderedColumns = legacyOrder ? legacyOrder.map((index) => sheet.columns[index]) : sheet.columns;
  const rawRows = [
    orderedColumns,
    ...(sheet.rows || []).map((row) => {
      const values = sheet.columns.map((column) => row[column]);
      return legacyOrder ? legacyOrder.map((index) => values[index]) : values;
    })
  ];
  const normalized = rowsFromSheetArray(rawRows);

  return {
    ...sheet,
    columns: normalized.columns,
    rows: normalized.rows,
    rowCount: normalized.rows.length
  };
};

const getLegacyColumnOrder = (columns) => {
  if (
    columns.length === 8 &&
    !looksLikeDate(columns[0]) &&
    looksLikeDate(columns[1]) &&
    !Number.isNaN(Number(String(columns[0]).replace(/,/g, '')))
  ) {
    return [1, 2, 3, 4, 5, 0, 6, 7];
  }

  return null;
};

const normalizeCell = (value) => String(value ?? '').trim().toLowerCase();

const normalizeLabel = (value) => String(value ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .replace(/[^a-zA-Z0-9]+/g, ' ')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const compactLabel = (value) => normalizeLabel(value).replace(/\s+/g, '');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const labelBoundaryRegex = (label) => new RegExp(`(^|\\s)${escapeRegex(label)}(?=\\s|$)`, 'i');

const findColumnByLabel = (columns = [], candidate) => {
  const normalizedCandidate = normalizeLabel(candidate);
  const compactCandidate = compactLabel(candidate);
  if (!normalizedCandidate) return null;

  const exact = columns.find((column) => (
    normalizeLabel(column) === normalizedCandidate ||
    compactLabel(column) === compactCandidate
  ));
  if (exact) return exact;

  return columns.find((column) => {
    const normalizedColumn = normalizeLabel(column);
    const compactColumn = compactLabel(column);
    return (
      normalizedColumn.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedColumn) ||
      compactColumn.includes(compactCandidate) ||
      compactCandidate.includes(compactColumn)
    );
  }) || null;
};

const findColumn = (columns, candidates) => {
  return candidates.map((candidate) => findColumnByLabel(columns, candidate)).find(Boolean);
};

const columnAliases = [
  { column: 'Product', aliases: ['product name', 'name of product', 'product', 'item name', 'item'] },
  { column: 'Sales Amount', aliases: ['sales amount', 'sale amount', 'total sales', 'total revenue', 'revenue', 'amount', 'sales'] },
  { column: 'Price per Unit', aliases: ['price per unit', 'unit price', 'price', 'rate'] },
  { column: 'Quantity', aliases: ['quantity', 'qty', 'units', 'number of units'] },
  { column: 'City', aliases: ['city', 'town'] },
  { column: 'State', aliases: ['state', 'province'] },
  { column: 'Region', aliases: ['region', 'zone'] },
  { column: 'Sale Date', aliases: ['sale date', 'order date', 'date'] }
];

const questionIncludes = (question, phrase) => {
  const normalized = normalizeLabel(question);
  const normalizedPhrase = normalizeLabel(phrase);
  if (!normalizedPhrase) return false;
  return labelBoundaryRegex(normalizedPhrase).test(normalized);
};

const resolveQuestionColumnPhrase = (phrase, columns) => {
  if (!phrase) return null;
  const normalizedPhrase = normalizeLabel(phrase)
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+(value|field|column)$/, '');

  return findColumnByLabel(columns, normalizedPhrase);
};

const findRequestedColumn = (question, columns) => {
  const lowerColumns = columns.map((column) => ({ original: column, normalized: normalizeLabel(column) }));

  for (const group of columnAliases) {
    const actualColumn = lowerColumns.find((column) => (
      column.normalized === normalizeLabel(group.column) ||
      column.normalized.includes(normalizeLabel(group.column))
    ))?.original;

    if (!actualColumn) continue;
    if (group.aliases.some((alias) => questionIncludes(question, alias))) return actualColumn;
  }

  const normalizedQuestion = normalizeLabel(question);
  const requestedPhraseMatch = normalizedQuestion.match(
    /^(?:what is|what are|whats|which|show|show me|tell me|give me|get|find)\s+(?:the\s+)?(.+?)(?=\s+(?:of|for|where|when|with|from|in|on)\s+|$)/
  );
  const requestedFromPhrase = resolveQuestionColumnPhrase(requestedPhraseMatch?.[1], columns);
  if (requestedFromPhrase) return requestedFromPhrase;

  if (!/\b(count|how many|number of)\b/.test(normalizedQuestion)) {
    const mentionedColumns = columns
      .map((column) => {
        const label = normalizeLabel(column);
        const match = label ? labelBoundaryRegex(label).exec(normalizedQuestion) : null;
        return match ? { column, index: match.index + match[1].length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    if (mentionedColumns.length > 0) return mentionedColumns[0].column;
  }

  return null;
};

const getQuestionOperation = (question) => {
  const normalized = normalizeCell(question);

  if (/\b(count|how many|number of)\b/.test(normalized)) return 'count';
  if (/\b(average|avg|mean)\b/.test(normalized)) return 'average';
  if (/\b(total|sum)\b/.test(normalized)) return 'sum';
  if (/\b(highest|maximum|max|top|most|largest)\b/.test(normalized)) return 'max';
  if (/\b(lowest|minimum|min|least|smallest)\b/.test(normalized)) return 'min';

  return 'list';
};

const wantsFullRowDetails = (question) => {
  const normalized = normalizeLabel(question);
  return /\b(details|detail|full details|record|records|row|rows|all data|all details|information|info|profile)\b/.test(normalized);
};

const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const formatValue = (value) => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value ?? '');
};

const uniqueValues = (values) => Array.from(new Set(values
  .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
  .map((value) => String(value))));

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
      }
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
    if (match) return { operator: pattern.operator, value: cleanConditionValue(match[1]) };
  }

  return null;
};

const extractComparisonFilters = (question, fields = [], ignoredFields = []) => {
  const normalized = normalizeConditionText(question);
  const ignored = new Set(ignoredFields.filter(Boolean));
  const filters = [];

  for (const field of fields) {
    if (!field || ignored.has(field) || filters.some((filter) => filter.column === field)) continue;
    const label = normalizeLabel(field);
    const match = label ? labelBoundaryRegex(label).exec(normalized) : null;
    if (!match) continue;

    const fragment = normalized.slice(match.index + match[0].length).trim();
    const comparison = parseComparisonFragment(fragment);
    if (comparison) {
      filters.push({ column: field, ...comparison });
    }
  }

  return filters;
};

const extractExplicitColumnFilters = (question, sheet, requestedColumn) => {
  const filters = [];
  const normalizedQuestion = normalizeLabel(question);
  const columnsByLength = [...(sheet.columns || [])]
    .filter((column) => column !== requestedColumn)
    .sort((a, b) => normalizeLabel(b).length - normalizeLabel(a).length);

  for (const column of columnsByLength) {
    const label = normalizeLabel(column);
    if (!label) continue;

    const match = labelBoundaryRegex(label).exec(normalizedQuestion);
    if (!match) continue;

    let fragment = normalizedQuestion.slice(match.index + match[0].length).trim();
    fragment = fragment.replace(/^(is|equals|equal to|equal|with|for|of|on|where|as|to)\s+/, '').trim();
    if (!fragment) continue;

    const stopMatch = fragment.match(/\s+(?:and|where|with)\s+/);
    if (stopMatch) fragment = fragment.slice(0, stopMatch.index).trim();

    const candidates = uniqueValues(sheet.rows.map((row) => row[column]))
      .sort((a, b) => normalizeLabel(b).length - normalizeLabel(a).length);
    const candidate = candidates.find((value) => {
      const normalizedValue = normalizeLabel(value);
      return normalizedValue && labelBoundaryRegex(normalizedValue).test(fragment);
    });

    const value = candidate ?? fragment.split(/\s+/).slice(0, 4).join(' ');
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      filters.push({ column, value, operator: 'equals' });
    }
  }

  return filters;
};

const extractValueFilters = (question, sheet, requestedColumn, dateColumn) => {
  const filters = [];
  const normalizedQuestion = normalizeCell(question);
  const explicitFilters = extractExplicitColumnFilters(question, sheet, requestedColumn);
  const explicitColumns = new Set(explicitFilters.map((filter) => filter.column));
  filters.push(...explicitFilters);

  for (const column of sheet.columns || []) {
    if (column === requestedColumn || column === dateColumn || explicitColumns.has(column)) continue;

    const candidates = uniqueValues(sheet.rows.map((row) => row[column]))
      .filter((value) => {
        const normalized = normalizeCell(value);
        return normalized.length >= 3 && Number.isNaN(Number(normalized.replace(/,/g, '')));
      })
      .sort((a, b) => String(b).length - String(a).length);

    const match = candidates.find((value) => {
      const normalized = normalizeCell(value);
      return normalizedQuestion.includes(normalized);
    });

    if (match) filters.push({ column, value: match });
  }

  return filters;
};

const comparableValue = (value) => {
  const numeric = toNumber(value);
  if (numeric !== null) return { type: 'number', value: numeric };

  if (looksLikeDate(value)) {
    const normalized = normalizeDateString(value);
    const [day, month, year] = normalized.split('-');
    const timestamp = Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
    if (!Number.isNaN(timestamp)) return { type: 'date', value: timestamp };
  }

  return { type: 'text', value: normalizeCell(value) };
};

const compareValues = (actual, expected) => {
  const left = comparableValue(actual);
  const right = comparableValue(expected);

  if (left.type === right.type && left.type !== 'text') {
    return left.value - right.value;
  }

  if (left.type === 'number' && right.type === 'number') return left.value - right.value;
  return String(left.value).localeCompare(String(right.value));
};

const extractDateValue = (question) => {
  const patterns = [
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/,
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) return match[0];
  }

  return null;
};

const normalizeDateString = (value) => {
  const numeric = toNumber(value);
  if (numeric !== null && numeric > 20000 && numeric < 80000) {
    const parsed = xlsx.SSF.parse_date_code(numeric);
    if (parsed?.y && parsed?.m && parsed?.d) {
      return `${String(parsed.d).padStart(2, '0')}-${String(parsed.m).padStart(2, '0')}-${parsed.y}`;
    }
  }

  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const dateOnly = raw.includes('T') ? raw.split('T')[0] : raw;
  const parts = dateOnly.split(/[-/]/).map((part) => part.padStart(2, '0'));

  if (parts.length !== 3) return raw.toLowerCase();

  if (parts[0].length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${parts[0]}-${parts[1]}-${year}`;
};

const dateStringCandidates = (value) => {
  const normalized = normalizeDateString(value);
  if (!normalized) return [];

  const candidates = new Set([normalized]);
  const parts = normalized.split('-');

  if (parts.length === 3 && Number(parts[0]) <= 12 && Number(parts[1]) <= 12) {
    candidates.add(`${parts[1]}-${parts[0]}-${parts[2]}`);
  }

  return Array.from(candidates);
};

const datesEqual = (left, right) => {
  const leftCandidates = new Set(dateStringCandidates(left));
  return dateStringCandidates(right).some((candidate) => leftCandidates.has(candidate));
};

const formatAnswerCell = (value, column) => {
  if (/date/i.test(String(column || '')) && (typeof value === 'number' || looksLikeDate(value) || String(value ?? '').includes('T'))) {
    return normalizeDateString(value);
  }

  return formatValue(value);
};

const MAX_DOCUMENT_MUTATION_ROWS = Number(process.env.MCP_DOCUMENT_MAX_MUTATION_ROWS || 100);

const tableDocumentText = (doc) => (doc.sheets || [])
  .map((sheet) => `${sheet.name}\n${JSON.stringify((sheet.rows || []).slice(0, 100), null, 2)}`)
  .join('\n\n');

const refreshTableMetadata = (doc) => {
  if (doc.kind !== 'table') return doc;

  doc.sheetCount = doc.sheets?.length || 0;
  for (const sheet of doc.sheets || []) {
    sheet.rowCount = sheet.rows?.length || 0;
  }

  const text = tableDocumentText(doc);
  doc.textLength = text.length;
  doc.chunks = chunkText(text);
  doc.chunkCount = doc.chunks.length;
  doc.updatedAt = new Date().toISOString();
  return doc;
};

const getWritableTableSheet = (documentId, sheetName) => {
  const docs = readIndex();
  const documentIndex = docs.findIndex((item) => item.id === documentId);
  if (documentIndex === -1) throw new Error(`Document not found: ${documentId}`);

  const doc = docs[documentIndex];
  if (doc.kind !== 'table' || !Array.isArray(doc.sheets)) {
    throw new Error(`${doc.name} is not an editable table document. Upload Excel or CSV for row edits.`);
  }
  ensureDocumentCopies(doc);

  const sheetIndex = sheetName
    ? doc.sheets.findIndex((item) => item.name === sheetName)
    : 0;

  if (sheetIndex === -1 || !doc.sheets[sheetIndex]) {
    throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
  }

  doc.sheets[sheetIndex] = normalizeStoredSheet(doc.sheets[sheetIndex]);
  return { docs, doc, sheet: doc.sheets[sheetIndex], documentIndex };
};

const getReadableTableSheet = (documentId, sheetName) => {
  const doc = getDocument(documentId);
  if (doc.kind !== 'table' || !Array.isArray(doc.sheets)) {
    throw new Error(`${doc.name} is not a table document. Upload Excel or CSV for row edits.`);
  }

  const storedSheet = sheetName
    ? doc.sheets.find((item) => item.name === sheetName)
    : doc.sheets[0];

  if (!storedSheet) throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
  return { doc, sheet: normalizeStoredSheet(storedSheet) };
};

const resolveColumnName = (columns = [], requestedColumn) => {
  if (!requestedColumn) throw new Error('column is required.');

  const requested = normalizeCell(requestedColumn);
  const exact = columns.find((column) => normalizeCell(column) === requested);
  if (exact) return exact;

  const loose = columns.find((column) => {
    const normalized = normalizeCell(column);
    return normalized.includes(requested) || requested.includes(normalized);
  });
  if (loose) return loose;

  const aliasGroup = columnAliases.find((group) => (
    normalizeCell(group.column) === requested ||
    group.aliases.some((alias) => normalizeCell(alias) === requested || normalizeCell(alias).includes(requested))
  ));
  if (aliasGroup) {
    const aliasColumn = findColumn(columns, [aliasGroup.column, ...aliasGroup.aliases]);
    if (aliasColumn) return aliasColumn;
  }

  throw new Error(`Column not found: ${requestedColumn}. Available columns: ${columns.join(', ')}`);
};

const normalizeFilters = (filters = {}) => {
  if (Array.isArray(filters)) {
    return filters.map((filter) => ({
      column: filter.column || filter.field || filter.key,
      value: filter.value,
      operator: filter.operator || filter.mode || 'contains'
    }));
  }

  return Object.entries(filters || {}).map(([column, value]) => ({
    column,
    value,
    operator: 'contains'
  }));
};

const hasMutationTarget = ({ rowIndex, rowIndexes, filters, allowAll }) => (
  allowAll === true ||
  Number.isInteger(rowIndex) ||
  (Array.isArray(rowIndexes) && rowIndexes.length > 0) ||
  normalizeFilters(filters).length > 0
);

const filterMatchesCell = (actual, expected, operator = 'contains') => {
  if (operator === 'between') {
    return compareValues(actual, expected?.min) >= 0 && compareValues(actual, expected?.max) <= 0;
  }

  if (operator === 'gt') return compareValues(actual, expected) > 0;
  if (operator === 'gte') return compareValues(actual, expected) >= 0;
  if (operator === 'lt') return compareValues(actual, expected) < 0;
  if (operator === 'lte') return compareValues(actual, expected) <= 0;

  if (operator === 'dateEquals') {
    return datesEqual(actual, expected);
  }

  if (looksLikeDate(expected) && (looksLikeDate(actual) || toNumber(actual) !== null)) {
    return datesEqual(actual, expected);
  }

  if (operator === 'equals' || operator === 'exact') {
    return normalizeCell(actual) === normalizeCell(expected);
  }

  if (operator === 'startsWith') {
    return normalizeCell(actual).startsWith(normalizeCell(expected));
  }

  return normalizeCell(actual).includes(normalizeCell(expected));
};

const findMatchingRowIndexes = (sheet, { rowIndex, rowIndexes, filters } = {}) => {
  let indexes = (sheet.rows || []).map((_, index) => index);

  if (Number.isInteger(rowIndex)) {
    indexes = indexes.filter((index) => index === rowIndex);
  }

  if (Array.isArray(rowIndexes) && rowIndexes.length > 0) {
    const selected = new Set(rowIndexes.filter(Number.isInteger));
    indexes = indexes.filter((index) => selected.has(index));
  }

  const normalizedFilters = normalizeFilters(filters);
  if (normalizedFilters.length > 0) {
    indexes = indexes.filter((index) => normalizedFilters.every((filter) => {
      const column = resolveColumnName(sheet.columns || [], filter.column);
      return filterMatchesCell(sheet.rows[index][column], filter.value, filter.operator);
    }));
  }

  return indexes;
};

const coerceCellValue = (value, currentValue) => {
  if (currentValue === null || currentValue === undefined) return value;
  if (typeof currentValue === 'number') {
    const numeric = toNumber(value);
    return numeric === null ? value : numeric;
  }
  return value;
};

const previewTableUpdate = ({ documentId, sheetName, rowIndex, rowIndexes, filters = {}, allowAll = false, column, value, limit = 20 }) => {
  if (!hasMutationTarget({ rowIndex, rowIndexes, filters, allowAll })) {
    throw new Error('Provide rowIndex, rowIndexes, filters, or allowAll=true before previewing a table update.');
  }

  const { doc, sheet } = getReadableTableSheet(documentId, sheetName);
  const targetColumn = resolveColumnName(sheet.columns || [], column);
  const matchedIndexes = findMatchingRowIndexes(sheet, { rowIndex, rowIndexes, filters });
  const previewLimit = Number(limit) || 20;

  const changes = matchedIndexes.slice(0, previewLimit).map((index) => {
    const before = sheet.rows[index][targetColumn];
    return {
      rowIndex: index,
      column: targetColumn,
      before,
      after: coerceCellValue(value, before),
      row: sheet.rows[index]
    };
  });

  return {
    applied: false,
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    column: targetColumn,
    value,
    matchedRows: matchedIndexes.length,
    previewedRows: changes.length,
    changes
  };
};

const updateTableCell = ({ documentId, sheetName, rowIndex, rowIndexes, filters = {}, allowAll = false, column, value }) => {
  if (!hasMutationTarget({ rowIndex, rowIndexes, filters, allowAll })) {
    throw new Error('Provide rowIndex, rowIndexes, filters, or allowAll=true before applying a table update.');
  }

  const { docs, doc, sheet, documentIndex } = getWritableTableSheet(documentId, sheetName);
  const targetColumn = resolveColumnName(sheet.columns || [], column);
  const matchedIndexes = findMatchingRowIndexes(sheet, { rowIndex, rowIndexes, filters });

  if (matchedIndexes.length > MAX_DOCUMENT_MUTATION_ROWS) {
    throw new Error(`Refusing to update ${matchedIndexes.length} rows. Narrow the filters or raise MCP_DOCUMENT_MAX_MUTATION_ROWS.`);
  }

  const changes = matchedIndexes.map((index) => {
    const before = sheet.rows[index][targetColumn];
    const after = coerceCellValue(value, before);
    sheet.rows[index][targetColumn] = after;
    return {
      rowIndex: index,
      column: targetColumn,
      before,
      after,
      row: sheet.rows[index]
    };
  });

  refreshTableMetadata(doc);
  rewriteWorkingCopy(doc);
  docs[documentIndex] = doc;
  writeIndex(docs);

  return {
    applied: true,
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    column: targetColumn,
    matchedRows: matchedIndexes.length,
    changedRows: changes.length,
    changes
  };
};

const addTableRow = ({ documentId, sheetName, row }) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('row must be an object keyed by column name.');
  }

  const { docs, doc, sheet, documentIndex } = getWritableTableSheet(documentId, sheetName);
  const columns = [...(sheet.columns || [])];
  const normalizedRow = {};

  for (const [key, value] of Object.entries(row)) {
    const existingColumn = columns.find((column) => normalizeCell(column) === normalizeCell(key));
    const column = existingColumn || key;
    if (!existingColumn) columns.push(column);
    normalizedRow[column] = value;
  }

  for (const column of columns) {
    if (!(column in normalizedRow)) normalizedRow[column] = null;
  }

  sheet.columns = columns;
  sheet.rows.push(normalizedRow);
  sheet.rowCount = sheet.rows.length;
  refreshTableMetadata(doc);
  rewriteWorkingCopy(doc);
  docs[documentIndex] = doc;
  writeIndex(docs);

  return {
    applied: true,
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    rowIndex: sheet.rows.length - 1,
    row: normalizedRow
  };
};

const deleteTableRows = ({ documentId, sheetName, rowIndex, rowIndexes, filters = {}, allowAll = false }) => {
  if (!hasMutationTarget({ rowIndex, rowIndexes, filters, allowAll })) {
    throw new Error('Provide rowIndex, rowIndexes, filters, or allowAll=true before deleting table rows.');
  }

  const { docs, doc, sheet, documentIndex } = getWritableTableSheet(documentId, sheetName);
  const matchedIndexes = findMatchingRowIndexes(sheet, { rowIndex, rowIndexes, filters });

  if (matchedIndexes.length > MAX_DOCUMENT_MUTATION_ROWS) {
    throw new Error(`Refusing to delete ${matchedIndexes.length} rows. Narrow the filters or raise MCP_DOCUMENT_MAX_MUTATION_ROWS.`);
  }

  const deletedRows = matchedIndexes
    .map((index) => ({ rowIndex: index, row: sheet.rows[index] }))
    .filter((item) => item.row);

  [...matchedIndexes]
    .sort((a, b) => b - a)
    .forEach((index) => {
      if (index >= 0 && index < sheet.rows.length) sheet.rows.splice(index, 1);
    });

  sheet.rowCount = sheet.rows.length;
  refreshTableMetadata(doc);
  rewriteWorkingCopy(doc);
  docs[documentIndex] = doc;
  writeIndex(docs);

  return {
    applied: true,
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    deletedRows: deletedRows.length,
    rows: deletedRows
  };
};

const answerTableQuestion = ({ documentId, question, sheetName, limit = 20 }) => {
  if (!question) throw new Error('question is required.');

  const doc = getDocument(documentId);
  const storedSheet = sheetName
    ? (doc.sheets || []).find((item) => item.name === sheetName)
    : doc.sheets?.[0];

  if (!storedSheet) throw new Error(`Sheet not found: ${sheetName || '(first sheet)'}`);
  const sheet = normalizeStoredSheet(storedSheet);

  const columns = sheet.columns || [];
  const dateColumn = findColumn(columns, ['date', 'sale date', 'order date']);
  const fullRowDetails = wantsFullRowDetails(question);
  const requestedColumn = fullRowDetails ? null : findRequestedColumn(question, columns);
  const operation = getQuestionOperation(question);
  const requestedDate = extractDateValue(question);
  const normalizedRequestedDate = requestedDate ? normalizeDateString(requestedDate) : null;

  let rows = sheet.rows;
  const appliedFilters = [];

  if (normalizedRequestedDate && dateColumn) {
    rows = rows.filter((row) => datesEqual(row[dateColumn], requestedDate));
    appliedFilters.push({ column: dateColumn, value: requestedDate });
  }

  const comparisonFilters = extractComparisonFilters(question, columns, operation === 'count' ? [] : [requestedColumn]);
  const comparisonColumns = new Set(comparisonFilters.map((filter) => filter.column));
  const valueFilters = extractValueFilters(question, sheet, requestedColumn, dateColumn)
    .filter((filter) => !comparisonColumns.has(filter.column));
  for (const filter of comparisonFilters) {
    rows = rows.filter((row) => filterMatchesCell(row[filter.column], filter.value, filter.operator));
    appliedFilters.push(filter);
  }
  for (const filter of valueFilters) {
    rows = rows.filter((row) => filterMatchesCell(row[filter.column], filter.value, filter.operator || 'equals'));
    appliedFilters.push(filter);
  }

  if (appliedFilters.length === 0) {
    const tokens = tokenize(question);
    rows = rows.filter((row) => {
      const rowText = Object.values(row).map((value) => String(value ?? '')).join(' ').toLowerCase();
      return tokens.some((token) => rowText.includes(token));
    });
  }

  const numericValues = requestedColumn
    ? rows.map((row) => toNumber(row[requestedColumn])).filter((value) => value !== null)
    : [];
  const answerValues = requestedColumn
    ? uniqueValues(rows.map((row) => formatAnswerCell(row[requestedColumn], requestedColumn)))
    : [];

  let answer = null;
  let answerType = operation;

  if (operation === 'count') {
    answer = rows.length;
  } else if (requestedColumn && operation === 'sum' && numericValues.length > 0) {
    answer = numericValues.reduce((sum, value) => sum + value, 0);
  } else if (requestedColumn && operation === 'average' && numericValues.length > 0) {
    answer = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
  } else if (requestedColumn && operation === 'max' && numericValues.length > 0) {
    answer = Math.max(...numericValues);
  } else if (requestedColumn && operation === 'min' && numericValues.length > 0) {
    answer = Math.min(...numericValues);
  } else if (requestedColumn && answerValues.length > 0) {
    answerType = 'values';
    answer = answerValues.join(', ');
  } else if (!requestedColumn && rows.length > 0) {
    answerType = 'rows';
    answer = `${rows.length} matching row${rows.length === 1 ? '' : 's'}`;
  }

  return {
    documentId: doc.id,
    documentName: doc.name,
    sheet: sheet.name,
    columns: sheet.columns,
    question,
    matchedRows: rows.length,
    returnedRows: rows.slice(0, Number(limit) || 20).length,
    dateColumn,
    requestedColumn,
    requestedDate,
    appliedFilters,
    operation,
    fullRowDetails,
    answerType,
    answer,
    rows: rows.slice(0, Number(limit) || 20)
  };
};

const deleteDocument = (documentId) => {
  const docs = readIndex();
  const doc = docs.find((item) => item.id === documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  const paths = new Set([doc.storedPath, doc.originalPath, doc.workingPath].filter(Boolean));
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  writeIndex(docs.filter((item) => item.id !== documentId));
  return summarizeDocument(doc);
};

const getDocumentFileInfo = (documentId, variant = 'working') => {
  const doc = getDocumentWithPersistedCopies(documentId);
  const normalizedVariant = variant === 'original' ? 'original' : 'working';
  const filePath = normalizedVariant === 'original' ? doc.originalPath : doc.workingPath;

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${normalizedVariant} file copy not found for ${doc.name}.`);
  }

  return {
    path: filePath,
    fileName: copyNameFor(doc.id, normalizedVariant, doc.extension || path.extname(doc.name || '')),
    mimeType: doc.mimeType || 'application/octet-stream',
    documentName: doc.name,
    variant: normalizedVariant
  };
};

module.exports = {
  DOCUMENT_ROOT,
  UPLOAD_DIR,
  ORIGINAL_DIR,
  WORKING_DIR,
  ensureDocumentStore,
  saveUploadedDocument,
  listDocuments,
  describeDocument,
  listResources,
  readResource,
  searchDocuments,
  queryTable,
  previewTableUpdate,
  updateTableCell,
  addTableRow,
  deleteTableRows,
  answerTextQuestion,
  answerTableQuestion,
  deleteDocument,
  getDocumentFileInfo
};
