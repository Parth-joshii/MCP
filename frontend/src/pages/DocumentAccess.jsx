import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileSearch, FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import api from '../services/api';

const DocumentAccess = () => {
  const [documents, setDocuments] = useState([]);
  const [file, setFile] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState(null);

  const showMessage = (type, text) => setMessage({ type, text });

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const res = await api.get('/documents');
      setDocuments(res.data.documents || []);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!file) return;

    setUploading(true);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await api.post('/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setFile(null);
      await fetchDocuments();
      showMessage('success', `Uploaded ${res.data.document.name}.`);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setMessage(null);
    try {
      const res = await api.post('/documents/search', { query: query.trim(), limit: 8 });
      setResults(res.data.results || []);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setSearching(false);
    }
  };

  const handleDelete = async (id) => {
    setMessage(null);
    try {
      await api.delete(`/documents/${id}`);
      await fetchDocuments();
      showMessage('success', 'Document removed.');
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    }
  };

  const downloadUrl = (id, variant) => `${api.defaults.baseURL}/documents/${id}/download/${variant}`;

  return (
    <div className="space-y-6">
      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">Document Access</h2>
            <p className="text-sm text-gray-500 mt-1">
              Upload Excel, CSV, PDF, Word, or text files so the MCP agent can inspect and search them.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchDocuments}
            className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>

        {message && (
          <div className={`mb-5 flex items-start gap-2 rounded-lg border p-3 text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-800 border-green-100'
              : 'bg-red-50 text-red-800 border-red-100'
          }`}>
            {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
            <span>{message.text}</span>
          </div>
        )}

        <form onSubmit={handleUpload} className="flex flex-col gap-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">File</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.pdf,.docx,.txt,.md,.json"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="mt-1 block w-full text-sm text-gray-700 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-blue-700 hover:file:bg-blue-100"
            />
          </label>

          <button
            type="submit"
            disabled={!file || uploading}
            className="inline-flex w-fit items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Uploading...' : 'Upload Document'}
          </button>
        </form>
      </section>

      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-4">Uploaded Sources</h3>
        {loading ? (
          <p className="text-sm text-gray-500">Loading documents...</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-gray-500">No documents uploaded yet.</p>
        ) : (
          <div className="grid gap-4">
            {documents.map((doc) => (
              <div key={doc.id} className="border border-gray-200 rounded-lg p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-600" />
                    <h4 className="font-medium text-gray-900 truncate">{doc.name}</h4>
                  </div>
                  <p className="text-xs text-gray-500 font-mono mt-1">{doc.id}</p>
                  <p className="text-sm text-gray-500 mt-2">
                    {doc.kind === 'table'
                      ? `${doc.sheetCount} sheet${doc.sheetCount === 1 ? '' : 's'}`
                      : `${doc.chunkCount} text chunk${doc.chunkCount === 1 ? '' : 's'}`}
                    {doc.pageCount ? `, ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : ''}
                  </p>
                  {doc.sheets?.length > 0 && (
                    <p className="text-sm text-gray-500 mt-1">
                      Sheets: {doc.sheets.map((sheet) => `${sheet.name} (${sheet.rowCount})`).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={downloadUrl(doc.id, 'original')}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                    title="Download original untouched file"
                  >
                    <Download className="w-4 h-4" />
                    Original
                  </a>
                  <a
                    href={downloadUrl(doc.id, 'working')}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50"
                    title="Download updated working copy"
                  >
                    <Download className="w-4 h-4" />
                    Updated
                  </a>
                  <button
                    type="button"
                    onClick={() => handleDelete(doc.id)}
                    className="inline-flex items-center justify-center w-8 h-8 text-red-600 hover:bg-red-50 rounded-lg"
                    title="Remove document"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-4">Search Documents</h3>
        <form onSubmit={handleSearch} className="flex gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search uploaded documents..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!query.trim() || searching}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <FileSearch className="w-4 h-4" />
            {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        {results.length > 0 && (
          <div className="mt-5 space-y-3">
            {results.map((result, index) => (
              <div key={`${result.documentId}-${result.chunkIndex ?? result.rowIndex}-${index}`} className="border border-gray-200 rounded-lg p-3">
                <p className="text-sm font-medium text-gray-800">
                  {result.documentName}
                  {result.sheet ? ` - ${result.sheet} row ${result.rowIndex}` : ''}
                  {result.chunkIndex !== undefined ? ` - chunk ${result.chunkIndex}` : ''}
                </p>
                <p className="text-sm text-gray-500 mt-1 whitespace-pre-wrap">
                  {result.snippet || JSON.stringify(result.row)}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-2">{result.uri}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default DocumentAccess;
