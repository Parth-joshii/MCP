const express = require('express');
const router = express.Router();
const {
  getDatabaseConfigPath,
  readDatabaseConfigs,
  redactDatabaseConfig,
  writeDatabaseConfigs,
  validateDatabaseConfig,
  inspectDatabaseConfig,
  resetDatabaseConnectors
} = require('../mcp/databaseRegistry');
const {
  createDatabaseSnapshot,
  listDatabaseSnapshots,
  deleteDatabaseSnapshot,
  getSnapshotFileInfo
} = require('../mcp/databaseSnapshotRegistry');

router.get('/', (req, res) => {
  try {
    const configs = readDatabaseConfigs().map(redactDatabaseConfig);
    res.json({
      configPath: getDatabaseConfigPath(),
      connections: configs
    });
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const config = validateDatabaseConfig(req.body);
    const inspection = await inspectDatabaseConfig(config);
    res.json({
      ok: true,
      status: inspection.status,
      inspection
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      msg: error.message
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const incoming = validateDatabaseConfig(req.body);
    const inspection = await inspectDatabaseConfig(incoming);
    const existing = readDatabaseConfigs();
    const next = [
      ...existing.filter((config) => config.id !== incoming.id),
      incoming
    ];

    const saved = writeDatabaseConfigs(next);
    res.json({
      configPath: getDatabaseConfigPath(),
      connections: saved.map(redactDatabaseConfig),
      inspection
    });
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

router.get('/snapshots', (req, res) => {
  try {
    res.json({ snapshots: listDatabaseSnapshots({ databaseId: req.query.databaseId }) });
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
});

router.post('/:id/snapshots', async (req, res) => {
  try {
    const snapshot = await createDatabaseSnapshot({
      databaseId: req.params.id,
      limitPerSource: req.body?.limitPerSource
    });
    res.json({ snapshot });
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

router.get('/snapshots/:snapshotId/download/:variant', (req, res) => {
  try {
    const file = getSnapshotFileInfo(req.params.snapshotId, req.params.variant);
    res.download(file.path, file.fileName);
  } catch (error) {
    res.status(404).json({ msg: error.message });
  }
});

router.delete('/snapshots/:snapshotId', (req, res) => {
  try {
    res.json({ snapshot: deleteDatabaseSnapshot(req.params.snapshotId) });
  } catch (error) {
    res.status(404).json({ msg: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const existing = readDatabaseConfigs();
    const next = existing.filter((config) => config.id !== req.params.id);

    if (next.length === existing.length) {
      return res.status(404).json({ msg: 'Connection not found.' });
    }

    const saved = writeDatabaseConfigs(next);
    resetDatabaseConnectors();
    res.json({
      configPath: getDatabaseConfigPath(),
      connections: saved.map(redactDatabaseConfig)
    });
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

module.exports = router;
