import { useState, useRef, useEffect } from 'react';
import { RefreshCw, Send, Bot, User, Cpu } from 'lucide-react';
import api from '../services/api';

const getDatabaseDisplayName = (database) => {
  if (!database) return 'Selected database';
  if (database.database) return database.database;
  return database.id;
};

const getDatabaseOptionLabel = (database) => {
  const name = getDatabaseDisplayName(database);
  const type = database.type?.toUpperCase?.() || database.type || 'Database';
  return `${name} (${type})`;
};

const ChatAssistant = () => {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hello! Choose a database or document, then ask what you want to inspect.' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [scope, setScope] = useState('auto');
  const [databases, setDatabases] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState(() => localStorage.getItem('mcp:selectedDatabaseId') || '');
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(() => localStorage.getItem('mcp:enhancePrompt') === 'true');
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadSources = async () => {
    try {
      const [dbRes, docRes] = await Promise.all([
        api.get('/database-connections'),
        api.get('/documents')
      ]);

      const dbConnections = dbRes.data.connections || [];
      const docSources = docRes.data.documents || [];

      setDatabases(dbConnections);
      setDocuments(docSources);

      setSelectedDatabaseId((current) => {
        const remembered = current || localStorage.getItem('mcp:selectedDatabaseId') || '';
        const validRemembered = dbConnections.some((database) => database.id === remembered);
        const next = validRemembered ? remembered : dbConnections[0]?.id || '';
        if (next) localStorage.setItem('mcp:selectedDatabaseId', next);
        return next;
      });

      if (!selectedDocumentId && docSources[0]) {
        setSelectedDocumentId(docSources[0].id);
      }
    } catch (error) {
      console.error('Failed to load agent sources:', error);
    }
  };

  useEffect(() => {
    loadSources();
  }, []);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      if (scope === 'database' && !selectedDatabaseId) {
        throw new Error('Select a database first.');
      }

      const requestContext = { scope };
      requestContext.enhancePrompt = enhancePrompt;
      requestContext.useLlmMongoPlanner = enhancePrompt;
      if (scope !== 'document' && selectedDatabaseId) {
        requestContext.databaseId = selectedDatabaseId;
      }
      if (scope !== 'database' && selectedDocumentId) {
        requestContext.documentId = selectedDocumentId;
      }

      // Temporarily bypassing token auth in UI for testing if needed
      // but api service is set up
      const res = await api.post('/mcp/chat', {
        message: userMessage,
        context: requestContext
      });
      
      const { response, toolUsed, toolResult, isError, promptRewrite, llmMongoPlan, llmMongoExtractionPrompt } = res.data;

      setMessages(prev => [
        ...prev, 
        { 
          role: 'assistant', 
          content: response,
          toolUsed,
          toolResult,
          promptRewrite,
          llmMongoPlan,
          llmMongoExtractionPrompt,
          isError
        }
      ]);
    } catch (error) {
      console.error("Error communicating with AI:", error);
      const detail = error.response?.data?.msg || error.response?.data?.response || error.message;
      setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, I encountered an error processing your request: ${detail}`, isError: true }]);
    } finally {
      setIsLoading(false);
    }
  };

  const formatCellValue = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getTableData = (message) => {
    if (message.role !== 'assistant') return null;

    const data = message.toolResult?.structuredContent;
    const rows = Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(data) && message.toolUsed === 'database.query'
        ? data
        : [];

    if (rows.length === 0) return null;

    const columns = data?.columns?.length
      ? data.columns
      : Array.from(new Set(rows.flatMap((row) => Object.keys(row || {}))));

    if (columns.length === 0) return null;

    const matchedRows = data?.matchedRows ?? data?.totalRows;
    const caption = matchedRows && matchedRows > rows.length
      ? `Showing ${rows.length} of ${matchedRows} rows`
      : `Showing ${rows.length} rows`;

    return { rows, columns, caption };
  };

  const getPromptRewriteItems = (promptRewrite) => {
    if (!promptRewrite) return [];
    return Array.isArray(promptRewrite) ? promptRewrite.filter(Boolean) : [promptRewrite];
  };

  const MessageTable = ({ message }) => {
    const table = getTableData(message);
    if (!table) return null;

    return (
      <div className="mt-3 overflow-x-auto rounded border border-gray-200 bg-white">
        <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-200">
          {table.caption}
        </div>
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-gray-50">
            <tr>
              {table.columns.map((column) => (
                <th key={column} className="px-3 py-2 text-left font-semibold text-gray-700 border-b border-gray-200 whitespace-nowrap">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                {table.columns.map((column) => (
                  <td key={column} className="px-3 py-2 border-b border-gray-100 text-gray-800 whitespace-nowrap">
                    {formatCellValue(row?.[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
      <div className="p-4 border-b bg-gray-50">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center">
            <Bot className="w-6 h-6 text-blue-600 mr-2" />
            <div>
              <h3 className="font-semibold text-gray-800">MCP Agent</h3>
              <p className="text-xs text-gray-500">Choose a source, then query databases or documents.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white">
              <input
                type="checkbox"
                checked={enhancePrompt}
                onChange={(event) => {
                  setEnhancePrompt(event.target.checked);
                  localStorage.setItem('mcp:enhancePrompt', String(event.target.checked));
                }}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span>AI assist</span>
            </label>
            <button
              type="button"
              onClick={loadSources}
              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-white"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh Sources
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Query Source</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="auto">Auto choose</option>
              <option value="database">Database</option>
              <option value="document">Document</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600">Database</span>
            <select
              value={selectedDatabaseId}
              onChange={(event) => {
                setSelectedDatabaseId(event.target.value);
                localStorage.setItem('mcp:selectedDatabaseId', event.target.value);
              }}
              disabled={scope === 'document'}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
            >
              {databases.length === 0 ? (
                <option value="">No databases</option>
              ) : databases.map((database) => (
                <option key={database.id} value={database.id}>
                  {getDatabaseOptionLabel(database)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-600">Document</span>
            <select
              value={selectedDocumentId}
              onChange={(event) => setSelectedDocumentId(event.target.value)}
              disabled={scope === 'database'}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
            >
              <option value="">No document selected</option>
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex max-w-[80%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user' ? 'bg-blue-600 ml-3' : 'bg-green-600 mr-3'}`}>
                {msg.role === 'user' ? <User className="w-5 h-5 text-white" /> : <Bot className="w-5 h-5 text-white" />}
              </div>
              <div className="flex flex-col space-y-1">
                <div className={`p-3 rounded-lg ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : msg.isError ? 'bg-red-50 text-red-800 border border-red-100 rounded-tl-none' : 'bg-gray-100 text-gray-800 rounded-tl-none'}`}>
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <MessageTable message={msg} />
                </div>
                {msg.toolUsed && (
                  <div className="flex items-center text-xs text-gray-500 bg-gray-50 p-2 rounded border border-gray-200 mt-1">
                    <Cpu className="w-3 h-3 mr-1" />
                    <span>Tool Used: <strong className="font-mono">{msg.toolUsed}</strong></span>
                  </div>
                )}
                {msg.llmMongoPlan && (
                  <div className="text-xs text-gray-500 bg-purple-50 p-2 rounded border border-purple-100 mt-1">
                    <div>Mongo planner: <span className="font-mono">{msg.llmMongoPlan.operation} {msg.llmMongoPlan.collection}</span></div>
                    {msg.llmMongoExtractionPrompt && (
                      <div className="mt-1">
                        Extraction: <span className="font-mono">{msg.llmMongoExtractionPrompt}</span>
                      </div>
                    )}
                  </div>
                )}
                {getPromptRewriteItems(msg.promptRewrite)
                  .filter((rewrite) => rewrite?.changed || rewrite?.llmEnhanced || rewrite?.enhancerError)
                  .map((rewrite, rewriteIndex) => (
                    <div key={rewriteIndex} className="text-xs text-gray-500 bg-blue-50 p-2 rounded border border-blue-100 mt-1">
                      <div>
                        {rewrite.llmEnhanced ? 'AI enhanced prompt' : 'Prompt optimized'}:{' '}
                        <span className="font-mono">{rewrite.optimized}</span>
                      </div>
                      {rewrite.keywords?.terms?.length > 0 && (
                        <div className="mt-1">
                          Keywords: <span className="font-mono">{rewrite.keywords.terms.join(', ')}</span>
                        </div>
                      )}
                      {rewrite.enhancerError && (
                        <div className="mt-1 text-amber-700">
                          AI prompt enhancer skipped: <span className="font-mono">{rewrite.enhancerError}</span>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 p-3 rounded-lg rounded-tl-none flex space-x-2">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-white border-t">
        <form onSubmit={handleSend} className="flex space-x-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={scope === 'document' ? 'Ask about the selected document...' : scope === 'database' ? 'Ask about the selected database...' : 'Ask about your selected database or document...'}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatAssistant;
