const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const DEFAULT_LIMIT = Number(process.env.MCP_DB_DEFAULT_LIMIT || 50);
const MAX_LIMIT = Number(process.env.MCP_DB_MAX_LIMIT || 500);
const ALLOW_WRITES = process.env.MCP_ALLOW_DB_WRITES === 'true';
const CONNECT_TIMEOUT_MS = Number(process.env.MCP_DB_CONNECT_TIMEOUT_MS || 5000);

const redactConnectionString = (uri = '') => {
  return uri
    .replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@')
    .replace(/(password=)[^&]+/i, '$1***');
};

const clampLimit = (limit) => {
  const parsed = Number(limit || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const parseJson = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const getMongoDatabaseNameFromUri = (uri = '') => {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return database ? decodeURIComponent(database) : '';
  } catch (error) {
    return '';
  }
};

const hasMongoDatabaseName = (uri = '') => Boolean(getMongoDatabaseNameFromUri(uri));

const loadDatabaseConfig = () => {
  if (process.env.MCP_DATABASES) {
    const parsed = parseJson(process.env.MCP_DATABASES, []);
    if (!Array.isArray(parsed)) throw new Error('MCP_DATABASES must be a JSON array.');
    return parsed;
  }

  const configPath = getDatabaseConfigPath();

  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  return [
    {
      id: 'default',
      type: 'mongodb',
      uri: process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce',
      description: 'Default MongoDB connection from MONGO_URI.'
    }
  ];
};

const getDatabaseConfigPath = () => {
  return process.env.MCP_DATABASES_FILE
    ? path.resolve(process.env.MCP_DATABASES_FILE)
    : path.resolve(__dirname, '..', '..', 'mcp.databases.json');
};

const getDefaultDatabaseConfig = () => ([
  {
    id: 'default',
    type: 'mongodb',
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce',
    description: 'Default MongoDB connection from MONGO_URI.'
  }
]);

const readDatabaseConfigs = () => {
  if (process.env.MCP_DATABASES) {
    const parsed = parseJson(process.env.MCP_DATABASES, []);
    if (!Array.isArray(parsed)) throw new Error('MCP_DATABASES must be a JSON array.');
    return parsed;
  }

  const configPath = getDatabaseConfigPath();
  if (!fs.existsSync(configPath)) return getDefaultDatabaseConfig();
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
};

const redactDatabaseConfig = (config) => ({
  ...config,
  uri: config.uri ? redactConnectionString(config.uri) : undefined,
  database: config.type === 'mongodb' && config.uri
    ? getMongoDatabaseNameFromUri(config.uri)
    : undefined
});

const validateDatabaseConfig = (config) => {
  const supportedTypes = new Set(['mongodb', 'postgres', 'mysql', 'sqlite']);

  if (!config || typeof config !== 'object') {
    throw new Error('Connection config is required.');
  }

  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(config.id || '')) {
    throw new Error('Connection id must be 2-40 characters and use only letters, numbers, underscores, or dashes.');
  }

  if (!supportedTypes.has(config.type)) {
    throw new Error(`Unsupported database type: ${config.type}`);
  }

  if (config.type === 'sqlite') {
    if (!config.path && !config.uri) throw new Error('SQLite needs a file path.');
  } else if (!config.uri) {
    throw new Error(`${config.type} needs a connection URI.`);
  }

  if (config.type === 'mongodb' && !hasMongoDatabaseName(config.uri)) {
    throw new Error('MongoDB URI must include a database name, for example mongodb://localhost:27017/my_database.');
  }

  return {
    id: config.id.trim(),
    type: config.type,
    uri: config.uri?.trim(),
    path: config.path?.trim(),
    description: config.description?.trim() || `${config.type} database connection`
  };
};

const writeDatabaseConfigs = (configs) => {
  if (process.env.MCP_DATABASES) {
    throw new Error('Cannot save database connections while MCP_DATABASES env var is set. Use MCP_DATABASES_FILE or remove MCP_DATABASES.');
  }

  const normalized = configs.map(validateDatabaseConfig);
  const ids = new Set();

  for (const config of normalized) {
    if (ids.has(config.id)) throw new Error(`Duplicate database id: ${config.id}`);
    ids.add(config.id);
  }

  const configPath = getDatabaseConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2));
  resetDatabaseConnectors();
  return normalized;
};

