-- ============================================================================
-- AEGIS Distributed Job Scheduler — PostgreSQL schema
-- ----------------------------------------------------------------------------
-- Design goals:
--   * Atomic, duplicate-free job claiming under high concurrency
--     (SELECT ... FOR UPDATE SKIP LOCKED against a partial index).
--   * Clear lifecycle: queued -> scheduled -> claimed -> running ->
--     completed | failed -> (retry) | dead_letter.
--   * Full observability: every execution, retry, log line and heartbeat
--     is persisted and query-friendly.
--   * Multi-tenant: organizations -> projects -> queues -> jobs.
-- Requires PostgreSQL 13+ (for FOR UPDATE ... SKIP LOCKED and gen_random_uuid).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enumerated types (kept as text + CHECK where values may grow, enums where fixed)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'queued', 'scheduled', 'claimed', 'running',
    'completed', 'failed', 'dead_letter', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_kind AS ENUM ('immediate', 'delayed', 'scheduled', 'recurring', 'batch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE backoff_strategy AS ENUM ('fixed', 'linear', 'exponential');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE worker_status AS ENUM ('alive', 'draining', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tenancy: organizations -> users (membership) -> projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT UNIQUE NOT NULL,          -- case-insensitive login
  password_hash  TEXT NOT NULL,                   -- bcrypt
  display_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CITEXT needs the extension; fall back to lower(email) unique index if absent.
CREATE EXTENSION IF NOT EXISTS citext;

-- RBAC: a user has a role within an organization.
CREATE TABLE IF NOT EXISTS memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member'
             CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

-- ---------------------------------------------------------------------------
-- Retry policies: reusable per project, referenced by queues and jobs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retry_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  strategy       backoff_strategy NOT NULL DEFAULT 'exponential',
  base_delay_ms  INTEGER NOT NULL DEFAULT 1000  CHECK (base_delay_ms >= 0),
  max_delay_ms   INTEGER NOT NULL DEFAULT 300000 CHECK (max_delay_ms >= 0),
  max_attempts   INTEGER NOT NULL DEFAULT 5      CHECK (max_attempts >= 1),
  jitter         BOOLEAN NOT NULL DEFAULT true,  -- avoid retry stampedes
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- ---------------------------------------------------------------------------
-- Queues: the unit of scheduling. Priority + concurrency limit + pause.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queues (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 100,       -- higher = drained first
  concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK (concurrency_limit >= 0),
  rate_limit_per_sec INTEGER,                            -- NULL = unlimited
  is_paused         BOOLEAN NOT NULL DEFAULT false,
  shard             INTEGER NOT NULL DEFAULT 0,          -- queue sharding (bonus)
  default_retry_policy_id UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_queues_project ON queues(project_id);

-- ---------------------------------------------------------------------------
-- Jobs: one row per unit of work. This is the hot table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id          UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  kind              job_kind NOT NULL DEFAULT 'immediate',
  status            job_status NOT NULL DEFAULT 'queued',
  handler           TEXT NOT NULL,               -- e.g. 'echo', 'http', 'sleep'
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority          INTEGER NOT NULL DEFAULT 100, -- overrides queue ordering
  -- Idempotency: two enqueues with the same key in a queue collapse to one job.
  idempotency_key   TEXT,
  -- Scheduling
  run_at            TIMESTAMPTZ NOT NULL DEFAULT now(), -- earliest eligible time
  cron_expression   TEXT,                         -- for kind='recurring'
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  -- Retry bookkeeping
  retry_policy_id   UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
  attempt           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  timeout_sec       INTEGER NOT NULL DEFAULT 60,
  -- Claiming / fencing
  locked_by         UUID,                         -- worker id currently holding it
  locked_at         TIMESTAMPTZ,
  lock_expires_at   TIMESTAMPTZ,                  -- reclaimed by dispatcher if past
  fence_token       BIGINT NOT NULL DEFAULT 0,    -- monotonic; stale workers rejected
  -- Batch / workflow (bonus)
  batch_id          UUID,
  depends_on        UUID[] NOT NULL DEFAULT '{}', -- workflow dependencies
  -- Result
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT jobs_attempt_le_max CHECK (attempt <= max_attempts)
);

-- Idempotency guard: at most one live job per (queue, key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency
  ON jobs (queue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- *** The single most important index in the system. ***
-- The dispatcher/worker claim query filters on eligible rows and orders by
-- priority then run_at. A PARTIAL index keeps it tiny (only claimable rows),
-- so claiming stays O(log n) even with millions of completed jobs.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON jobs (queue_id, priority DESC, run_at ASC)
  WHERE status IN ('queued', 'scheduled');

-- Reclaim scan: find running jobs whose lease has expired.
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry
  ON jobs (lock_expires_at)
  WHERE status IN ('claimed', 'running');

CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs (queue_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_batch       ON jobs (batch_id) WHERE batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Batches: a group of jobs enqueued together.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id    UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name        TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Scheduled jobs: templates that materialise into `jobs` (cron/recurring).
-- Keeping the recurrence definition separate from concrete runs makes it easy
-- to pause/edit a schedule without touching in-flight executions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id        UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  handler         TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  cron_expression TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  next_run_at     TIMESTAMPTZ NOT NULL,
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next
  ON scheduled_jobs (next_run_at) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Workers + heartbeats.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  hostname       TEXT,
  status         worker_status NOT NULL DEFAULT 'alive',
  concurrency    INTEGER NOT NULL DEFAULT 4,
  running_count  INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON workers (last_heartbeat);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id            BIGSERIAL PRIMARY KEY,
  worker_id     UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  running_count INTEGER NOT NULL DEFAULT 0,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_worker_ts
  ON worker_heartbeats (worker_id, ts DESC);

-- ---------------------------------------------------------------------------
-- Job executions: one row per attempt (retry history + metrics live here).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_executions (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id     UUID REFERENCES workers(id) ON DELETE SET NULL,
  attempt       INTEGER NOT NULL,
  status        job_status NOT NULL,           -- running | completed | failed
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,
  error         TEXT,
  result        JSONB
);
CREATE INDEX IF NOT EXISTS idx_executions_job ON job_executions (job_id, attempt);
CREATE INDEX IF NOT EXISTS idx_executions_worker ON job_executions (worker_id);
CREATE INDEX IF NOT EXISTS idx_executions_started ON job_executions (started_at DESC);

-- ---------------------------------------------------------------------------
-- Job logs: structured, append-only log lines per execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_logs (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id  BIGINT REFERENCES job_executions(id) ON DELETE CASCADE,
  level         TEXT NOT NULL DEFAULT 'info'
                CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message       TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_job_ts ON job_logs (job_id, ts DESC);

-- ---------------------------------------------------------------------------
-- Dead letter queue: jobs that exhausted retries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dead_letters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id     UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  reason       TEXT,
  attempts     INTEGER NOT NULL,
  payload      JSONB,
  ai_summary   TEXT,          -- AI-generated failure diagnosis (bonus)
  ai_category  TEXT,
  ai_confidence NUMERIC(4,3),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS idx_dlq_queue ON dead_letters (queue_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Dispatcher leadership lease (single-leader HA; fencing tokens).
-- One row; whichever dispatcher holds a non-expired lease is leader.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatcher_lease (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder       TEXT,
  fence_token  BIGINT NOT NULL DEFAULT 0,
  acquired_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);
INSERT INTO dispatcher_lease (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- keep updated_at fresh on jobs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_touch ON jobs;
CREATE TRIGGER trg_jobs_touch BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
