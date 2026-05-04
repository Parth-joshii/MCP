const { getDatabaseConnectors, getDatabaseConnector } = require('./databaseRegistry');
const {
  createDatabaseSnapshot,
  listDatabaseSnapshots,
  queryDatabaseSnapshot,
  previewSnapshotUpdate,
  updateSnapshotRows,
  addSnapshotRow,
  deleteSnapshotRows
} = require('./databaseSnapshotRegistry');

const filtersSchema = {
  oneOf: [
    { type: 'object' },
    { type: 'array', items: { type: 'object' } }
  ]
};

const databaseToolDefinitions = [
  {
    name: 'database.list_connections',
    description: 'List database connections that this MCP server can access.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'database.describe',
    description: 'Describe schemas, tables, collections, fields, and small samples for a database connection.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string', description: 'Database connection id from database.list_connections.' }
      },
      required: ['databaseId'],
      additionalProperties: false
    }
  },
  {
    name: 'database.count_rows',
    description: 'Count all rows/documents across every table or collection in a database connection.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string', description: 'Database connection id from database.list_connections.' }
      },
      required: ['databaseId'],
      additionalProperties: false
    }
  },
  {
    name: 'database.query',
    description: 'Run a read-only query against a database. MongoDB supports find, count, distinct, and aggregate.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string' },
        collection: { type: 'string', description: 'MongoDB collection name.' },
        table: { type: 'string', description: 'SQL table name, when SQL adapters are enabled.' },
        operation: { type: 'string', enum: ['find', 'count', 'distinct', 'aggregate'], default: 'find' },
        filter: { type: 'object' },
        projection: { type: 'object' },
        sort: { type: 'object' },
        field: { type: 'string' },
        pipeline: { type: 'array' },
        limit: { type: 'number' },
        sql: { type: 'string', description: 'Read-only SQL statement, when SQL adapters are enabled.' },
        params: { type: 'array', description: 'SQL query parameters.' }
      },
      required: ['databaseId'],
      additionalProperties: true
    }
  },
  {
    name: 'database.write',
    description: 'Run an explicit write. Disabled unless MCP_ALLOW_DB_WRITES=true.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string' },
        collection: { type: 'string' },
        table: { type: 'string' },
        operation: { type: 'string', enum: ['insertOne', 'updateOne', 'deleteOne'] },
        filter: { type: 'object' },
        update: { type: 'object' },
        document: { type: 'object' },
        sql: { type: 'string' },
        params: { type: 'array' }
      },
      required: ['databaseId', 'operation'],
      additionalProperties: true
    }
  },
  {
    name: 'database.create_snapshot',
    description: 'Create a local original and working JSON snapshot of a configured database connection. This does not mutate the live database.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string' },
        limitPerSource: { type: 'number' }
      },
      required: ['databaseId'],
      additionalProperties: false
    }
  },
  {
    name: 'database.list_snapshots',
    description: 'List local database snapshots and their original/working copy paths.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'database.query_snapshot',
    description: 'Query the editable working copy of a database snapshot with optional contains filters.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        source: { type: 'string', description: 'Collection or table name inside the snapshot.' },
        filters: filtersSchema,
        limit: { type: 'number' }
      },
      required: ['snapshotId'],
      additionalProperties: false
    }
  },
  {
    name: 'database.preview_snapshot_update',
    description: 'Preview a working-copy database snapshot row update before applying it.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        source: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' },
        field: { type: 'string' },
        value: {},
        limit: { type: 'number' }
      },
      required: ['snapshotId', 'field', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'database.update_snapshot_rows',
    description: 'Apply a row update to the editable working copy of a database snapshot after confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        source: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' },
        field: { type: 'string' },
        value: {}
      },
      required: ['snapshotId', 'field', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'database.add_snapshot_row',
    description: 'Add a row/document to the editable working copy of a database snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        source: { type: 'string' },
        row: { type: 'object' }
      },
      required: ['snapshotId', 'row'],
      additionalProperties: false
    }
  },
  {
    name: 'database.delete_snapshot_rows',
    description: 'Delete rows/documents from the editable working copy of a database snapshot by row index or filters.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        source: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' }
      },
      required: ['snapshotId'],
      additionalProperties: false
    }
  }
];

const asMcpContent = (value) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(value, null, 2)
    }
  ],
  structuredContent: value
});

const databaseToolImplementations = {
  'database.list_connections': async () => {
    const statuses = [];
    for (const connector of getDatabaseConnectors()) {
      statuses.push(await connector.status());
    }
    return asMcpContent(statuses);
  },

  'database.describe': async (args = {}) => {
    const connector = getDatabaseConnector(args.databaseId);
    return asMcpContent(await connector.describe());
  },

  'database.count_rows': async (args = {}) => {
    const connector = getDatabaseConnector(args.databaseId);
    return asMcpContent(await connector.countRows());
  },

  'database.query': async (args = {}) => {
    const connector = getDatabaseConnector(args.databaseId);
    return asMcpContent(await connector.query(args));
  },

  'database.write': async (args = {}) => {
    const connector = getDatabaseConnector(args.databaseId);
    return asMcpContent(await connector.write(args));
  },

  'database.create_snapshot': async (args = {}) => asMcpContent(await createDatabaseSnapshot(args)),
  'database.list_snapshots': async (args = {}) => asMcpContent(listDatabaseSnapshots(args)),
  'database.query_snapshot': async (args = {}) => asMcpContent(queryDatabaseSnapshot(args)),
  'database.preview_snapshot_update': async (args = {}) => asMcpContent(previewSnapshotUpdate(args)),
  'database.update_snapshot_rows': async (args = {}) => asMcpContent(updateSnapshotRows(args)),
  'database.add_snapshot_row': async (args = {}) => asMcpContent(addSnapshotRow(args)),
  'database.delete_snapshot_rows': async (args = {}) => asMcpContent(deleteSnapshotRows(args))
};

module.exports = {
  databaseToolDefinitions,
  databaseToolImplementations,
  asMcpContent
};