class MongoDatabaseConnector {
  constructor(config) {
    this.id = config.id;
    this.type = 'mongodb';
    this.description = config.description || 'MongoDB database connection.';
    this.uri = config.uri;
    this.databaseName = getMongoDatabaseNameFromUri(config.uri);
    this.connection = null;
    this.connectionPromise = null;
  }

  async connect() {
    if (this.connection?.readyState === 1) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;

    const isDefaultMongooseConnection =
      this.uri === (process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce') &&
      mongoose.connection.readyState === 1;

    if (isDefaultMongooseConnection) {
      this.connection = mongoose.connection;
      return this.connection;
    }

    const connection = mongoose.createConnection(this.uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS
    });
    this.connection = connection;
    this.connectionPromise = connection.asPromise()
      .then(() => {
        this.connectionPromise = null;
        return connection;
      })
      .catch((error) => {
        this.connection = null;
        this.connectionPromise = null;
        throw error;
      });

    return this.connectionPromise;
  }

  async status() {
    const connection = await this.connect();
    return {
      id: this.id,
      type: this.type,
      description: this.description,
      database: connection.name || this.databaseName,
      host: connection.host,
      readyState: connection.readyState,
      uri: redactConnectionString(this.uri)
    };
  }

  getNativeDb(connection) {
    if (connection.db) return connection.db;
    const client = connection.getClient?.();
    if (client && (connection.name || this.databaseName)) return client.db(connection.name || this.databaseName);
    throw new Error(`MongoDB native database handle is unavailable for ${this.id}.`);
  }

  async describe() {
    const connection = await this.connect();
    const db = this.getNativeDb(connection);
    const collections = await db.listCollections().toArray();
    const result = [];

    for (const collection of collections) {
      const col = db.collection(collection.name);
      const sample = await col.findOne({});
      const count = await col.estimatedDocumentCount();

      result.push({
        name: collection.name,
        kind: collection.type,
        rowCountEstimate: count,
        fields: sample ? Object.keys(sample) : [],
        sample
      });
    }

    return {
      id: this.id,
      type: this.type,
      database: connection.name || this.databaseName,
      collections: result
    };
  }

  async countRows() {
    const connection = await this.connect();
    const db = this.getNativeDb(connection);
    const collections = await db.listCollections().toArray();
    const counts = [];
    let total = 0;

    for (const collection of collections) {
      const count = await db.collection(collection.name).countDocuments({});
      counts.push({ name: collection.name, count });
      total += count;
    }

    return {
      id: this.id,
      type: this.type,
      database: connection.name || this.databaseName,
      totalRows: total,
      totalDocuments: total,
      collections: counts
    };
  }

  async listResources() {
    const schema = await this.describe();
    return [
      {
        uri: `database://${this.id}/schema`,
        name: `${this.id} schema`,
        description: `Collections and fields for ${this.id}`,
        mimeType: 'application/json'
      },
      ...schema.collections.map((collection) => ({
        uri: `database://${this.id}/collections/${collection.name}`,
        name: `${this.id}.${collection.name}`,
        description: `Sample rows and fields for ${collection.name}`,
        mimeType: 'application/json'
      }))
    ];
  }

