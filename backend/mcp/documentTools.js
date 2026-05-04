const {
  listDocuments,
  describeDocument,
  searchDocuments,
  queryTable,
  previewTableUpdate,
  updateTableCell,
  addTableRow,
  deleteTableRows,
  answerTextQuestion,
  answerTableQuestion
} = require('./documentRegistry');
const { asMcpContent } = require('./databaseTools');

const filtersSchema = {
  oneOf: [
    { type: 'object' },
    { type: 'array', items: { type: 'object' } }
  ]
};

const documentToolDefinitions = [
  {
    name: 'document.list_sources',
    description: 'List uploaded document sources available to this MCP server.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'document.describe',
    description: 'Describe an uploaded document, including sheets, columns, chunks, page count, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'document.search',
    description: 'Search text chunks and table rows across uploaded PDF, Word, text, CSV, and Excel documents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        documentId: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'document.query_table',
    description: 'Query rows from a CSV or Excel document sheet with optional contains filters.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sheetName: { type: 'string' },
        filters: filtersSchema,
        limit: { type: 'number' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  },
  {
    name: 'document.answer_table_question',
    description: 'Answer a natural-language question over an Excel or CSV table, especially date/product row lookup questions.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        question: { type: 'string' },
        sheetName: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['documentId', 'question'],
      additionalProperties: false
    }
  },
  {
    name: 'document.answer_text_question',
    description: 'Answer a natural-language question over a PDF, Word, text, or markdown document by retrieving the most relevant chunks first.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        question: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['documentId', 'question'],
      additionalProperties: false
    }
  },
  {
    name: 'document.preview_update_cell',
    description: 'Preview an Excel/CSV table cell update before applying it. Use this before document.update_cell.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sheetName: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' },
        column: { type: 'string' },
        value: {},
        limit: { type: 'number' }
      },
      required: ['documentId', 'column', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'document.update_cell',
    description: 'Apply an Excel/CSV table cell update after the user confirms the preview.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sheetName: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' },
        column: { type: 'string' },
        value: {}
      },
      required: ['documentId', 'column', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'document.add_row',
    description: 'Add a row to an Excel/CSV table document. This mutates the MCP document source.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sheetName: { type: 'string' },
        row: { type: 'object' }
      },
      required: ['documentId', 'row'],
      additionalProperties: false
    }
  },
  {
    name: 'document.delete_rows',
    description: 'Delete rows from an Excel/CSV table document by row index or filters. This mutates the MCP document source.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sheetName: { type: 'string' },
        rowIndex: { type: 'number' },
        rowIndexes: { type: 'array', items: { type: 'number' } },
        filters: filtersSchema,
        allowAll: { type: 'boolean' }
      },
      required: ['documentId'],
      additionalProperties: false
    }
  }
];

const documentToolImplementations = {
  'document.list_sources': async () => asMcpContent(listDocuments()),
  'document.describe': async (args = {}) => asMcpContent(describeDocument(args.documentId)),
  'document.search': async (args = {}) => asMcpContent(searchDocuments(args)),
  'document.query_table': async (args = {}) => asMcpContent(queryTable(args)),
  'document.preview_update_cell': async (args = {}) => asMcpContent(previewTableUpdate(args)),
  'document.update_cell': async (args = {}) => asMcpContent(updateTableCell(args)),
  'document.add_row': async (args = {}) => asMcpContent(addTableRow(args)),
  'document.delete_rows': async (args = {}) => asMcpContent(deleteTableRows(args)),
  'document.answer_text_question': async (args = {}) => asMcpContent(answerTextQuestion(args)),
  'document.answer_table_question': async (args = {}) => asMcpContent(answerTableQuestion(args))
};

module.exports = {
  documentToolDefinitions,
  documentToolImplementations
};
