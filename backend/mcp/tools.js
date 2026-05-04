const { databaseToolDefinitions, databaseToolImplementations } = require('./databaseTools');
const { documentToolDefinitions, documentToolImplementations } = require('./documentTools');

const toolDefinitions = [
  ...databaseToolDefinitions,
  ...documentToolDefinitions
];

const toolImplementations = {
  ...databaseToolImplementations,
  ...documentToolImplementations
};

module.exports = { toolDefinitions, toolImplementations };
