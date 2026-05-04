const fs = require('fs');
const path = require('path');
const { getDatabaseConnector } = require('./databaseRegistry');

const DATABASE_STORE_ROOT = process.env.MCP_DATABASE_STORE_ROOT
  ? path.resolve(process.env.MCP_DATABASE_STORE_ROOT)
  : path.resolve(__dirname, '..', '..', 'database-store');

const ORIGINAL_DIR = path.join(DATABASE_STORE_ROOT, 'originals');
const WORKING_DIR = path.join(DATABASE_STORE_ROOT, 'working');
const INDEX_PATH = path.join(DATABASE_STORE_ROOT, 'snapshots.json');
const DEFAULT_SNAPSHOT_LIMIT = Number(process.env.MCP_DATABASE_SNAPSHOT_ROW_LIMIT || 1000);
const MAX_MUTATION_ROWS = Number(process.env.MCP_DATABASE_SNAPSHOT_MAX_MUTATION_ROWS || 1000);

const ensureDatabaseStore = () => {
  fs.mkdirSync(ORIGINAL_DIR, { recursive: true });
  fs.mkdirSync(WORKING_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_PATH)) {
    fs.writeFileSync(INDEX_PATH, JSON.stringify([], null, 2));
  }
};

const readIndex = () => {
  ensureDatabaseStore();
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
};

const writeIndex = (snapshots) => {
  ensureDatabaseStore();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(snapshots, null, 2));
};

const safeId = (value) => {
  const base = String(value || 'database')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'database';
  return `${base}-${Date.now()}`;
};

const snapshotFileName = (snapshotId, variant) => `${snapshotId}-${variant}.json`;

