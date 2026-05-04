const express = require('express');
const multer = require('multer');
const path = require('path');
const {
  UPLOAD_DIR,
  ensureDocumentStore,
  saveUploadedDocument,
  listDocuments,
  describeDocument,
  searchDocuments,
  queryTable,
  deleteDocument,
  getDocumentFileInfo
} = require('../mcp/documentRegistry');

ensureDocumentStore();

const upload = multer({
  dest: path.join(UPLOAD_DIR, 'tmp'),
  limits: {
    fileSize: Number(process.env.MCP_DOCUMENT_MAX_UPLOAD_MB || 25) * 1024 * 1024
  }
});

const router = express.Router();

router.get('/', (req, res) => {
  try {
    res.json({ documents: listDocuments() });
  } catch (error) {
    res.status(500).json({ msg: error.message });
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: 'file is required.' });
    const document = await saveUploadedDocument(req.file);
    res.json({ document });
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    res.json({ document: describeDocument(req.params.id) });
  } catch (error) {
    res.status(404).json({ msg: error.message });
  }
});

router.get('/:id/download/:variant', (req, res) => {
  try {
    const file = getDocumentFileInfo(req.params.id, req.params.variant);
    res.download(file.path, file.fileName);
  } catch (error) {
    res.status(404).json({ msg: error.message });
  }
});

router.post('/search', (req, res) => {
  try {
    res.json({ results: searchDocuments(req.body) });
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

router.post('/query-table', (req, res) => {
  try {
    res.json(queryTable(req.body));
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    res.json({ document: deleteDocument(req.params.id) });
  } catch (error) {
    res.status(404).json({ msg: error.message });
  }
});

module.exports = router;