  async readResource(uri) {
    const schemaUri = `database://${this.id}/schema`;
    if (uri === schemaUri) return this.describe();

    const collectionPrefix = `database://${this.id}/collections/`;
    if (uri.startsWith(collectionPrefix)) {
      const collection = uri.slice(collectionPrefix.length);
      return this.query({ collection, operation: 'find', limit: 10 });
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  }

  async query(args = {}) {
    const connection = await this.connect();
    const db = this.getNativeDb(connection);
    const collectionName = args.collection || args.table;
    if (!collectionName) throw new Error('collection is required for MongoDB queries.');

    const collection = db.collection(collectionName);
    const operation = args.operation || 'find';
    const limit = clampLimit(args.limit);

    if (operation === 'find') {
      return await collection
        .find(parseJson(args.filter, {}), { projection: parseJson(args.projection, {}) })
        .sort(parseJson(args.sort, {}))
        .limit(limit)
        .toArray();
    }

    if (operation === 'count') {
      return { count: await collection.countDocuments(parseJson(args.filter, {})) };
    }

    if (operation === 'distinct') {
      if (!args.field) throw new Error('field is required for distinct.');
      return await collection.distinct(args.field, parseJson(args.filter, {}));
    }

    if (operation === 'aggregate') {
      const pipeline = parseJson(args.pipeline, []);
      if (!Array.isArray(pipeline)) throw new Error('pipeline must be an array.');
      return await collection.aggregate(pipeline).limit(limit).toArray();
    }

    throw new Error(`Unsupported MongoDB read operation: ${operation}`);
  }

  async write(args = {}) {
    if (!ALLOW_WRITES) {
      throw new Error('Writes are disabled. Set MCP_ALLOW_DB_WRITES=true to enable write tools.');
    }

    const connection = await this.connect();
    const db = this.getNativeDb(connection);
    const collectionName = args.collection || args.table;
    if (!collectionName) throw new Error('collection is required for MongoDB writes.');

    const collection = db.collection(collectionName);
    const operation = args.operation;

    if (operation === 'insertOne') return collection.insertOne(parseJson(args.document, {}));
    if (operation === 'updateOne') return collection.updateOne(parseJson(args.filter, {}), parseJson(args.update, {}));
    if (operation === 'deleteOne') return collection.deleteOne(parseJson(args.filter, {}));

    throw new Error(`Unsupported MongoDB write operation: ${operation}`);
  }
}

class SqlDatabaseConnector {
  constructor(config) {
    this.id = config.id;
    this.type = config.type;
    this.description = config.description || `${config.type} database connection.`;
    this.config = config;
    this.client = null;
  }

  getInstallHint() {
    const hints = {
      postgres: 'Install the pg package to enable PostgreSQL connections.',
      mysql: 'Install the mysql2 package to enable MySQL connections.',
      sqlite: 'Install better-sqlite3 or sqlite3 to enable SQLite connections.'
    };
    return hints[this.type] || `No adapter is installed for ${this.type}.`;
  }

