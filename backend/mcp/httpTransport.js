const express = require('express');
const { randomUUID } = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createDatabaseMcpServer } = require('./officialServer');

const createMcpHttpRouter = () => {
  const router = express.Router();
  const transports = new Map();

  router.use(async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (sessionId && !transport) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'MCP session not found. Re-initialize the client session.'
          },
          id: null
        });
      }

      if (!transport) {
        const server = createDatabaseMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID()
        });

        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };

        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: error.message
          },
          id: null
        });
      }
    }
  });

  return router;
};

module.exports = {
  createMcpHttpRouter
};
