import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Database, Download, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import api from '../services/api';

const emptyForm = {
  id: '',
  type: 'mongodb',
  uri: '',
  path: '',
  description: ''
};

const placeholders = {
  mongodb: 'mongodb://localhost:27017/my_database',
  postgres: 'postgres://user:password@localhost:5432/my_database',
  mysql: 'mysql://user:password@localhost:3306/my_database',
  sqlite: './data/app.sqlite'
};

const DatabaseAccess = () => {
  const [connections, setConnections] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [configPath, setConfigPath] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [snapshotting, setSnapshotting] = useState(null);
  const [message, setMessage] = useState(null);

  const isSqlite = form.type === 'sqlite';

  const canSubmit = useMemo(() => {
    return form.id.trim() && (isSqlite ? form.path.trim() || form.uri.trim() : form.uri.trim());
  }, [form, isSqlite]);

  const showMessage = (type, text) => setMessage({ type, text });

  const inspectionMessage = (inspection, fallback = 'Database connection is ready.') => {
    if (!inspection) return fallback;

    const summary = inspection.summary || {};
    const database = inspection.status?.database || summary.database || inspection.status?.id || 'database';
    const sourceLabel = `${summary.sourceCount || 0} collection/table${summary.sourceCount === 1 ? '' : 's'}`;
    const rowLabel = Number.isFinite(Number(summary.estimatedRows))
      ? `, about ${summary.estimatedRows} row/document${summary.estimatedRows === 1 ? '' : 's'}`
      : '';
    const samples = summary.sampleQuestions?.length
      ? ` Try: ${summary.sampleQuestions.slice(0, 2).join(' | ')}`
      : '';

    return `${inspection.ready ? 'Ready' : 'Connected but empty'}: ${database} has ${sourceLabel}${rowLabel}.${samples}`;
  };

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const [connectionsRes, snapshotsRes] = await Promise.all([
        api.get('/database-connections'),
        api.get('/database-connections/snapshots')
      ]);
      setConnections(connectionsRes.data.connections || []);
      setConfigPath(connectionsRes.data.configPath || '');
      setSnapshots(snapshotsRes.data.snapshots || []);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSnapshot = async (id) => {
    setSnapshotting(id);
    setMessage(null);
    try {
      const res = await api.post(`/database-connections/${id}/snapshots`, {});
      await fetchConnections();
      showMessage('success', `Created working copy ${res.data.snapshot.id}.`);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setSnapshotting(null);
    }
  };

  const handleDeleteSnapshot = async (id) => {
    setMessage(null);
    try {
      await api.delete(`/database-connections/snapshots/${id}`);
      await fetchConnections();
      showMessage('success', `Removed snapshot ${id}.`);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    }
  };

  const snapshotDownloadUrl = (id, variant) => `${api.defaults.baseURL}/database-connections/snapshots/${id}/download/${variant}`;

  useEffect(() => {
    fetchConnections();
  }, []);

  const buildPayload = () => ({
    id: form.id.trim(),
    type: form.type,
    uri: isSqlite ? form.uri.trim() || undefined : form.uri.trim(),
    path: isSqlite ? form.path.trim() || undefined : undefined,
    description: form.description.trim() || undefined
  });

  const handleTest = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const res = await api.post('/database-connections/test', buildPayload());
      showMessage(res.data.inspection?.ready ? 'success' : 'warning', inspectionMessage(res.data.inspection, 'Connection test passed.'));
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.post('/database-connections', buildPayload());
      setConnections(res.data.connections || []);
      setConfigPath(res.data.configPath || '');
      setForm(emptyForm);
      showMessage(res.data.inspection?.ready ? 'success' : 'warning', `Database access saved. ${inspectionMessage(res.data.inspection, 'MCP tools can use it now.')}`);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setMessage(null);
    try {
      const res = await api.delete(`/database-connections/${id}`);
      setConnections(res.data.connections || []);
      setConfigPath(res.data.configPath || '');
      showMessage('success', `Removed ${id}.`);
    } catch (error) {
      showMessage('error', error.response?.data?.msg || error.message);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">Database Access</h2>
            <p className="text-sm text-gray-500 mt-1">
              Add a connection once, then use its id in chat or any MCP client.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchConnections}
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
              : message.type === 'warning'
                ? 'bg-amber-50 text-amber-800 border-amber-100'
              : 'bg-red-50 text-red-800 border-red-100'
          }`}>
            {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
            <span>{message.text}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Connection ID</span>
            <input
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
              placeholder="sales-db"
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Database Type</span>
            <select
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value })}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="mongodb">MongoDB</option>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="sqlite">SQLite</option>
            </select>
          </label>

          {isSqlite ? (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">SQLite File Path</span>
              <input
                value={form.path}
                onChange={(event) => setForm({ ...form, path: event.target.value })}
                placeholder={placeholders.sqlite}
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
          ) : (
            <label className="block lg:col-span-2">
              <span className="text-sm font-medium text-gray-700">Connection URI</span>
              <input
                value={form.uri}
                onChange={(event) => setForm({ ...form, uri: event.target.value })}
                placeholder={placeholders[form.type]}
                className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
          )}

          <label className="block lg:col-span-2">
            <span className="text-sm font-medium text-gray-700">Description</span>
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Main reporting database"
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <div className="lg:col-span-2 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleTest}
              disabled={!canSubmit || testing}
              className="inline-flex items-center gap-2 px-4 py-2 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-50"
            >
              <PlugZap className="w-4 h-4" />
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Database className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Access'}
            </button>
          </div>
        </form>
      </section>

      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">Configured Connections</h3>
          {configPath && <span className="text-xs text-gray-400 font-mono">{configPath}</span>}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading connections...</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-gray-500">No database connections saved yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Access</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {connections.map((connection) => (
                  <tr key={connection.id}>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{connection.id}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {connection.type}{connection.database ? ` (${connection.database})` : ''}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono max-w-sm truncate">
                      {connection.uri || connection.path}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{connection.description}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleCreateSnapshot(connection.id)}
                        disabled={snapshotting === connection.id}
                        className="mr-2 inline-flex items-center gap-2 px-3 py-2 text-sm text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                        title="Create original and working database snapshot"
                      >
                        <Copy className="w-4 h-4" />
                        {snapshotting === connection.id ? 'Copying...' : 'Snapshot'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(connection.id)}
                        className="inline-flex items-center justify-center w-8 h-8 text-red-600 hover:bg-red-50 rounded-lg"
                        title="Remove connection"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white border border-gray-100 rounded-lg shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">Database Working Copies</h3>
          <span className="text-xs text-gray-400">Stored under database-store</span>
        </div>

        {snapshots.length === 0 ? (
          <p className="text-sm text-gray-500">No database snapshots created yet.</p>
        ) : (
          <div className="grid gap-4">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} className="border border-gray-200 rounded-lg p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-blue-600" />
                    <h4 className="font-medium text-gray-900 truncate">{snapshot.id}</h4>
                  </div>
                  <p className="text-xs text-gray-500 font-mono mt-1">
                    {snapshot.databaseId} ({snapshot.databaseType})
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    {snapshot.sourceCount} source{snapshot.sourceCount === 1 ? '' : 's'}, {snapshot.rowCount} copied row{snapshot.rowCount === 1 ? '' : 's'}
                  </p>
                  {snapshot.sources?.length > 0 && (
                    <p className="text-sm text-gray-500 mt-1">
                      Sources: {snapshot.sources.map((source) => `${source.name} (${source.rowCount})`).join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={snapshotDownloadUrl(snapshot.id, 'original')}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                    title="Download original database snapshot"
                  >
                    <Download className="w-4 h-4" />
                    Original
                  </a>
                  <a
                    href={snapshotDownloadUrl(snapshot.id, 'working')}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50"
                    title="Download updated working database snapshot"
                  >
                    <Download className="w-4 h-4" />
                    Updated
                  </a>
                  <button
                    type="button"
                    onClick={() => handleDeleteSnapshot(snapshot.id)}
                    className="inline-flex items-center justify-center w-8 h-8 text-red-600 hover:bg-red-50 rounded-lg"
                    title="Remove snapshot"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default DatabaseAccess;
