import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AskPage } from './pages/AskPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { DocumentsPage } from './pages/DocumentsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/ask" replace />} />
        <Route path="ask" element={<AskPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="*" element={<Navigate to="/ask" replace />} />
      </Route>
    </Routes>
  );
}
