import { Router } from 'express';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { query, withTransaction } from '../db.js';
import { h, ApiError, paginate } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

async function queueInOrg(queueId, orgId) {
  const { rows } = await query(
    `SELECT q.id, q.default_retry_policy_id
       FROM queues q JOIN projects p ON p.id = q.project_id
      WHERE q.id = $1 AND p.org_id = $2`,
    [queueId, orgId]
  );
  return rows[0];
}

const createSchema = z.object({
  queueId: z.string().uuid(),
  handler: z.string().min(1),
  payload: z.record(z.any()).optional(),
  kind: z.enum(['immediate', 'delayed', 'scheduled', 'recurring', 'batch']).default('immediate'),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().optional(),
  retryPolicyId: z.string().uuid().optional(),
  maxAttempts: z.number().int().min(1).optional(),
  timeoutSec: z.number().int().min(1).optional(),
  // kind-specific
  delaySeconds: z.number().int().min(0).optional(), // delayed
  runAt: z.string().datetime().optional(),          // scheduled
  cronExpression: z.string().optional(),            // recurring
  timezone: z.string().optional(),
  items: z.array(z.record(z.any())).optional(),     // batch payloads
  dependsOn: z.array(z.string().uuid()).optional(), // workflow deps
});

// POST /api/jobs — create immediate | delayed | scheduled | recurring | batch.
router.post(
  '/',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const b = createSchema.parse(req.body);
    const q = await queueInOrg(b.queueId, req.auth.orgId);
    if (!q) throw new ApiError(404, 'queue not found');

    const retryPolicyId = b.retryPolicyId || q.default_retry_policy_id || null;
    const payload = b.payload || {};
    const timezone = b.timezone || 'UTC';

    // Resolve max_attempts from the policy if not explicitly given.
    let maxAttempts = b.maxAttempts;
    if (!maxAttempts && retryPolicyId) {
      const p = await query('SELECT max_attempts FROM retry_policies WHERE id=$1', [retryPolicyId]);
      maxAttempts = p.rows[0]?.max_attempts;
    }
    maxAttempts = maxAttempts || 5;

    // ---- recurring: store a schedule, dispatcher will materialise runs ----
    if (b.kind === 'recurring') {
      if (!b.cronExpression) throw new ApiError(400, 'cronExpression required for recurring jobs');
      let next;
      try {
        next = cronParser.parseExpression(b.cronExpression, { tz: timezone }).next().toDate();
      } catch {
        throw new ApiError(400, 'invalid cron expression');
      }
      const { rows } = await query(
        `INSERT INTO scheduled_jobs (queue_id, handler, payload, cron_expression, timezone, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.queueId, b.handler, payload, b.cronExpression, timezone, next]
      );
      return res.status(201).json({ kind: 'recurring', schedule: rows[0] });
    }

    // ---- batch: one batch row + N jobs in a single transaction ----
    if (b.kind === 'batch') {
      if (!b.items?.length) throw new ApiError(400, 'items required for batch jobs');
      const created = await withTransaction(async (c) => {
        const batch = await c.query(
          `INSERT INTO batches (queue_id, total) VALUES ($1,$2) RETURNING id`,
          [b.queueId, b.items.length]
        );
        const batchId = batch.rows[0].id;
        const ids = [];
        for (const item of b.items) {
          const r = await c.query(
            `INSERT INTO jobs (queue_id, kind, status, handler, payload, priority,
                               retry_policy_id, max_attempts, timeout_sec, batch_id)
             VALUES ($1,'batch','queued',$2,$3,COALESCE($4,100),$5,$6,COALESCE($7,60),$8)
             RETURNING id`,
            [b.queueId, b.handler, item, b.priority, retryPolicyId, maxAttempts, b.timeoutSec, batchId]
          );
          ids.push(r.rows[0].id);
        }
        return { batchId, jobIds: ids };
      });
      return res.status(201).json({ kind: 'batch', ...created });
    }

    // ---- immediate | delayed | scheduled ----
    let status = 'queued';
    let runAt = 'now()';
    const params = [b.queueId, b.handler, payload, b.priority ?? null, retryPolicyId, maxAttempts, b.timeoutSec ?? null, b.idempotencyKey ?? null, b.dependsOn ?? []];

    if (b.kind === 'delayed') {
      status = 'scheduled';
      params.push((b.delaySeconds ?? 0));
      runAt = `now() + ($${params.length} || ' seconds')::interval`;
    } else if (b.kind === 'scheduled') {
      if (!b.runAt) throw new ApiError(400, 'runAt required for scheduled jobs');
      status = 'scheduled';
      params.push(b.runAt);
      runAt = `$${params.length}::timestamptz`;
    }

    const sql = `
      INSERT INTO jobs (queue_id, kind, status, handler, payload, priority,
                        retry_policy_id, max_attempts, timeout_sec, idempotency_key,
                        depends_on, run_at)
      VALUES ($1, '${b.kind}', '${status}', $2, $3, COALESCE($4,100),
              $5, $6, COALESCE($7,60), $8, $9, ${runAt})
      ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET queue_id = EXCLUDED.queue_id  -- no-op to return the existing row
      RETURNING *`;
    const { rows } = await query(sql, params);
    res.status(201).json(rows[0]);
  })
);

// GET /api/jobs?queueId=&status=&handler=&page=&limit=
router.get(
  '/',
  h(async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const where = ['p.org_id = $1'];
    const params = [req.auth.orgId];
    for (const [key, col] of [['queueId', 'j.queue_id'], ['status', 'j.status'], ['handler', 'j.handler']]) {
      if (req.query[key]) {
        params.push(req.query[key]);
        where.push(`${col} = $${params.length}`);
      }
    }
    const whereSql = where.join(' AND ');
    const totalR = await query(
      `SELECT COUNT(*)::int AS n FROM jobs j
         JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
        WHERE ${whereSql}`,
      params
    );
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT j.id, j.handler, j.kind, j.status, j.priority, j.attempt, j.max_attempts,
              j.run_at, j.created_at, j.updated_at, j.last_error, q.name AS queue_name
         FROM jobs j
         JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
        WHERE ${whereSql}
        ORDER BY j.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows, page, limit, total: totalR.rows[0].n });
  })
);

// GET /api/jobs/:id
router.get(
  '/:id',
  h(async (req, res) => {
    const { rows } = await query(
      `SELECT j.*, q.name AS queue_name, rp.name AS retry_policy_name, rp.strategy
         FROM jobs j
         JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
         LEFT JOIN retry_policies rp ON rp.id = j.retry_policy_id
        WHERE j.id=$1 AND p.org_id=$2`,
      [req.params.id, req.auth.orgId]
    );
    if (!rows.length) throw new ApiError(404, 'job not found');
    res.json(rows[0]);
  })
);

// GET /api/jobs/:id/executions — retry history + per-attempt metrics.
router.get(
  '/:id/executions',
  h(async (req, res) => {
    const { rows } = await query(
      `SELECT e.id, e.attempt, e.status, e.started_at, e.finished_at, e.duration_ms,
              e.error, w.name AS worker_name
         FROM job_executions e LEFT JOIN workers w ON w.id = e.worker_id
        WHERE e.job_id=$1 ORDER BY e.attempt ASC, e.started_at ASC`,
      [req.params.id]
    );
    res.json({ data: rows });
  })
);

// GET /api/jobs/:id/logs
router.get(
  '/:id/logs',
  h(async (req, res) => {
    const { limit, offset } = paginate(req, 100, 500);
    const { rows } = await query(
      `SELECT id, level, message, ts FROM job_logs
        WHERE job_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ data: rows });
  })
);