const clampSnapshotLimit = (limit) => {
  const parsed = Number(limit || DEFAULT_SNAPSHOT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SNAPSHOT_LIMIT;
  return Math.min(parsed, DEFAULT_SNAPSHOT_LIMIT);
};

const summarizeSnapshot = (snapshot) => ({
  id: snapshot.id,
  databaseId: snapshot.databaseId,
  databaseType: snapshot.databaseType,
  createdAt: snapshot.createdAt,
  updatedAt: snapshot.updatedAt,
  sourceCount: snapshot.sourceCount,
  rowCount: snapshot.rowCount,
  rowLimitPerSource: snapshot.rowLimitPerSource,
  originalPath: snapshot.originalPath,
  workingPath: snapshot.workingPath,
  sources: snapshot.sources?.map((source) => ({
    name: source.name,
    kind: source.kind,
    rowCount: source.rowCount,
    rowCountEstimate: source.rowCountEstimate,
    fields: source.fields,
    columns: source.columns,
    error: source.error
  })),
  copies: {
    original: {
      fileName: snapshotFileName(snapshot.id, 'original'),
      downloadPath: `/api/database-connections/snapshots/${snapshot.id}/download/original`
    },
    working: {
      fileName: snapshotFileName(snapshot.id, 'working'),
      downloadPath: `/api/database-connections/snapshots/${snapshot.id}/download/working`
    }
  }
});

const writeSnapshotFiles = (snapshot) => {
  fs.writeFileSync(snapshot.originalPath, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(snapshot.workingPath, JSON.stringify(snapshot, null, 2));
};

const readSnapshotFile = (snapshot, variant = 'working') => {
  const filePath = variant === 'original' ? snapshot.originalPath : snapshot.workingPath;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${variant} snapshot file not found for ${snapshot.id}.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const writeWorkingSnapshot = (snapshotMetadata, workingSnapshot) => {
  workingSnapshot.updatedAt = new Date().toISOString();
  workingSnapshot.originalPath = snapshotMetadata.originalPath;
  workingSnapshot.workingPath = snapshotMetadata.workingPath;
  fs.writeFileSync(snapshotMetadata.workingPath, JSON.stringify(workingSnapshot, null, 2));

  const snapshots = readIndex();
  const index = snapshots.findIndex((item) => item.id === snapshotMetadata.id);
  if (index !== -1) {
    snapshots[index] = {
      ...snapshots[index],
      updatedAt: workingSnapshot.updatedAt,
      sourceCount: workingSnapshot.sources?.length || 0,
      rowCount: countSnapshotRows(workingSnapshot)
    };
    writeIndex(snapshots);
  }

  return workingSnapshot;
};

const countSnapshotRows = (snapshot) => (snapshot.sources || [])
  .reduce((total, source) => total + (source.rows?.length || 0), 0);

const quoteIdentifier = (identifier, type) => {
  const value = String(identifier);
  if (type === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
  return `"${value.replace(/"/g, '""')}"`;
};

const qualifiedSqlName = (table, type) => {
  if (table.schema && type !== 'sqlite') {
    return `${quoteIdentifier(table.schema, type)}.${quoteIdentifier(table.name, type)}`;
  }
  return quoteIdentifier(table.name, type);
};

const collectMongoSources = async (connector, description, limit) => {
  const sources = [];

  for (const collection of description.collections || []) {
    try {
      const rows = await connector.query({
        collection: collection.name,
        operation: 'find',
        limit
      });
      sources.push({
        name: collection.name,
        kind: 'collection',
        rowCount: rows.length,
        rowCountEstimate: collection.rowCountEstimate,
        fields: collection.fields || [],
        rows
      });
    } catch (error) {
      sources.push({
        name: collection.name,
        kind: 'collection',
        rowCount: 0,
        rowCountEstimate: collection.rowCountEstimate,
        fields: collection.fields || [],
        rows: [],
        error: error.message
      });
    }
  }

  return sources;
};

const collectSqlSources = async (connector, description, limit) => {
  const sources = [];

  for (const table of description.tables || []) {
    const name = table.schema ? `${table.schema}.${table.name}` : table.name;
    try {
      const rows = await connector.query({
        sql: `SELECT * FROM ${qualifiedSqlName(table, connector.type)}`,
        limit
      });
      sources.push({
        name,
        kind: 'table',
        rowCount: rows.length,
        columns: table.columns || [],
        rows
      });
    } catch (error) {
      sources.push({
        name,
        kind: 'table',
        rowCount: 0,
        columns: table.columns || [],
        rows: [],
        error: error.message
      });
    }
  }

  return sources;
};

const createDatabaseSnapshot = async ({ databaseId, limitPerSource } = {}) => {
  if (!databaseId) throw new Error('databaseId is required.');
  ensureDatabaseStore();

  const connector = getDatabaseConnector(databaseId);
  const limit = clampSnapshotLimit(limitPerSource);
  const [status, description] = await Promise.all([
    connector.status().catch((error) => ({ error: error.message })),
    connector.describe()
  ]);

  const id = safeId(databaseId);
  const snapshot = {
    id,
    databaseId,
    databaseType: connector.type,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    rowLimitPerSource: limit,
    status,
    description,
    originalPath: path.join(ORIGINAL_DIR, snapshotFileName(id, 'original')),
    workingPath: path.join(WORKING_DIR, snapshotFileName(id, 'working')),
    sources: connector.type === 'mongodb'
      ? await collectMongoSources(connector, description, limit)
      : await collectSqlSources(connector, description, limit)
  };

  snapshot.sourceCount = snapshot.sources.length;
  snapshot.rowCount = countSnapshotRows(snapshot);
  writeSnapshotFiles(snapshot);

  const snapshots = readIndex().filter((item) => item.id !== id);
  snapshots.push(summarizeSnapshot(snapshot));
  writeIndex(snapshots);

  return summarizeSnapshot(snapshot);
};

const listDatabaseSnapshots = ({ databaseId } = {}) => {
  const snapshots = readIndex();
  return databaseId ? snapshots.filter((snapshot) => snapshot.databaseId === databaseId) : snapshots;
};

const getSnapshotMetadata = (snapshotId) => {
  const snapshot = readIndex().find((item) => item.id === snapshotId);
  if (!snapshot) throw new Error(`Database snapshot not found: ${snapshotId}`);
  return snapshot;
};

const getPathValue = (row, field) => String(field || '').split('.').reduce((value, key) => {
  if (value === null || value === undefined) return undefined;
  return value[key];
}, row);

const setPathValue = (row, field, value) => {
  const keys = String(field || '').split('.').filter(Boolean);
  if (keys.length === 0) throw new Error('field is required.');

  let target = row;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
};

const normalizeCell = (value) => String(value ?? '').trim().toLowerCase();

const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const looksLikeDate = (value) => (
  /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(String(value ?? '')) ||
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(String(value ?? ''))
);

const normalizeDateString = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const dateOnly = raw.includes('T') ? raw.split('T')[0] : raw;
  const parts = dateOnly.split(/[-/]/).map((part) => part.padStart(2, '0'));
  if (parts.length !== 3) return raw.toLowerCase();

  if (parts[0].length === 4) {
    return `${parts[0]}-${parts[1]}-${parts[2]}`;
  }

  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${parts[1]}-${parts[0]}`;
};

const comparableValue = (value) => {
  const numeric = toNumber(value);
  if (numeric !== null) return { type: 'number', value: numeric };

  if (looksLikeDate(value)) {
    const timestamp = Date.parse(`${normalizeDateString(value)}T00:00:00.000Z`);
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

  return String(left.value).localeCompare(String(right.value));
};

const filterMatches = (actual, expected, operator = 'contains') => {
  if (operator === 'between') {
    return compareValues(actual, expected?.min) >= 0 && compareValues(actual, expected?.max) <= 0;
  }

  if (operator === 'gt') return compareValues(actual, expected) > 0;
  if (operator === 'gte') return compareValues(actual, expected) >= 0;
  if (operator === 'lt') return compareValues(actual, expected) < 0;
  if (operator === 'lte') return compareValues(actual, expected) <= 0;

  if (operator === 'dateEquals' || (looksLikeDate(expected) && looksLikeDate(actual))) {
    return normalizeDateString(actual) === normalizeDateString(expected);
  }

  if (operator === 'equals' || operator === 'exact') {
    return normalizeCell(actual) === normalizeCell(expected);
  }
  if (operator === 'startsWith') {
    return normalizeCell(actual).startsWith(normalizeCell(expected));
  }
  return normalizeCell(actual).includes(normalizeCell(expected));
};

const normalizeFilters = (filters = {}) => {
  if (Array.isArray(filters)) {
    return filters.map((filter) => ({
      field: filter.field || filter.column || filter.key,
      value: filter.value,
      operator: filter.operator || 'contains'
    }));
  }

  return Object.entries(filters || {}).map(([field, value]) => ({
    field,
    value,
    operator: 'contains'
  }));
};

const findSource = (snapshot, sourceName) => {
  const source = sourceName
    ? (snapshot.sources || []).find((item) => item.name === sourceName)
    : snapshot.sources?.[0];
  if (!source) throw new Error(`Snapshot source not found: ${sourceName || '(first source)'}`);
  return source;
};

const findMatchingIndexes = (source, { rowIndex, rowIndexes, filters, allowAll } = {}) => {
  let indexes = (source.rows || []).map((_, index) => index);

  if (Number.isInteger(rowIndex)) {
    indexes = indexes.filter((index) => index === rowIndex);
  }

  if (Array.isArray(rowIndexes) && rowIndexes.length > 0) {
    const selected = new Set(rowIndexes.filter(Number.isInteger));
    indexes = indexes.filter((index) => selected.has(index));
  }

  const normalizedFilters = normalizeFilters(filters);
  if (normalizedFilters.length > 0) {
    indexes = indexes.filter((index) => normalizedFilters.every((filter) => (
      filterMatches(getPathValue(source.rows[index], filter.field), filter.value, filter.operator)
    )));
  }

  if (!allowAll && !Number.isInteger(rowIndex) && !(Array.isArray(rowIndexes) && rowIndexes.length > 0) && normalizedFilters.length === 0) {
    throw new Error('Provide rowIndex, rowIndexes, filters, or allowAll=true before mutating a database snapshot.');
  }

  return indexes;
};

const queryDatabaseSnapshot = ({ snapshotId, source, filters = {}, limit = 50 } = {}) => {
  const metadata = getSnapshotMetadata(snapshotId);
  const snapshot = readSnapshotFile(metadata, 'working');
  const selectedSource = findSource(snapshot, source);
  const normalizedFilters = normalizeFilters(filters);
  const rows = (selectedSource.rows || [])
    .filter((row) => normalizedFilters.every((filter) => (
      filterMatches(getPathValue(row, filter.field), filter.value, filter.operator)
    )))
    .slice(0, Number(limit) || 50);

  return {
    snapshotId,
    databaseId: snapshot.databaseId,
    source: selectedSource.name,
    totalRows: selectedSource.rows?.length || 0,
    returnedRows: rows.length,
    rows
  };
};

const previewSnapshotUpdate = ({ snapshotId, source, rowIndex, rowIndexes, filters = {}, allowAll = false, field, value, limit = 20 } = {}) => {
  if (!field) throw new Error('field is required.');
  const metadata = getSnapshotMetadata(snapshotId);
  const snapshot = readSnapshotFile(metadata, 'working');
  const selectedSource = findSource(snapshot, source);
  const indexes = findMatchingIndexes(selectedSource, { rowIndex, rowIndexes, filters, allowAll });
  const previewLimit = Number(limit) || 20;

  return {
    applied: false,
    snapshotId,
    databaseId: snapshot.databaseId,
    source: selectedSource.name,
    field,
    value,
    matchedRows: indexes.length,
    previewedRows: indexes.slice(0, previewLimit).length,
    changes: indexes.slice(0, previewLimit).map((index) => ({
      rowIndex: index,
      field,
      before: getPathValue(selectedSource.rows[index], field),
      after: value,
      row: selectedSource.rows[index]
    }))
  };
};

const updateSnapshotRows = ({ snapshotId, source, rowIndex, rowIndexes, filters = {}, allowAll = false, field, value } = {}) => {
  if (!field) throw new Error('field is required.');
  const metadata = getSnapshotMetadata(snapshotId);
  const snapshot = readSnapshotFile(metadata, 'working');
  const selectedSource = findSource(snapshot, source);
  const indexes = findMatchingIndexes(selectedSource, { rowIndex, rowIndexes, filters, allowAll });

  if (indexes.length > MAX_MUTATION_ROWS) {
    throw new Error(`Refusing to update ${indexes.length} snapshot rows. Narrow filters or raise MCP_DATABASE_SNAPSHOT_MAX_MUTATION_ROWS.`);
  }

  const changes = indexes.map((index) => {
    const before = getPathValue(selectedSource.rows[index], field);
    setPathValue(selectedSource.rows[index], field, value);
    return {
      rowIndex: index,
      field,
      before,
      after: value,
      row: selectedSource.rows[index]
    };
  });

  selectedSource.rowCount = selectedSource.rows.length;
  const saved = writeWorkingSnapshot(metadata, snapshot);

  return {
    applied: true,
    snapshotId,
    databaseId: saved.databaseId,
    source: selectedSource.name,
    changedRows: changes.length,
    changes
  };
};

const addSnapshotRow = ({ snapshotId, source, row } = {}) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('row must be an object.');
  }

  const metadata = getSnapshotMetadata(snapshotId);
  const snapshot = readSnapshotFile(metadata, 'working');
  const selectedSource = findSource(snapshot, source);
  selectedSource.rows = selectedSource.rows || [];
  selectedSource.rows.push(row);
  selectedSource.rowCount = selectedSource.rows.length;
  const saved = writeWorkingSnapshot(metadata, snapshot);

  return {
    applied: true,
    snapshotId,
    databaseId: saved.databaseId,
    source: selectedSource.name,
    rowIndex: selectedSource.rows.length - 1,
    row
  };
};

const deleteSnapshotRows = ({ snapshotId, source, rowIndex, rowIndexes, filters = {}, allowAll = false } = {}) => {
  const metadata = getSnapshotMetadata(snapshotId);
  const snapshot = readSnapshotFile(metadata, 'working');
  const selectedSource = findSource(snapshot, source);
  const indexes = findMatchingIndexes(selectedSource, { rowIndex, rowIndexes, filters, allowAll });

  if (indexes.length > MAX_MUTATION_ROWS) {
    throw new Error(`Refusing to delete ${indexes.length} snapshot rows. Narrow filters or raise MCP_DATABASE_SNAPSHOT_MAX_MUTATION_ROWS.`);
  }

  const deleted = indexes
    .map((index) => ({ rowIndex: index, row: selectedSource.rows[index] }))
    .filter((item) => item.row);

  [...indexes].sort((a, b) => b - a).forEach((index) => {
    if (index >= 0 && index < selectedSource.rows.length) selectedSource.rows.splice(index, 1);
  });

  selectedSource.rowCount = selectedSource.rows.length;
  const saved = writeWorkingSnapshot(metadata, snapshot);

  return {
    applied: true,
    snapshotId,
    databaseId: saved.databaseId,
    source: selectedSource.name,
    deletedRows: deleted.length,
    rows: deleted
  };
};

const deleteDatabaseSnapshot = (snapshotId) => {
  const snapshots = readIndex();
  const snapshot = snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) throw new Error(`Database snapshot not found: ${snapshotId}`);

  for (const filePath of [snapshot.originalPath, snapshot.workingPath]) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  writeIndex(snapshots.filter((item) => item.id !== snapshotId));
  return snapshot;
};

const getSnapshotFileInfo = (snapshotId, variant = 'working') => {
  const snapshot = getSnapshotMetadata(snapshotId);
  const normalizedVariant = variant === 'original' ? 'original' : 'working';
  const filePath = normalizedVariant === 'original' ? snapshot.originalPath : snapshot.workingPath;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${normalizedVariant} snapshot file not found for ${snapshotId}.`);
  }

  return {
    path: filePath,
    fileName: snapshotFileName(snapshotId, normalizedVariant),
    mimeType: 'application/json',
    variant: normalizedVariant
  };
};

module.exports = {
  DATABASE_STORE_ROOT,
  ORIGINAL_DIR,
  WORKING_DIR,
  ensureDatabaseStore,
  createDatabaseSnapshot,
  listDatabaseSnapshots,
  queryDatabaseSnapshot,
  previewSnapshotUpdate,
  updateSnapshotRows,
  addSnapshotRow,
  deleteSnapshotRows,
  deleteDatabaseSnapshot,
  getSnapshotFileInfo
};
