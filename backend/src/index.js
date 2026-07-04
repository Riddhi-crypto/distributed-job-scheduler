import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler } from './middleware/http.js';
import { startDispatcher } from './services/dispatcher.js';

import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import queueRoutes from './routes/queues.js';
import jobRoutes from './routes/jobs.js';
import workerRoutes from './routes/workers.js';
import dlqRoutes from './routes/deadletters.js';
import metricRoutes from './routes/metrics.js';
import retryPolicyRoutes from './routes/retryPolicies.js';
import chaosRoutes from './routes/chaos.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Lightweight request logging.
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    if (req.path !== '/health') {
      console.log(`${req.method} ${req.path} ${_res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'aegis-api', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/queues', queueRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/dead-letters', dlqRoutes);
app.use('/api/metrics', metricRoutes);
app.use('/api/retry-policies', retryPolicyRoutes);
app.use('/api/chaos', chaosRoutes);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
});

// The dispatcher runs in-process; two API instances = HA (one wins the lease).
const dispatcherTimer = startDispatcher();

// Graceful shutdown: stop accepting connections, stop dispatcher, drain pool.
async function shutdown(signal) {
  console.log(`\n[api] ${signal} received, shutting down…`);
  clearInterval(dispatcherTimer);
  server.close(async () => {
    await pool.end();
    console.log('[api] closed cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