// POST /api/jobs/:id/retry — manually requeue a failed / dead-lettered job.
router.post(
  '/:id/retry',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const result = await withTransaction(async (c) => {
      const j = await c.query(
        `SELECT j.id, j.status FROM jobs j
           JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
          WHERE j.id=$1 AND p.org_id=$2 FOR UPDATE`,
        [req.params.id, req.auth.orgId]
      );
      if (!j.rows.length) throw new ApiError(404, 'job not found');
      if (!['failed', 'dead_letter'].includes(j.rows[0].status)) {
        throw new ApiError(409, `cannot retry a job in status '${j.rows[0].status}'`);
      }
      await c.query(
        `UPDATE jobs SET status='queued', run_at=now(), locked_by=NULL, locked_at=NULL,
                        lock_expires_at=NULL, last_error=NULL, fence_token=fence_token+1
          WHERE id=$1`,
        [req.params.id]
      );
      await c.query('DELETE FROM dead_letters WHERE job_id=$1', [req.params.id]);
      return true;
    });
    res.json({ id: req.params.id, requeued: result });
  })
);

// POST /api/jobs/:id/cancel
router.post(
  '/:id/cancel',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const { rows } = await query(
      `UPDATE jobs SET status='cancelled'
        WHERE id=$1 AND status IN ('queued','scheduled')
          AND queue_id IN (SELECT q.id FROM queues q JOIN projects p ON p.id=q.project_id WHERE p.org_id=$2)
        RETURNING id, status`,
      [req.params.id, req.auth.orgId]
    );
    if (!rows.length) throw new ApiError(409, 'job not found or not cancellable');
    res.json(rows[0]);
  })
);

export default router;