  loadDriver() {
    try {
      if (this.type === 'postgres') return require('pg');
      if (this.type === 'mysql') return require('mysql2/promise');
      if (this.type === 'sqlite') return require('better-sqlite3');
      throw new Error(`Unsupported SQL database type: ${this.type}`);
    } catch (error) {
      const wrapped = new Error(this.getInstallHint());
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async connect() {
    if (this.client) return this.client;

    if (this.type === 'postgres') {
      const { Client } = this.loadDriver();
      this.client = new Client({ connectionString: this.config.uri, ...this.config.options });
      await this.client.connect();
      return this.client;
    }

    if (this.type === 'mysql') {
      const mysql = this.loadDriver();
      this.client = await mysql.createConnection(this.config.uri || this.config.options);
      return this.client;
    }

    if (this.type === 'sqlite') {
      const Database = this.loadDriver();
      this.client = new Database(this.config.path || this.config.uri);
      return this.client;
    }

    throw new Error(`Unsupported SQL database type: ${this.type}`);
  }

  async status() {
    try {
      await this.connect();
      return {
        id: this.id,
        type: this.type,
        description: this.description,
        readyState: 'connected',
        uri: redactConnectionString(this.config.uri || this.config.path || '')
      };
    } catch (error) {
      return {
        id: this.id,
        type: this.type,
        description: this.description,
        readyState: 'unavailable',
        message: error.message
      };
    }
  }

  async describePostgres() {
    const client = await this.connect();
    const result = await client.query(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `);

    return this.groupSqlColumns(result.rows);
  }

  async describeMysql() {
    const client = await this.connect();
    const [rows] = await client.execute(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
      ORDER BY table_schema, table_name, ordinal_position
    `);

    return this.groupSqlColumns(rows);
  }

  async describeSqlite() {
    const db = await this.connect();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

    return {
      id: this.id,
      type: this.type,
      tables: tables.map((table) => ({
        name: table.name,
        columns: db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all().map((column) => ({
          name: column.name,
          type: column.type
        }))
      }))
    };
  }

  groupSqlColumns(rows) {
    const tableMap = new Map();

    for (const row of rows) {
      const schema = row.table_schema || row.TABLE_SCHEMA;
      const table = row.table_name || row.TABLE_NAME;
      const column = row.column_name || row.COLUMN_NAME;
      const dataType = row.data_type || row.DATA_TYPE;
      const key = `${schema}.${table}`;

      if (!tableMap.has(key)) {
        tableMap.set(key, { schema, name: table, columns: [] });
      }

      tableMap.get(key).columns.push({ name: column, type: dataType });
    }

    return {
      id: this.id,
      type: this.type,
      description: this.description,
      tables: Array.from(tableMap.values())
    };
  }

  async describe() {
    if (this.type === 'postgres') return this.describePostgres();
    if (this.type === 'mysql') return this.describeMysql();
    if (this.type === 'sqlite') return this.describeSqlite();
    throw new Error(`Unsupported SQL database type: ${this.type}`);
  }

  async countRows() {
    const schema = await this.describe();
    const counts = [];
    let total = 0;

    for (const table of schema.tables || []) {
      const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
      const rows = await this.query({ sql: `SELECT COUNT(*) AS count FROM ${qualifiedName}`, limit: 1 });
      const count = Number(rows[0]?.count || rows[0]?.COUNT || 0);
      counts.push({ name: qualifiedName, count });
      total += count;
    }

    return {
      id: this.id,
      type: this.type,
      totalRows: total,
      tables: counts
    };
  }

  async listResources() {
    return [
      {
        uri: `database://${this.id}/schema`,
        name: `${this.id} schema`,
        description: this.getInstallHint(),
        mimeType: 'application/json'
      }
    ];
  }

  async readResource() {
    return this.describe();
  }

  assertReadOnlySql(sql = '') {
    const trimmed = sql.trim();
    if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) {
      throw new Error('Only SELECT/WITH read-only SQL is allowed through database.query.');
    }

    if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(trimmed)) {
      throw new Error('Mutation keywords are not allowed through database.query.');
    }
  }

  async query(args = {}) {
    if (!args.sql) throw new Error('sql is required for SQL database queries.');
    this.assertReadOnlySql(args.sql);

    const limit = clampLimit(args.limit);
    const innerSql = args.sql.trim().replace(/;+\s*$/, '');
    const sql = `SELECT * FROM (${innerSql}) AS mcp_query LIMIT ${limit}`;

    if (this.type === 'postgres') {
      const client = await this.connect();
      const result = await client.query(sql, args.params || []);
      return result.rows;
    }

    if (this.type === 'mysql') {
      const client = await this.connect();
      const [rows] = await client.execute(sql, args.params || []);
      return rows;
    }

    if (this.type === 'sqlite') {
      const db = await this.connect();
      return db.prepare(sql).all(...(args.params || []));
    }

    throw new Error(`Unsupported SQL database type: ${this.type}`);
  }

