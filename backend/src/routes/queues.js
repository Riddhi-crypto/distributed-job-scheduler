import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { h, ApiError } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Ensure a queue belongs to the caller's org before mutating it.
async function assertQueueInOrg(queueId, orgId) {
  const { rows } = await query(
    `SELECT q.id FROM queues q
       JOIN projects p ON p.id = q.project_id
      WHERE q.id = $1 AND p.org_id = $2`,
    [queueId, orgId]
  );
  if (!rows.length) throw new ApiError(404, 'queue not found');
}

// GET /api/queues?projectId= — queues + live status breakdown for health cards.
router.get(
  '/',
  h(async (req, res) => {
    const params = [req.auth.orgId];
    let projFilter = '';
    if (req.query.projectId) {
      params.push(req.query.projectId);
      projFilter = `AND q.project_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT q.id, q.name, q.priority, q.concurrency_limit, q.rate_limit_per_sec,
              q.is_paused, q.shard, q.project_id,
              COUNT(*) FILTER (WHERE j.status IN ('queued','scheduled'))::int AS pending,
              COUNT(*) FILTER (WHERE j.status IN ('claimed','running'))::int  AS running,
              COUNT(*) FILTER (WHERE j.status = 'completed')::int             AS done,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int                AS failed,
              COUNT(*) FILTER (WHERE j.status = 'dead_letter')::int           AS dead
         FROM queues q
         JOIN projects p ON p.id = q.project_id
         LEFT JOIN jobs j ON j.queue_id = q.id
        WHERE p.org_id = $1 ${projFilter}
        GROUP BY q.id
        ORDER BY q.priority DESC, q.name ASC`,
      params
    );
    res.json({ data: rows });
  })
);

// GET /api/queues/:id — single queue with the same health breakdown.
router.get(
  '/:id',
  h(async (req, res) => {
    await assertQueueInOrg(req.params.id, req.auth.orgId);
    const { rows } = await query(
      `SELECT q.*,
              COUNT(*) FILTER (WHERE j.status IN ('queued','scheduled'))::int AS pending,
              COUNT(*) FILTER (WHERE j.status IN ('claimed','running'))::int  AS running,
              COUNT(*) FILTER (WHERE j.status = 'completed')::int             AS done,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int                AS failed,
              COUNT(*) FILTER (WHERE j.status = 'dead_letter')::int           AS dead
         FROM queues q
         LEFT JOIN jobs j ON j.queue_id = q.id
        WHERE q.id = $1
        GROUP BY q.id`,
      [req.params.id]
    );
    res.json(rows[0]);
  })
);

// POST /api/queues
router.post(
  '/',
  requireRole('admin', 'owner'),
  h(async (req, res) => {
    const body = z
      .object({
        projectId: z.string().uuid(),
        name: z.string().min(1),
        priority: z.number().int().optional(),
        concurrencyLimit: z.number().int().min(0).optional(),
        rateLimitPerSec: z.number().int().min(0).nullable().optional(),
        shard: z.number().int().optional(),
      })
      .parse(req.body);
    // project must be in caller org
    const proj = await query('SELECT 1 FROM projects WHERE id=$1 AND org_id=$2', [
      body.projectId,
      req.auth.orgId,
    ]);
    if (!proj.rowCount) throw new ApiError(404, 'project not found');

    const { rows } = await query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, rate_limit_per_sec, shard)
       VALUES ($1,$2,COALESCE($3,100),COALESCE($4,10),$5,COALESCE($6,0))
       ON CONFLICT (project_id, name) DO NOTHING
       RETURNING *`,
      [body.projectId, body.name, body.priority, body.concurrencyLimit, body.rateLimitPerSec ?? null, body.shard]
    );
    if (!rows.length) throw new ApiError(409, 'queue name already exists in project');
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/queues/:id — update priority / concurrency / rate limit.
router.patch(
  '/:id',
  requireRole('admin', 'owner'),
  h(async (req, res) => {
    await assertQueueInOrg(req.params.id, req.auth.orgId);
    const body = z
      .object({
        priority: z.number().int().optional(),
        concurrencyLimit: z.number().int().min(0).optional(),
        rateLimitPerSec: z.number().int().min(0).nullable().optional(),
      })
      .parse(req.body);
    const { rows } = await query(
      `UPDATE queues SET
         priority = COALESCE($2, priority),
         concurrency_limit = COALESCE($3, concurrency_limit),
         rate_limit_per_sec = COALESCE($4, rate_limit_per_sec)
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.priority, body.concurrencyLimit, body.rateLimitPerSec]
    );
    res.json(rows[0]);
  })
);

// POST /api/queues/:id/pause  &  /resume
for (const action of ['pause', 'resume']) {
  router.post(
    `/:id/${action}`,
    requireRole('admin', 'owner'),
    h(async (req, res) => {
      await assertQueueInOrg(req.params.id, req.auth.orgId);
      const { rows } = await query(
        `UPDATE queues SET is_paused = $2 WHERE id = $1 RETURNING id, name, is_paused`,
        [req.params.id, action === 'pause']
      );
      res.json(rows[0]);
    })
  );
}

// GET /api/queues/:id/stats — throughput over the last hour, bucketed per minute.
router.get(
  '/:id/stats',
  h(async (req, res) => {
    await assertQueueInOrg(req.params.id, req.auth.orgId);
    const { rows } = await query(
      `SELECT date_trunc('minute', e.finished_at) AS minute,
              COUNT(*) FILTER (WHERE e.status='completed')::int AS completed,
              COUNT(*) FILTER (WHERE e.status='failed')::int    AS failed,
              ROUND(AVG(e.duration_ms))::int                     AS avg_ms
         FROM job_executions e
         JOIN jobs j ON j.id = e.job_id
        WHERE j.queue_id = $1 AND e.finished_at > now() - interval '1 hour'
        GROUP BY 1 ORDER BY 1 ASC`,
      [req.params.id]
    );
    res.json({ data: rows });
  })
);

export default router;
