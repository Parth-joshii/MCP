require('dotenv').config({ quiet: true });

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createDatabaseMcpServer } = require('./mcp/officialServer');

const main = async () => {
  const server = createDatabaseMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
