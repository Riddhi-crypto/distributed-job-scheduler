import os from 'os';
import { pool, withTransaction } from './db.js';
import { runHandler } from './handlers.js';

// ---------------------------------------------------------------------------
// Configuration (env-driven; sensible defaults for local dev).
// ---------------------------------------------------------------------------
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '4', 10);
const POLL_MS = parseInt(process.env.WORKER_POLL_MS || '750', 10);
const HEARTBEAT_MS = parseInt(process.env.WORKER_HEARTBEAT_MS || '5000', 10);
const LEASE_SECONDS = parseInt(process.env.LEASE_SECONDS || '30', 10);
// How many rows to lock per claim attempt. We over-select a little so the
// rank-by-headroom step has candidates to choose from, then keep only what fits.
const LOCK_BATCH = Math.max(CONCURRENCY * 2, 8);

const HOSTNAME = os.hostname();
const WORKER_NAME = process.env.WORKER_NAME || `worker-${HOSTNAME}-${process.pid}`;

// ---------------------------------------------------------------------------
// Runtime state.
// ---------------------------------------------------------------------------
let workerId = null;
let inFlight = 0; // jobs currently executing in this process
let shuttingDown = false;
let pollTimer = null;
let heartbeatTimer = null;

const log = (...a) => console.log(`[worker ${WORKER_NAME}]`, ...a);

// ---------------------------------------------------------------------------
// Default retry policy when a job/queue has none. Mirrors services/retry.js.
// ---------------------------------------------------------------------------
const DEFAULT_POLICY = {
  strategy: 'exponential',
  base_delay_ms: 1000,
  max_delay_ms: 300000,
  jitter: true,
};

function computeBackoffMs(policy, attempt) {
  const base = policy.base_delay_ms ?? 1000;
  const max = policy.max_delay_ms ?? 300000;
  let delay;
  switch (policy.strategy) {
    case 'fixed':
      delay = base;
      break;
    case 'linear':
      delay = base * attempt;
      break;
    case 'exponential':
    default:
      delay = base * Math.pow(2, Math.max(0, attempt - 1));
      break;
  }
  delay = Math.min(delay, max);
  if (policy.jitter) delay = Math.floor(Math.random() * delay);
  return delay;
}

// ---------------------------------------------------------------------------
// Registration + heartbeats.
// ---------------------------------------------------------------------------
async function registerWorker() {
  const { rows } = await pool.query(
    `INSERT INTO workers (name, hostname, status, concurrency, running_count)
     VALUES ($1, $2, 'alive', $3, 0)
     RETURNING id`,
    [WORKER_NAME, HOSTNAME, CONCURRENCY]
  );
  workerId = rows[0].id;
  log(`registered id=${workerId} concurrency=${CONCURRENCY}`);
}

/**
 * Heartbeat: prove liveness AND renew the lease on jobs we still hold so the
 * dispatcher does not reclaim legitimately long-running work. Also records a
 * heartbeat sample for the dashboard's fleet view.
 */
