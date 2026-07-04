import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { h, ApiError } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/retry-policies?projectId=
router.get(
  '/',
  h(async (req, res) => {
    const params = [req.auth.orgId];
    let f = '';
    if (req.query.projectId) {
      params.push(req.query.projectId);
      f = `AND rp.project_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT rp.* FROM retry_policies rp
         JOIN projects p ON p.id = rp.project_id
        WHERE p.org_id = $1 ${f}
        ORDER BY rp.created_at ASC`,
      params
    );
    res.json({ data: rows });
  })
);

// POST /api/retry-policies
router.post(
  '/',
  requireRole('admin', 'owner'),
  h(async (req, res) => {
    const b = z
      .object({
        projectId: z.string().uuid(),
        name: z.string().min(1),
        strategy: z.enum(['fixed', 'linear', 'exponential']),
        baseDelayMs: z.number().int().min(0),
        maxDelayMs: z.number().int().min(0),
        maxAttempts: z.number().int().min(1),
        jitter: z.boolean().optional(),
      })
      .parse(req.body);
    const proj = await query('SELECT 1 FROM projects WHERE id=$1 AND org_id=$2', [b.projectId, req.auth.orgId]);
    if (!proj.rowCount) throw new ApiError(404, 'project not found');
    const { rows } = await query(
      `INSERT INTO retry_policies (project_id, name, strategy, base_delay_ms, max_delay_ms, max_attempts, jitter)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true))
       ON CONFLICT (project_id, name) DO NOTHING RETURNING *`,
      [b.projectId, b.name, b.strategy, b.baseDelayMs, b.maxDelayMs, b.maxAttempts, b.jitter]
    );
    if (!rows.length) throw new ApiError(409, 'policy name already exists');
    res.status(201).json(rows[0]);
  })
);

export default router;
