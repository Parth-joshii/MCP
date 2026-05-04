const { getDatabaseConnectors, getDatabaseConnector } = require('./databaseRegistry');
const documentResources = require('./documentRegistry');

const parseDatabaseUri = (uri) => {
  if ((uri || '').startsWith('document://')) return null;
  const match = /^database:\/\/([^/]+)\//.exec(uri || '');
  if (!match) throw new Error(`Unsupported resource URI: ${uri}`);
  return match[1];
};

const listResources = async () => {
  const resources = [];

  for (const connector of getDatabaseConnectors()) {
    resources.push(...await connector.listResources());
  }

  resources.push(...documentResources.listResources());

  return resources;
};

const readResource = async (uri) => {
  if ((uri || '').startsWith('document://')) {
    return documentResources.readResource(uri);
  }

  const databaseId = parseDatabaseUri(uri);
  const connector = getDatabaseConnector(databaseId);
  const data = await connector.readResource(uri);

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
};

module.exports = {
  listResources,
  readResource
};