  async write(args = {}) {
    if (!ALLOW_WRITES) {
      throw new Error('Writes are disabled. Set MCP_ALLOW_DB_WRITES=true to enable write tools.');
    }

    if (!args.sql) throw new Error('sql is required for SQL database writes.');

    if (this.type === 'postgres') {
      const client = await this.connect();
      const result = await client.query(args.sql, args.params || []);
      return { rowCount: result.rowCount, rows: result.rows };
    }

    if (this.type === 'mysql') {
      const client = await this.connect();
      const [result] = await client.execute(args.sql, args.params || []);
      return result;
    }

    if (this.type === 'sqlite') {
      const db = await this.connect();
      return db.prepare(args.sql).run(...(args.params || []));
    }

    throw new Error(`Unsupported SQL database type: ${this.type}`);
  }
}

const createConnector = (config) => {
  if (!config.id) throw new Error('Every MCP database config needs an id.');
  if (config.type === 'mongodb') return new MongoDatabaseConnector(config);
  return new SqlDatabaseConnector(config);
};

const testDatabaseConfig = async (config) => {
  const normalized = validateDatabaseConfig(config);
  const connector = createConnector(normalized);
  const status = await connector.status();

  if (status.readyState === 'unavailable' || status.readyState === 'driver_missing') {
    throw new Error(status.message || 'Database connection is unavailable.');
  }

  return status;
};

const summarizeDatabaseSchema = (schema = {}) => {
  const sources = (schema.collections || schema.tables || []).map((source) => {
    const fields = source.fields || (source.columns || []).map((column) => column.name || column.column_name).filter(Boolean);
    return {
      name: source.schema ? `${source.schema}.${source.name}` : source.name,
      kind: source.kind || (schema.collections ? 'collection' : 'table'),
      rowCountEstimate: source.rowCountEstimate ?? source.rowCount ?? null,
      fields
    };
  });

  const sourceCount = sources.length;
  const estimatedRows = sources.reduce((total, source) => (
    total + (Number.isFinite(Number(source.rowCountEstimate)) ? Number(source.rowCountEstimate) : 0)
  ), 0);
  const sampleSource = sources.find((source) => source.fields.length > 0) || sources[0];
  const sampleFields = sampleSource?.fields || [];
  const numericLikeField = sampleFields.find((field) => /\b(amount|total|runs|wickets|quantity|price|balance|rate|score|count|sales|revenue)\b/i.test(field));
  const groupLikeField = sampleFields.find((field) => /\b(category|status|city|state|country|role|type|team|customer|player|winner|format)\b/i.test(field));

  const sampleQuestions = [
    'describe schema',
    'how many rows are in this database'
  ];

  if (sampleSource?.name) {
    sampleQuestions.push(`show 5 rows from ${sampleSource.name}`);
  }

  if (numericLikeField && groupLikeField) {
    sampleQuestions.push(`show total ${numericLikeField} by ${groupLikeField}`);
  } else if (groupLikeField) {
    sampleQuestions.push(`count rows by ${groupLikeField}`);
  }

  return {
    database: schema.database,
    type: schema.type,
    sourceCount,
    estimatedRows,
    sources,
    sampleQuestions
  };
};

const inspectDatabaseConfig = async (config) => {
  const normalized = validateDatabaseConfig(config);
  const connector = createConnector(normalized);
  const status = await connector.status();

  if (status.readyState === 'unavailable' || status.readyState === 'driver_missing') {
    throw new Error(status.message || 'Database connection is unavailable.');
  }

  const schema = await connector.describe();
  const summary = summarizeDatabaseSchema(schema);
  const ready = summary.sourceCount > 0;

  return {
    ok: true,
    ready,
    status,
    summary,
    schema,
    message: ready
      ? `Connected and found ${summary.sourceCount} collection/table${summary.sourceCount === 1 ? '' : 's'}.`
      : 'Connected, but no collections or tables were found yet.'
  };
};

let connectors;

const getDatabaseConnectors = () => {
  if (!connectors) {
    connectors = loadDatabaseConfig().map(createConnector);
  }
  return connectors;
};

const getDatabaseConnector = (databaseId) => {
  const connector = getDatabaseConnectors().find((db) => db.id === databaseId);
  if (!connector) throw new Error(`Unknown database connector: ${databaseId}`);
  return connector;
};

const resetDatabaseConnectors = () => {
  connectors = null;
};

module.exports = {
  getDatabaseConnectors,
  getDatabaseConnector,
  resetDatabaseConnectors,
  getDatabaseConfigPath,
  readDatabaseConfigs,
  redactDatabaseConfig,
  writeDatabaseConfigs,
  validateDatabaseConfig,
  testDatabaseConfig,
  inspectDatabaseConfig,
  getMongoDatabaseNameFromUri
};