async function heartbeat() {
  if (!workerId) return;
  try {
    await pool.query(
      `UPDATE workers
          SET last_heartbeat = now(),
              running_count  = $2,
              status = CASE WHEN status = 'dead' THEN 'alive' ELSE status END
        WHERE id = $1`,
      [workerId, inFlight]
    );
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, running_count) VALUES ($1, $2)`,
      [workerId, inFlight]
    );
    // Renew lease on everything this worker is actively running.
    await pool.query(
      `UPDATE jobs
          SET lock_expires_at = now() + ($2 || ' seconds')::interval
        WHERE locked_by = $1 AND status IN ('claimed', 'running')`,
      [workerId, String(LEASE_SECONDS)]
    );
  } catch (e) {
    log('heartbeat error', e.message);
  }
}

// ---------------------------------------------------------------------------
// Atomic claiming.
//
// Two-phase, single transaction:
//   1. eligible: lock a batch of claimable rows with FOR UPDATE ... SKIP LOCKED
//      (this is what GUARANTEES no two workers grab the same job).
//   2. ranked/chosen: within the locked set, respect each queue's concurrency
//      limit by ranking rows and keeping only those inside the remaining
//      headroom (limit - currently-running). Best-effort global limit.
// The UPDATE flips them to 'claimed' and stamps our worker id + lease + fence.
// ---------------------------------------------------------------------------
async function claimJobs(limit) {
  if (limit <= 0) return [];
  const sql = `
    WITH eligible AS (
      SELECT j.id
        FROM jobs j
        JOIN queues q ON q.id = j.queue_id
       WHERE j.status IN ('queued', 'scheduled')
         AND j.run_at <= now()
         AND q.is_paused = false
         AND NOT EXISTS (
               SELECT 1
                 FROM unnest(j.depends_on) AS dep(dep_id)
                 JOIN jobs d ON d.id = dep.dep_id
                WHERE d.status <> 'completed'
             )
       ORDER BY q.priority DESC, j.priority DESC, j.run_at ASC
       FOR UPDATE OF j SKIP LOCKED
       LIMIT ${LOCK_BATCH}
    ),
    running_counts AS (
      SELECT queue_id, COUNT(*)::int AS running
        FROM jobs
       WHERE status IN ('claimed', 'running')
       GROUP BY queue_id
    ),
    ranked AS (
      SELECT e.id,
             j.queue_id,
             q.concurrency_limit,
             COALESCE(rc.running, 0) AS running,
             ROW_NUMBER() OVER (
               PARTITION BY j.queue_id
               ORDER BY j.priority DESC, j.run_at ASC
             ) AS rn
        FROM eligible e
        JOIN jobs j   ON j.id = e.id
        JOIN queues q ON q.id = j.queue_id
        LEFT JOIN running_counts rc ON rc.queue_id = j.queue_id
    ),
    chosen AS (
      SELECT id
        FROM ranked
       WHERE rn <= GREATEST(concurrency_limit - running, 0)
       LIMIT ${limit}
    )
    UPDATE jobs j
       SET status = 'claimed',
           locked_by = $1,
           locked_at = now(),
           lock_expires_at = now() + ($2 || ' seconds')::interval,
           attempt = attempt + 1
      FROM chosen
     WHERE j.id = chosen.id
    RETURNING j.id, j.handler, j.payload, j.attempt, j.max_attempts,
              j.timeout_sec, j.retry_policy_id, j.fence_token, j.queue_id;
  `;
  const { rows } = await pool.query(sql, [workerId, String(LEASE_SECONDS)]);
  return rows;
}

// ---------------------------------------------------------------------------
// Execution of a single claimed job.
// ---------------------------------------------------------------------------
async function loadPolicy(retryPolicyId) {
  if (!retryPolicyId) return DEFAULT_POLICY;
  const { rows } = await pool.query(
    `SELECT strategy, base_delay_ms, max_delay_ms, jitter FROM retry_policies WHERE id = $1`,
    [retryPolicyId]
  );
  return rows[0] || DEFAULT_POLICY;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function executeJob(job) {
  inFlight++;
  const token = Number(job.fence_token);
  const startedAt = Date.now();

  // Open an execution row (retry history + metrics live here).
  const execRes = await pool.query(
    `INSERT INTO job_executions (job_id, worker_id, attempt, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [job.id, workerId, job.attempt]
  );
  const executionId = execRes.rows[0].id;

  // Flip claimed -> running (guarded by our fence token).
  await pool.query(
    `UPDATE jobs SET status = 'running'
      WHERE id = $1 AND locked_by = $2 AND fence_token = $3 AND status = 'claimed'`,
    [job.id, workerId, token]
  );

  const ctx = {
    job,
    log: async (level, message) => {
      try {
        await pool.query(
          `INSERT INTO job_logs (job_id, execution_id, level, message) VALUES ($1, $2, $3, $4)`,
          [job.id, executionId, level, String(message)]
        );
      } catch {
        /* logging must never break execution */
      }
    },
  };

  try {
    const result = await withTimeout(
      runHandler(job.handler, job.payload || {}, ctx),
      Math.max(1, job.timeout_sec) * 1000
    );
    const durationMs = Date.now() - startedAt;

    await pool.query(
      `UPDATE job_executions
          SET status='completed', finished_at=now(), duration_ms=$2, result=$3
        WHERE id=$1`,
      [executionId, durationMs, result == null ? null : JSON.stringify(result)]
    );

    // Complete the job only if we still legitimately own it.
    const upd = await pool.query(
      `UPDATE jobs
          SET status='completed', completed_at=now(), last_error=NULL
        WHERE id=$1 AND locked_by=$2 AND fence_token=$3 AND status IN ('claimed','running')`,
      [job.id, workerId, token]
    );
    if (upd.rowCount === 0) {
      log(`job ${job.id} completed but lease was lost (fence ${token}); result discarded`);
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err && err.message) || String(err);

    await pool.query(
      `UPDATE job_executions
          SET status='failed', finished_at=now(), duration_ms=$2, error=$3
        WHERE id=$1`,
      [executionId, durationMs, message]
    );
    await ctx.log('error', `attempt ${job.attempt} failed: ${message}`);

    await handleFailure(job, token, message);
  } finally {
    inFlight--;
  }
}

