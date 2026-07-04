import { Router } from 'express';
import { query } from '../db.js';
import { h } from '../middleware/http.js';
import { requireAuth } from '../middleware/auth.js';
import { dispatcherState } from '../services/dispatcher.js';

const router = Router();
router.use(requireAuth);

// GET /api/metrics/overview — the KPI cards at the top of the dashboard.
router.get(
  '/overview',
  h(async (req, res) => {
    const org = req.auth.orgId;
    const { rows } = await query(
      `WITH scoped_jobs AS (
         SELECT j.* FROM jobs j
           JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
          WHERE p.org_id=$1
       ), scoped_exec AS (
         SELECT e.* FROM job_executions e
           JOIN jobs j ON j.id=e.job_id
           JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
          WHERE p.org_id=$1
       )
       SELECT
         (SELECT COUNT(*) FROM scoped_jobs WHERE status IN ('claimed','running'))::int AS in_flight,
         (SELECT COUNT(*) FROM scoped_exec WHERE status='completed' AND finished_at > now()-interval '1 minute')::int AS done_per_min,
         (SELECT COUNT(*) FROM scoped_exec WHERE status='failed'    AND finished_at > now()-interval '1 minute')::int AS failed_per_min,
         (SELECT COUNT(*) FROM scoped_jobs WHERE status='dead_letter')::int AS dead_letters,
         (SELECT COALESCE(ROUND(AVG(duration_ms)),0) FROM scoped_exec WHERE finished_at > now()-interval '15 minutes')::int AS avg_duration_ms,
         (SELECT COUNT(*) FROM scoped_jobs WHERE status='queued' OR status='scheduled')::int AS pending`,
      [org]
    );
    const workers = await query(
      `SELECT COUNT(*) FILTER (WHERE last_heartbeat > now()-interval '45 seconds')::int AS alive,
              COUNT(*)::int AS total FROM workers`
    );
    res.json({ ...rows[0], workers_alive: workers.rows[0].alive, workers_total: workers.rows[0].total });
  })
);

// GET /api/metrics/throughput?minutes=15 — done vs failed per minute.
router.get(
  '/throughput',
  h(async (req, res) => {
    const minutes = Math.min(180, Math.max(5, parseInt(req.query.minutes || '15', 10)));
    const { rows } = await query(
      `SELECT to_char(date_trunc('minute', e.finished_at), 'HH24:MI') AS t,
              COUNT(*) FILTER (WHERE e.status='completed')::int AS done,
              COUNT(*) FILTER (WHERE e.status='failed')::int    AS failed
         FROM job_executions e
         JOIN jobs j ON j.id=e.job_id
         JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
        WHERE p.org_id=$1 AND e.finished_at > now() - ($2 || ' minutes')::interval
        GROUP BY 1 ORDER BY 1 ASC`,
      [req.auth.orgId, String(minutes)]
    );
    res.json({ data: rows });
  })
);

// GET /api/metrics/events — unified live event feed for the stream panel.
router.get(
  '/events',
  h(async (req, res) => {
    const { rows } = await query(
      `(
         SELECT j.id AS job_id, j.handler, 'enqueued' AS event, j.status,
                j.created_at AS ts, NULL::int AS duration_ms, q.name AS queue_name
           FROM jobs j JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
          WHERE p.org_id=$1 AND j.created_at > now()-interval '10 minutes'
       )
       UNION ALL
       (
         SELECT e.job_id, j.handler,
                CASE e.status WHEN 'completed' THEN 'completed'
                              WHEN 'failed' THEN 'failed'
                              ELSE 'running' END AS event,
                e.status, COALESCE(e.finished_at, e.started_at) AS ts,
                e.duration_ms, q.name AS queue_name
           FROM job_executions e JOIN jobs j ON j.id=e.job_id
           JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id
          WHERE p.org_id=$1 AND COALESCE(e.finished_at, e.started_at) > now()-interval '10 minutes'
       )
       ORDER BY ts DESC LIMIT 60`,
      [req.auth.orgId]
    );
    res.json({ data: rows });
  })
);

// GET /api/metrics/dispatcher — leader + fence token for the HA card.
router.get(
  '/dispatcher',
  h(async (req, res) => {
    const lease = await query('SELECT holder, fence_token, expires_at FROM dispatcher_lease WHERE id=1');
    const l = lease.rows[0] || {};
    const remainingMs = l.expires_at ? new Date(l.expires_at).getTime() - Date.now() : 0;
    res.json({
      ...dispatcherState(),
      holder: l.holder,
      fenceToken: Number(l.fence_token || 0),
      leaseRemainingSec: Math.max(0, Math.round(remainingMs / 1000)),
    });
  })
);

export default router;
