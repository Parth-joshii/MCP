const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { databaseToolImplementations } = require('./databaseTools');
const { documentToolImplementations } = require('./documentTools');
const { listResources, readResource } = require('./resources');
const { getDatabaseConnectors } = require('./databaseRegistry');
const documentRegistry = require('./documentRegistry');

const SERVER_INFO = {
  name: 'generic-database-mcp',
  version: '1.0.0'
};

const jsonObject = z.record(z.string(), z.any());
const filtersInput = z.union([jsonObject, z.array(jsonObject)]);

const toToolResult = (result) => {
  if (result && Array.isArray(result.content)) {
    const structuredContent = result.structuredContent;
    return {
      ...result,
      structuredContent: structuredContent && !Array.isArray(structuredContent)
        ? structuredContent
        : { result: structuredContent ?? result.content }
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result && !Array.isArray(result) ? result : { result }
  };
};

const registerDatabaseTools = (server) => {
  server.registerTool(
    'database.list_connections',
    {
      title: 'List Database Connections',
      description: 'List database connections that this MCP server can access.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => toToolResult(await databaseToolImplementations['database.list_connections']({}))
  );

  server.registerTool(
    'database.describe',
    {
      title: 'Describe Database',
      description: 'Describe schemas, tables, collections, fields, and small samples for a database connection.',
      inputSchema: z.object({
        databaseId: z.string().describe('Database connection id from database.list_connections.')
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.describe'](args))
  );

  server.registerTool(
    'database.count_rows',
    {
      title: 'Count Rows',
      description: 'Count all rows/documents across every table or collection in a database connection.',
      inputSchema: z.object({
        databaseId: z.string().describe('Database connection id from database.list_connections.')
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.count_rows'](args))
  );

  server.registerTool(
    'database.query',
    {
      title: 'Query Database',
      description: 'Run a read-only query. MongoDB supports find, count, distinct, and aggregate. SQL adapters accept SELECT/WITH statements.',
      inputSchema: z.object({
        databaseId: z.string(),
        collection: z.string().optional(),
        table: z.string().optional(),
        operation: z.enum(['find', 'count', 'distinct', 'aggregate']).optional().default('find'),
        filter: jsonObject.optional(),
        projection: jsonObject.optional(),
        sort: jsonObject.optional(),
        field: z.string().optional(),
        pipeline: z.array(z.any()).optional(),
        limit: z.number().int().positive().optional(),
        sql: z.string().optional(),
        params: z.array(z.any()).optional()
      }).passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.query'](args))
  );

  server.registerTool(
    'database.write',
    {
      title: 'Write Database',
      description: 'Run an explicit write. Disabled unless MCP_ALLOW_DB_WRITES=true.',
      inputSchema: z.object({
        databaseId: z.string(),
        collection: z.string().optional(),
        table: z.string().optional(),
        operation: z.enum(['insertOne', 'updateOne', 'deleteOne']).optional(),
        filter: jsonObject.optional(),
        update: jsonObject.optional(),
        document: jsonObject.optional(),
        sql: z.string().optional(),
        params: z.array(z.any()).optional()
      }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.write'](args))
  );

  server.registerTool(
    'database.create_snapshot',
    {
      title: 'Create Database Snapshot',
      description: 'Create a local original and working JSON snapshot of a configured database connection.',
      inputSchema: z.object({
        databaseId: z.string(),
        limitPerSource: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.create_snapshot'](args))
  );

  server.registerTool(
    'database.list_snapshots',
    {
      title: 'List Database Snapshots',
      description: 'List local database snapshots and their original/working copies.',
      inputSchema: z.object({
        databaseId: z.string().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.list_snapshots'](args))
  );

  server.registerTool(
    'database.query_snapshot',
    {
      title: 'Query Database Snapshot',
      description: 'Query the editable working copy of a database snapshot.',
      inputSchema: z.object({
        snapshotId: z.string(),
        source: z.string().optional(),
        filters: filtersInput.optional(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.query_snapshot'](args))
  );

  server.registerTool(
    'database.preview_snapshot_update',
    {
      title: 'Preview Snapshot Update',
      description: 'Preview a working-copy database snapshot update before applying it.',
      inputSchema: z.object({
        snapshotId: z.string(),
        source: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional(),
        field: z.string(),
        value: z.any(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.preview_snapshot_update'](args))
  );

  server.registerTool(
    'database.update_snapshot_rows',
    {
      title: 'Update Snapshot Rows',
      description: 'Apply an update to the editable working copy of a database snapshot.',
      inputSchema: z.object({
        snapshotId: z.string(),
        source: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional(),
        field: z.string(),
        value: z.any()
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.update_snapshot_rows'](args))
  );

  server.registerTool(
    'database.add_snapshot_row',
    {
      title: 'Add Snapshot Row',
      description: 'Add a row/document to the editable working copy of a database snapshot.',
      inputSchema: z.object({
        snapshotId: z.string(),
        source: z.string().optional(),
        row: jsonObject
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.add_snapshot_row'](args))
  );

  server.registerTool(
    'database.delete_snapshot_rows',
    {
      title: 'Delete Snapshot Rows',
      description: 'Delete rows/documents from the editable working copy of a database snapshot.',
      inputSchema: z.object({
        snapshotId: z.string(),
        source: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional()
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await databaseToolImplementations['database.delete_snapshot_rows'](args))
  );
};

const registerDocumentTools = (server) => {
  server.registerTool(
    'document.list_sources',
    {
      title: 'List Document Sources',
      description: 'List uploaded document sources available to this MCP server.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => toToolResult(await documentToolImplementations['document.list_sources']({}))
  );

  server.registerTool(
    'document.describe',
    {
      title: 'Describe Document',
      description: 'Describe an uploaded document, including sheets, columns, chunks, page count, and metadata.',
      inputSchema: z.object({
        documentId: z.string()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.describe'](args))
  );

  server.registerTool(
    'document.search',
    {
      title: 'Search Documents',
      description: 'Search text chunks and table rows across uploaded PDF, Word, text, CSV, and Excel documents.',
      inputSchema: z.object({
        query: z.string(),
        documentId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.search'](args))
  );

  server.registerTool(
    'document.query_table',
    {
      title: 'Query Document Table',
      description: 'Query rows from a CSV or Excel document sheet with optional contains filters.',
      inputSchema: z.object({
        documentId: z.string(),
        sheetName: z.string().optional(),
        filters: filtersInput.optional(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.query_table'](args))
  );

  server.registerTool(
    'document.answer_table_question',
    {
      title: 'Answer Document Table Question',
      description: 'Answer a natural-language question over an Excel or CSV table, especially date/product row lookup questions.',
      inputSchema: z.object({
        documentId: z.string(),
        question: z.string(),
        sheetName: z.string().optional(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.answer_table_question'](args))
  );

  server.registerTool(
    'document.answer_text_question',
    {
      title: 'Answer Document Text Question',
      description: 'Answer a natural-language question over a PDF, Word, text, or markdown document by retrieving the most relevant chunks first.',
      inputSchema: z.object({
        documentId: z.string(),
        question: z.string(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.answer_text_question'](args))
  );

  server.registerTool(
    'document.preview_update_cell',
    {
      title: 'Preview Document Cell Update',
      description: 'Preview an Excel/CSV table cell update before applying it.',
      inputSchema: z.object({
        documentId: z.string(),
        sheetName: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional(),
        column: z.string(),
        value: z.any(),
        limit: z.number().int().positive().optional()
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.preview_update_cell'](args))
  );

  server.registerTool(
    'document.update_cell',
    {
      title: 'Update Document Cell',
      description: 'Apply an Excel/CSV table cell update after the user confirms the preview.',
      inputSchema: z.object({
        documentId: z.string(),
        sheetName: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional(),
        column: z.string(),
        value: z.any()
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.update_cell'](args))
  );

  server.registerTool(
    'document.add_row',
    {
      title: 'Add Document Row',
      description: 'Add a row to an Excel/CSV table document.',
      inputSchema: z.object({
        documentId: z.string(),
        sheetName: z.string().optional(),
        row: jsonObject
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.add_row'](args))
  );

  server.registerTool(
    'document.delete_rows',
    {
      title: 'Delete Document Rows',
      description: 'Delete rows from an Excel/CSV table document by row index or filters.',
      inputSchema: z.object({
        documentId: z.string(),
        sheetName: z.string().optional(),
        rowIndex: z.number().int().nonnegative().optional(),
        rowIndexes: z.array(z.number().int().nonnegative()).optional(),
        filters: filtersInput.optional(),
        allowAll: z.boolean().optional()
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toToolResult(await documentToolImplementations['document.delete_rows'](args))
  );
};

const registerDatabaseResources = (server) => {
  server.registerResource(
    'database-schemas',
    new ResourceTemplate('database://{databaseId}/schema', {
      list: async () => {
        const resources = [];
        for (const connector of getDatabaseConnectors()) {
          resources.push({
            uri: `database://${connector.id}/schema`,
            name: `${connector.id} schema`,
            description: `Schema metadata for database connection ${connector.id}`,
            mimeType: 'application/json'
          });
        }
        return { resources };
      },
      complete: {
        databaseId: async (value) => getDatabaseConnectors()
          .map((connector) => connector.id)
          .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: 'Database Schemas',
      description: 'Schema resources for configured database connections.',
      mimeType: 'application/json'
    },
    async (uri) => readResource(uri.toString())
  );

  server.registerResource(
    'database-collections',
    new ResourceTemplate('database://{databaseId}/collections/{collection}', {
      list: async () => {
        try {
          const resources = await listResources();
          return {
            resources: resources.filter((resource) => resource.uri.includes('/collections/'))
          };
        } catch (error) {
          return { resources: [] };
        }
      },
      complete: {
        databaseId: async (value) => getDatabaseConnectors()
          .map((connector) => connector.id)
          .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: 'Database Collections',
      description: 'Sample data resources for MongoDB collections.',
      mimeType: 'application/json'
    },
    async (uri) => readResource(uri.toString())
  );
};

const registerDocumentResources = (server) => {
  server.registerResource(
    'document-metadata',
    new ResourceTemplate('document://{documentId}/metadata', {
      list: async () => ({
        resources: documentRegistry.listDocuments().map((doc) => ({
          uri: `document://${doc.id}/metadata`,
          name: `${doc.name} metadata`,
          description: `Metadata for ${doc.name}`,
          mimeType: 'application/json'
        }))
      }),
      complete: {
        documentId: async (value) => documentRegistry.listDocuments()
          .map((doc) => doc.id)
          .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: 'Document Metadata',
      description: 'Metadata resources for uploaded documents.',
      mimeType: 'application/json'
    },
    async (uri) => readResource(uri.toString())
  );

  server.registerResource(
    'document-sheets',
    new ResourceTemplate('document://{documentId}/sheets/{sheetName}', {
      list: async () => ({
        resources: documentRegistry.listResources().filter((resource) => resource.uri.includes('/sheets/'))
      }),
      complete: {
        documentId: async (value) => documentRegistry.listDocuments()
          .map((doc) => doc.id)
          .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: 'Document Sheets',
      description: 'Sheet resources for uploaded Excel and CSV documents.',
      mimeType: 'application/json'
    },
    async (uri) => readResource(uri.toString())
  );

  server.registerResource(
    'document-chunks',
    new ResourceTemplate('document://{documentId}/chunks/{chunkIndex}', {
      list: async () => ({
        resources: documentRegistry.listResources().filter((resource) => resource.uri.includes('/chunks/'))
      }),
      complete: {
        documentId: async (value) => documentRegistry.listDocuments()
          .map((doc) => doc.id)
          .filter((id) => id.startsWith(value))
      }
    }),
    {
      title: 'Document Chunks',
      description: 'Text chunk resources for uploaded PDF, Word, text, and table documents.',
      mimeType: 'text/plain'
    },
    async (uri) => readResource(uri.toString())
  );
};

const registerPrompts = (server) => {
  server.registerPrompt(
    'database-investigate',
    {
      title: 'Investigate a database',
      description: 'Guide a model to inspect database connections, read schema resources, then run read-only queries.',
      argsSchema: {
        question: z.string().describe('The user question about the database.'),
        databaseId: z.string().optional().describe('Optional database connection id.')
      }
    },
    async ({ question, databaseId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Use the MCP database workflow:',
              '1. Call database.list_connections if the database id is unknown.',
              '2. Read the schema resource or call database.describe before querying unknown tables/collections.',
              '3. Prefer database.query for live read-only questions.',
              '4. For safe edits, call database.create_snapshot first, mutate the snapshot working copy with database.preview_snapshot_update then database.update_snapshot_rows only after explicit confirmation.',
              '5. Avoid live database.write unless explicitly requested and enabled.',
              '',
              databaseId ? `Preferred databaseId: ${databaseId}` : 'No databaseId was provided.',
              `Question: ${question}`
            ].join('\n')
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'document-investigate',
    {
      title: 'Investigate documents',
      description: 'Guide a model to list documents, inspect metadata, search chunks, and query table sheets.',
      argsSchema: {
        question: z.string().describe('The user question about uploaded documents.'),
        documentId: z.string().optional().describe('Optional uploaded document id.')
      }
    },
    async ({ question, documentId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Use the MCP document workflow:',
              '1. Call document.list_sources if the document id is unknown.',
              '2. Call document.describe to understand sheets, columns, chunks, and metadata.',
              '3. Use document.answer_text_question for PDF/Word/text questions, and document.search when the user only asks to search.',
              '4. Use document.query_table or document.answer_table_question for Excel/CSV row questions.',
              '5. For edits, call document.preview_update_cell first and only call document.update_cell, document.add_row, or document.delete_rows after explicit user confirmation.',
              '6. Cite document ids, sheet names, row indexes, or chunk URIs in the answer.',
              '',
              documentId ? `Preferred documentId: ${documentId}` : 'No documentId was provided.',
              `Question: ${question}`
            ].join('\n')
          }
        }
      ]
    })
  );
};

const createDatabaseMcpServer = () => {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true }
    }
  });

  registerDatabaseTools(server);
  registerDocumentTools(server);
  registerDatabaseResources(server);
  registerDocumentResources(server);
  registerPrompts(server);

  return server;
};

module.exports = {
  SERVER_INFO,
  createDatabaseMcpServer
};