/**
 * Decide the fate of a failed job: retry with backoff, or dead-letter.
 * All state changes are guarded by (locked_by, fence_token) so a zombie
 * worker that lost its lease cannot corrupt a job that was already reclaimed.
 */
async function handleFailure(job, token, message) {
  if (job.attempt < job.max_attempts) {
    const policy = await loadPolicy(job.retry_policy_id);
    const backoff = computeBackoffMs(policy, job.attempt);
    const upd = await pool.query(
      `UPDATE jobs
          SET status='queued',
              run_at = now() + ($4 || ' milliseconds')::interval,
              locked_by=NULL, locked_at=NULL, lock_expires_at=NULL,
              last_error=$5
        WHERE id=$1 AND locked_by=$2 AND fence_token=$3 AND status IN ('claimed','running')`,
      [job.id, workerId, token, String(backoff), message]
    );
    if (upd.rowCount > 0) {
      log(`job ${job.id} retry ${job.attempt}/${job.max_attempts} in ${backoff}ms`);
    }
  } else {
    // Exhausted: dead-letter it (idempotent on job_id).
    await withTransaction(async (c) => {
      const upd = await c.query(
        `UPDATE jobs
            SET status='dead_letter', locked_by=NULL, locked_at=NULL,
                lock_expires_at=NULL, last_error=$4
          WHERE id=$1 AND locked_by=$2 AND fence_token=$3 AND status IN ('claimed','running')`,
        [job.id, workerId, token, message]
      );
      if (upd.rowCount === 0) return; // lease lost; dispatcher will handle it
      await c.query(
        `INSERT INTO dead_letters (job_id, queue_id, reason, attempts, payload)
         SELECT id, queue_id, $2, attempt, payload FROM jobs WHERE id=$1
         ON CONFLICT (job_id) DO NOTHING`,
        [job.id, message]
      );
    });
    log(`job ${job.id} dead-lettered after ${job.attempt} attempts`);
  }
}

// ---------------------------------------------------------------------------
// Poll loop.
// ---------------------------------------------------------------------------
async function poll() {
  if (shuttingDown) return;
  try {
    const headroom = CONCURRENCY - inFlight;
    if (headroom > 0) {
      const jobs = await claimJobs(headroom);
      for (const job of jobs) {
        // Fire and forget; inFlight bounds total concurrency.
        executeJob(job).catch((e) => log('executeJob crashed', e.message));
      }
    }
  } catch (e) {
    log('poll error', e.message);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown: stop claiming, drain in-flight work, mark dead.
// Anything still running past the grace window will be reclaimed by the
// dispatcher via lease expiry, so no job is ever lost.
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — draining ${inFlight} in-flight job(s)`);
  clearInterval(pollTimer);

  try {
    if (workerId) {
      await pool.query(`UPDATE workers SET status='draining' WHERE id=$1`, [workerId]);
    }
    const deadline = Date.now() + 20_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(heartbeatTimer);
    if (workerId) {
      await pool.query(
        `UPDATE workers SET status='dead', running_count=0 WHERE id=$1`,
        [workerId]
      );
    }
  } catch (e) {
    log('shutdown error', e.message);
  } finally {
    await pool.end().catch(() => {});
    log('bye');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
async function main() {
  log(`starting — db=${process.env.DATABASE_URL ? 'env' : 'default'} poll=${POLL_MS}ms`);
  await registerWorker();
  await heartbeat();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  pollTimer = setInterval(poll, POLL_MS);
  poll();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[worker] fatal', e);
  process.exit(1);
});
