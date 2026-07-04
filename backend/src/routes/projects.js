import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { h } from '../middleware/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/projects — all projects in the caller's org, with queue counts.
router.get(
  '/',
  h(async (req, res) => {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.created_at,
              COUNT(q.id)::int AS queue_count
         FROM projects p
         LEFT JOIN queues q ON q.project_id = p.id
        WHERE p.org_id = $1
        GROUP BY p.id
        ORDER BY p.created_at ASC`,
      [req.auth.orgId]
    );
    res.json({ data: rows });
  })
);

// POST /api/projects
router.post(
  '/',
  requireRole('admin', 'owner'),
  h(async (req, res) => {
    const { name, slug } = z
      .object({ name: z.string().min(1), slug: z.string().min(1).regex(/^[a-z0-9-]+$/) })
      .parse(req.body);
    const { rows } = await query(
      `INSERT INTO projects (org_id, name, slug) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, slug) DO NOTHING
       RETURNING id, name, slug, created_at`,
      [req.auth.orgId, name, slug]
    );
    if (!rows.length) return res.status(409).json({ error: 'slug already exists' });
    res.status(201).json(rows[0]);
  })
);

export default router;
