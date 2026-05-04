const { toolImplementations } = require('./tools');

const executeTool = async (toolName, toolArgs) => {
  if (toolImplementations[toolName]) {
    try {
      console.log(`Executing tool: ${toolName} with args:`, toolArgs);
      const result = await toolImplementations[toolName](toolArgs);
      return result;
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      return {
        isError: true,
        content: [{ type: 'text', text: error.message }],
        structuredContent: { error: error.message }
      };
    }
  } else {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool ${toolName} not found.` }],
      structuredContent: { error: `Tool ${toolName} not found.` }
    };
  }
};

module.exports = { executeTool };
