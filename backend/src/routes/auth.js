import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { h, ApiError } from '../middleware/http.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().optional(),
  orgName: z.string().optional(),
});

function sign(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// POST /api/auth/register — creates a user, an org, and an owner membership.
router.post(
  '/register',
  h(async (req, res) => {
    const { email, password, displayName, orgName } = credsSchema.parse(req.body);
    const hash = await bcrypt.hash(password, 10);

    const result = await withTransaction(async (c) => {
      const dup = await c.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (dup.rowCount) throw new ApiError(409, 'email already registered');

      const u = await c.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1,$2,$3) RETURNING id, email, display_name`,
        [email, hash, displayName || null]
      );
      const org = await c.query(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        [orgName || `${email.split('@')[0]}'s org`]
      );
      await c.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`,
        [org.rows[0].id, u.rows[0].id]
      );
      // Give every new org a default project + queue so the dashboard isn't empty.
      const proj = await c.query(
        `INSERT INTO projects (org_id, name, slug) VALUES ($1,'Default Project','default') RETURNING id`,
        [org.rows[0].id]
      );
      await c.query(
        `INSERT INTO queues (project_id, name) VALUES ($1,'default')`,
        [proj.rows[0].id]
      );
      return u.rows[0];
    });

    res.status(201).json({ token: sign(result.id), user: result });
  })
);

// POST /api/auth/login
router.post(
  '/login',
  h(async (req, res) => {
    const { email, password } = credsSchema.pick({ email: true, password: true }).parse(req.body);
    const { rows } = await query(
      'SELECT id, email, password_hash, display_name FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new ApiError(401, 'invalid credentials');
    }
    res.json({
      token: sign(user.id),
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  h(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.email, u.display_name, m.role, m.org_id, o.name AS org_name
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.org_id
        WHERE u.id = $1 LIMIT 1`,
      [req.auth.userId]
    );
    res.json(rows[0]);
  })
);

export default router;
