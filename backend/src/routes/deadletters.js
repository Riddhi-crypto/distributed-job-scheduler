import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { h, ApiError, paginate } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { classifyFailure } from '../services/ai.js';

const router = Router();
router.use(requireAuth);

// GET /api/dead-letters?queueId=&page=&limit= — with AI failure insights.
router.get(
  '/',
  h(async (req, res) => {
    const { limit, offset, page } = paginate(req);
    const params = [req.auth.orgId];
    let qFilter = '';
    if (req.query.queueId) {
      params.push(req.query.queueId);
      qFilter = `AND d.queue_id = $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT d.id, d.job_id, d.queue_id, d.reason, d.attempts, d.created_at,
              d.ai_summary, d.ai_category, d.ai_confidence,
              j.handler, q.name AS queue_name
         FROM dead_letters d
         JOIN queues q ON q.id = d.queue_id
         JOIN projects p ON p.id = q.project_id
         LEFT JOIN jobs j ON j.id = d.job_id
        WHERE p.org_id = $1 ${qFilter}
        ORDER BY d.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Lazily compute + persist an AI diagnosis for any entry missing one.
    for (const row of rows) {
      if (!row.ai_summary) {
        const diag = classifyFailure({ error: row.reason || '', handler: row.handler || '' });
        row.ai_summary = diag.summary;
        row.ai_category = diag.category;
        row.ai_confidence = diag.confidence;
        row.ai_fix = diag.fix;
        await query(
          `UPDATE dead_letters SET ai_summary=$2, ai_category=$3, ai_confidence=$4 WHERE id=$1`,
          [row.id, diag.summary, diag.category, diag.confidence]
        );
      }
    }
    res.json({ data: rows, page, limit });
  })
);

// POST /api/dead-letters/:id/requeue — move a dead job back into its queue.
router.post(
  '/:id/requeue',
  requireRole('member', 'admin', 'owner'),
  h(async (req, res) => {
    const out = await withTransaction(async (c) => {
      const d = await c.query(
        `SELECT d.job_id FROM dead_letters d
           JOIN queues q ON q.id=d.queue_id JOIN projects p ON p.id=q.project_id
          WHERE d.id=$1 AND p.org_id=$2 FOR UPDATE`,
        [req.params.id, req.auth.orgId]
      );
      if (!d.rows.length) throw new ApiError(404, 'dead letter not found');
      const jobId = d.rows[0].job_id;
      await c.query(
        `UPDATE jobs SET status='queued', attempt=0, run_at=now(),
                        locked_by=NULL, locked_at=NULL, lock_expires_at=NULL,
                        last_error=NULL, fence_token=fence_token+1
          WHERE id=$1`,
        [jobId]
      );
      await c.query('DELETE FROM dead_letters WHERE id=$1', [req.params.id]);
      return jobId;
    });
    res.json({ requeued: out });
  })
);

export default router;
