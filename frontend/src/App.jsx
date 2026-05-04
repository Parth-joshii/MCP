import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ChatAssistant from './pages/ChatAssistant';
import DatabaseAccess from './pages/DatabaseAccess';
import DocumentAccess from './pages/DocumentAccess';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<ChatAssistant />} />
          <Route path="database-access" element={<DatabaseAccess />} />
          <Route path="document-access" element={<DocumentAccess />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
