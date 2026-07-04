import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

/** Verify the Bearer token and attach { userId, orgId, role } to req.auth. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    // Resolve the user's active org membership (single-org demo; first membership).
    const { rows } = await query(
      `SELECT m.org_id, m.role
         FROM memberships m
        WHERE m.user_id = $1
        ORDER BY m.created_at ASC
        LIMIT 1`,
      [payload.sub]
    );
    if (!rows.length) return res.status(403).json({ error: 'no organization' });
    req.auth = { userId: payload.sub, orgId: rows[0].org_id, role: rows[0].role };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

/** Simple RBAC guard. Usage: router.post('/', requireRole('admin','owner'), ...) */
export function requireRole(...roles) {
  const order = { viewer: 0, member: 1, admin: 2, owner: 3 };
  const min = Math.min(...roles.map((r) => order[r] ?? 99));
  return (req, res, next) => {
    if ((order[req.auth?.role] ?? -1) < min) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    next();
  };
}

/**
 * Shared secret for worker/dispatcher endpoints. Workers are trusted internal
 * services, not end users, so they authenticate with WORKER_TOKEN rather than JWT.
 */
export function requireWorkerToken(req, res, next) {
  const expected = process.env.WORKER_TOKEN || 'worker-secret';
  if ((req.headers['x-worker-token'] || '') !== expected) {
    return res.status(401).json({ error: 'invalid worker token' });
  }
  next();
}
