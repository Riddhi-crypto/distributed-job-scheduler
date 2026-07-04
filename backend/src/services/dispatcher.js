import os from 'os';
import cronParser from 'cron-parser';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';

const DISPATCHER_ID = `dispatcher-${os.hostname()}-${process.pid}`;

/**
 * Try to acquire or renew the leadership lease.
 * Returns { isLeader, fenceToken }. Only the leader mutates job state, so two
 * dispatchers can run for HA and exactly one does the work at a time.
 */
async function acquireLease() {
  const lease = config.dispatcherLeaseSeconds;
  const { rows } = await pool.query(
    `UPDATE dispatcher_lease
        SET holder      = $1,
            fence_token = CASE
                            WHEN holder = $1 OR expires_at IS NULL OR expires_at < now()
                            THEN fence_token + 1 ELSE fence_token END,
            acquired_at = CASE
                            WHEN holder = $1 OR expires_at IS NULL OR expires_at < now()
                            THEN now() ELSE acquired_at END,
            expires_at  = CASE
                            WHEN holder = $1 OR expires_at IS NULL OR expires_at < now()
                            THEN now() + ($2 || ' seconds')::interval ELSE expires_at END
      WHERE id = 1
  RETURNING holder, fence_token`,
    [DISPATCHER_ID, String(lease)]
  );
  const row = rows[0];
  return { isLeader: row.holder === DISPATCHER_ID, fenceToken: Number(row.fence_token), holder: row.holder };
}

/** Promote delayed/scheduled jobs that are now due into the claimable pool. */
async function promoteDueJobs() {
  const { rowCount } = await pool.query(
    `UPDATE jobs
        SET status = 'queued'
      WHERE status = 'scheduled' AND run_at <= now()`
  );
  return rowCount;
}

/** Materialise recurring (cron) definitions into concrete jobs when due. */
async function materialiseRecurring() {
  const due = await pool.query(
    `SELECT * FROM scheduled_jobs WHERE is_active AND next_run_at <= now() LIMIT 200`
  );
  let created = 0;
  for (const s of due.rows) {
    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO jobs (queue_id, kind, status, handler, payload, run_at)
         VALUES ($1, 'recurring', 'queued', $2, $3, now())`,
        [s.queue_id, s.handler, s.payload]
      );
      let next;
      try {
        next = cronParser
          .parseExpression(s.cron_expression, { tz: s.timezone, currentDate: new Date() })
          .next()
          .toDate();
      } catch {
        next = new Date(Date.now() + 60_000); // fall back to +1m on a bad cron
      }
      await c.query(
        `UPDATE scheduled_jobs SET last_run_at = now(), next_run_at = $2 WHERE id = $1`,
        [s.id, next]
      );
    });
    created++;
  }
  return created;
}

/**
 * Reclaim jobs whose lease expired (the worker holding them died or stalled).
 * If attempts remain the job is requeued; otherwise it is dead-lettered.
 * This is the core self-healing behaviour.
 */
async function reclaimExpiredLeases() {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT id, attempt, max_attempts
         FROM jobs
        WHERE status IN ('claimed', 'running')
          AND lock_expires_at IS NOT NULL
          AND lock_expires_at < now()
        FOR UPDATE SKIP LOCKED
        LIMIT 500`
    );
    let requeued = 0;
    let deadLettered = 0;
    for (const j of rows) {
      if (j.attempt >= j.max_attempts) {
        await c.query(
          `UPDATE jobs SET status='dead_letter', last_error='worker lost (lease expired)' WHERE id=$1`,
          [j.id]
        );
        await c.query(
          `INSERT INTO dead_letters (job_id, queue_id, reason, attempts, payload)
           SELECT id, queue_id, 'worker lost (lease expired)', attempt, payload FROM jobs WHERE id=$1
           ON CONFLICT (job_id) DO NOTHING`,
          [j.id]
        );
        deadLettered++;
      } else {
        // Requeue and bump the fence token so a resurrected zombie worker is rejected.
        await c.query(
          `UPDATE jobs
              SET status='queued', locked_by=NULL, locked_at=NULL,
                  lock_expires_at=NULL, fence_token = fence_token + 1
            WHERE id=$1`,
          [j.id]
        );
        requeued++;
      }
    }
    return { requeued, deadLettered };
  });
}

/** Flag workers whose heartbeat is stale so the UI shows them as DEAD. */
async function markDeadWorkers() {
  const { rowCount } = await pool.query(
    `UPDATE workers
        SET status='dead'
      WHERE status <> 'dead'
        AND last_heartbeat < now() - ($1 || ' seconds')::interval`,
    [String(config.heartbeatTimeoutSeconds)]
  );
  return rowCount;
}

let currentFenceToken = 0;
let currentlyLeader = false;
export const dispatcherState = () => ({
  id: DISPATCHER_ID,
  isLeader: currentlyLeader,
  fenceToken: currentFenceToken,
});

/** One dispatcher tick. Called on an interval from index.js. */
export async function dispatcherTick() {
  const { isLeader, fenceToken } = await acquireLease();
  currentlyLeader = isLeader;
  currentFenceToken = fenceToken;
  if (!isLeader) return;

  const [promoted, recurring, reclaimed, dead] = await Promise.all([
    promoteDueJobs(),
    materialiseRecurring(),
    reclaimExpiredLeases(),
    markDeadWorkers(),
  ]);

  if (promoted || recurring || reclaimed.requeued || reclaimed.deadLettered || dead) {
    console.log(
      `[dispatcher] promoted=${promoted} recurring=${recurring} ` +
        `requeued=${reclaimed.requeued} dlq=${reclaimed.deadLettered} deadWorkers=${dead}`
    );
  }
}

export function startDispatcher() {
  const period = 3000;
  console.log(`[dispatcher] ${DISPATCHER_ID} started (tick ${period}ms)`);
  dispatcherTick().catch((e) => console.error('[dispatcher] tick error', e.message));
  return setInterval(
    () => dispatcherTick().catch((e) => console.error('[dispatcher] tick error', e.message)),
    period
  );
}
