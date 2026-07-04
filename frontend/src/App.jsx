import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { LoadingFull } from './components/ui.jsx';
import Layout from './components/Layout.jsx';

import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Projects from './pages/Projects.jsx';
import Queues from './pages/Queues.jsx';
import QueueDetail from './pages/QueueDetail.jsx';
import Jobs from './pages/Jobs.jsx';
import JobDetail from './pages/JobDetail.jsx';
import Workers from './pages/Workers.jsx';
import DeadLetters from './pages/DeadLetters.jsx';
import Metrics from './pages/Metrics.jsx';
import ChaosLab from './pages/ChaosLab.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <LoadingFull />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

function Gate() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <LoadingFull /> : user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Overview />} />
        <Route path="/metrics" element={<Metrics />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/queues" element={<Queues />} />
        <Route path="/queues/:id" element={<QueueDetail />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/dead-letters" element={<DeadLetters />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/chaos" element={<ChaosLab />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
