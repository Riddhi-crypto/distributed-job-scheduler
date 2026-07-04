import { Router } from 'express';
import { query } from '../db.js';
import { h } from '../middleware/http.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();
router.use(requireAuth);

// GET /api/workers — fleet view. A worker is "alive" if it beat recently.
router.get(
  '/',
  h(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, hostname, status, concurrency, running_count,
              last_heartbeat, started_at,
              EXTRACT(EPOCH FROM (now() - last_heartbeat))::int AS seconds_since_beat,
              (last_heartbeat > now() - ($1 || ' seconds')::interval) AS is_alive
         FROM workers
        ORDER BY last_heartbeat DESC`,
      [String(config.heartbeatTimeoutSeconds)]
    );
    const alive = rows.filter((w) => w.is_alive).length;
    res.json({ data: rows, alive, total: rows.length });
  })
);

// GET /api/workers/:id — single worker + its recent executions.
router.get(
  '/:id',
  h(async (req, res) => {
    const w = await query('SELECT * FROM workers WHERE id=$1', [req.params.id]);
    if (!w.rowCount) return res.status(404).json({ error: 'worker not found' });
    const recent = await query(
      `SELECT e.job_id, e.status, e.duration_ms, e.finished_at, j.handler
         FROM job_executions e JOIN jobs j ON j.id=e.job_id
        WHERE e.worker_id=$1 ORDER BY e.started_at DESC LIMIT 25`,
      [req.params.id]
    );
    res.json({ ...w.rows[0], recent: recent.rows });
  })
);

export default router;
