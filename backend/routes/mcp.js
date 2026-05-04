const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { processQuery, optimizePrompt, preparePromptForQuery } = require('../mcp/agent');
const { toolDefinitions } = require('../mcp/tools');
const { executeTool } = require('../mcp/toolExecutor');
const { listResources, readResource } = require('../mcp/resources');

const serverInfo = {
  name: 'generic-database-mcp',
  version: '1.0.0'
};

router.get('/capabilities', (req, res) => {
  res.json({
    protocolVersion: '2024-11-05',
    serverInfo,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false }
    }
  });
});

// @route   GET /api/mcp/tools
// @desc    List MCP tools available to the AI agent
// @access  Public
router.get('/tools', (req, res) => {
  res.json({ tools: toolDefinitions });
});

// @route   POST /api/mcp/tools/call
// @desc    Execute a tool directly using MCP-style shape
// @access  Public
router.post('/tools/call', async (req, res) => {
  const { name, arguments: toolArguments = {} } = req.body;

  if (!name) {
    return res.status(400).json({ msg: 'Tool name is required' });
  }

  res.json(await executeTool(name, toolArguments));
});

// Backward compatible direct tool execution endpoint.
router.post('/execute', async (req, res) => {
  const { tool, parameters = {} } = req.body;
  if (!tool) return res.status(400).json({ msg: 'Tool is required' });

  const result = await executeTool(tool, parameters);
  res.json({ toolUsed: tool, toolResult: result });
});

router.get('/resources', async (req, res) => {
  try {
    res.json({ resources: await listResources() });
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
});

router.get('/resources/read', async (req, res) => {
  try {
    if (!req.query.uri) return res.status(400).json({ msg: 'uri is required' });
    res.json(await readResource(req.query.uri));
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
});

router.post('/initialize', (req, res) => {
  res.json({
    protocolVersion: req.body.protocolVersion || '2024-11-05',
    serverInfo,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false }
    }
  });
});

router.post('/rpc', async (req, res) => {
  const { id, method, params = {} } = req.body;

  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: params.protocolVersion || '2024-11-05',
        serverInfo,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false }
        }
      });
    }

    if (method === 'tools/list') {
      return ok({ tools: toolDefinitions });
    }

    if (method === 'tools/call') {
      if (!params.name) return fail(-32602, 'params.name is required');
      return ok(await executeTool(params.name, params.arguments || {}));
    }

    if (method === 'resources/list') {
      return ok({ resources: await listResources() });
    }

    if (method === 'resources/read') {
      if (!params.uri) return fail(-32602, 'params.uri is required');
      return ok(await readResource(params.uri));
    }

    return fail(-32601, `Unsupported MCP method: ${method}`);
  } catch (error) {
    return fail(-32000, error.message);
  }
});

// @route   POST /api/mcp/chat
// @desc    Send a message to the AI agent
// @access  Public
router.post('/chat', async (req, res) => {
  const { message, context = {} } = req.body;
  if (!message) {
    return res.status(400).json({ msg: 'Message is required' });
  }

  try {
    const result = await processQuery(message, context);
    if (result.error) {
      return res.status(200).json({ response: result.error, isError: true });
    }
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(200).json({ response: `Server Error: ${err.message}`, isError: true });
  }
});

router.post('/prompt/optimize', (req, res) => {
  const { prompt, context = {} } = req.body;
  if (!prompt) {
    return res.status(400).json({ msg: 'Prompt is required' });
  }

  res.json({ promptRewrite: optimizePrompt(prompt, context) });
});

router.post('/prompt/enhance', async (req, res) => {
  const { prompt, context = {} } = req.body;
  if (!prompt) {
    return res.status(400).json({ msg: 'Prompt is required' });
  }

  res.json({
    promptRewrite: await preparePromptForQuery(prompt, { ...context, enhancePrompt: true })
  });
});

module.exports = router;
