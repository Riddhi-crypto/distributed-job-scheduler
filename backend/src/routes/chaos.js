import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { h, ApiError } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/**
 * Fault-injection knobs are read by the worker's fault-injecting handlers.
 * We persist them on a well-known row so any worker/process can read them.
 * (Stored in a tiny key/value carried inside dispatcher_lease? No — use a table.)
 */
async function ensureChaosTable() {
  await query(`CREATE TABLE IF NOT EXISTS chaos_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id=1),
    fail_rate NUMERIC(4,3) NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0
  )`);
  await query(`INSERT INTO chaos_config (id) VALUES (1) ON CONFLICT DO NOTHING`);
}

// GET /api/chaos — current fault-injection settings.
router.get(
  '/',
  h(async (req, res) => {
    await ensureChaosTable();
    const { rows } = await query('SELECT fail_rate, latency_ms FROM chaos_config WHERE id=1');
    res.json(rows[0]);
  })
);

// POST /api/chaos/inject — set global fail rate (0..1) and added latency (ms).
router.post(
  '/inject',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    await ensureChaosTable();
    const b = z
      .object({ failRate: z.number().min(0).max(1).optional(), latencyMs: z.number().int().min(0).optional() })
      .parse(req.body);
    const { rows } = await query(
      `UPDATE chaos_config SET
         fail_rate = COALESCE($1, fail_rate),
         latency_ms = COALESCE($2, latency_ms)
       WHERE id=1 RETURNING fail_rate, latency_ms`,
      [b.failRate, b.latencyMs]
    );
    res.json(rows[0]);
  })
);

// POST /api/chaos/clear — reset fault injection.
router.post(
  '/clear',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    await ensureChaosTable();
    await query('UPDATE chaos_config SET fail_rate=0, latency_ms=0 WHERE id=1');
    res.json({ fail_rate: 0, latency_ms: 0 });
  })
);

// POST /api/chaos/kill-worker/:id — simulate a worker crash: mark it dead and
// immediately requeue its in-flight jobs so the fleet self-heals on demand.
router.post(
  '/kill-worker/:id',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const out = await withTransaction(async (c) => {
      const w = await c.query('SELECT id FROM workers WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!w.rowCount) throw new ApiError(404, 'worker not found');
      await c.query(`UPDATE workers SET status='dead', last_heartbeat=now()-interval '10 minutes' WHERE id=$1`, [req.params.id]);
      const req2 = await c.query(
        `UPDATE jobs SET status='queued', locked_by=NULL, locked_at=NULL,
                        lock_expires_at=NULL, fence_token=fence_token+1
          WHERE locked_by=$1 AND status IN ('claimed','running') RETURNING id`,
        [req.params.id]
      );
      return req2.rowCount;
    });
    res.json({ killed: req.params.id, jobsRequeued: out });
  })
);

// POST /api/chaos/flood — enqueue N jobs into a queue to stress the system.
router.post(
  '/flood',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const b = z
      .object({
        queueId: z.string().uuid(),
        count: z.number().int().min(1).max(1000).default(40),
        handler: z.string().default('cpu'),
      })
      .parse(req.body);
    const q = await query(
      `SELECT q.id FROM queues q JOIN projects p ON p.id=q.project_id WHERE q.id=$1 AND p.org_id=$2`,
      [b.queueId, req.auth.orgId]
    );
    if (!q.rowCount) throw new ApiError(404, 'queue not found');

    // Efficient bulk insert via generate_series.
    await query(
      `INSERT INTO jobs (queue_id, kind, status, handler, payload)
       SELECT $1, 'immediate', 'queued', $2, jsonb_build_object('n', g)
         FROM generate_series(1, $3) g`,
      [b.queueId, b.handler, b.count]
    );
    res.json({ enqueued: b.count, queueId: b.queueId });
  })
);

export default router;
