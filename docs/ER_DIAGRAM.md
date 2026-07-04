# AEGIS — Entity Relationship Diagram

The schema is multi-tenant and normalised to 3NF. The chain of ownership is:

```
organizations → projects → queues → jobs → job_executions → job_logs
```

Everything cascades on delete down that chain, so removing an organization
cleanly removes all of its data.

> The diagram below is written in [Mermaid](https://mermaid.js.org/). GitHub,
> GitLab, VS Code (with the Mermaid extension) and most Markdown viewers render
> it natively. The full DDL lives in [`db/schema.sql`](../db/schema.sql).

```mermaid
erDiagram
    organizations ||--o{ memberships   : "has members"
    organizations ||--o{ projects      : "owns"
    users         ||--o{ memberships   : "belongs to"
    projects      ||--o{ retry_policies: "defines"
    projects      ||--o{ queues        : "contains"
    retry_policies||--o{ queues        : "default for"
    retry_policies||--o{ jobs          : "governs"
    queues        ||--o{ jobs          : "holds"
    queues        ||--o{ batches       : "groups"
    queues        ||--o{ scheduled_jobs: "recurs in"
    queues        ||--o{ dead_letters  : "collects"
    jobs          ||--o{ job_executions: "attempted by"
    jobs          ||--o{ job_logs      : "emits"
    jobs          ||--o| dead_letters  : "may become"
    batches       ||--o{ jobs          : "fans out"
    workers       ||--o{ worker_heartbeats : "beats"
    workers       ||--o{ job_executions    : "runs"

    organizations {
        uuid id PK
        text name
        timestamptz created_at
    }
    users {
        uuid id PK
        citext email UK "case-insensitive"
        text password_hash "bcrypt"
        text display_name
    }
    memberships {
        uuid id PK
        uuid org_id FK
        uuid user_id FK
        text role "owner|admin|member|viewer"
    }
    projects {
        uuid id PK
        uuid org_id FK
        text name
        text slug "UNIQUE per org"
    }
    retry_policies {
        uuid id PK
        uuid project_id FK
        text name
        backoff_strategy strategy "fixed|linear|exponential"
        int base_delay_ms
        int max_delay_ms
        int max_attempts
        bool jitter
    }
    queues {
        uuid id PK
        uuid project_id FK
        text name
        int priority "higher drains first"
        int concurrency_limit
        int rate_limit_per_sec "nullable"
        bool is_paused
        int shard
        uuid default_retry_policy_id FK
    }
    jobs {
        uuid id PK
        uuid queue_id FK
        job_kind kind "immediate|delayed|scheduled|recurring|batch"
        job_status status
        text handler
        jsonb payload
        int priority
        text idempotency_key "nullable, unique per queue"
        timestamptz run_at "earliest eligible"
        text cron_expression
        uuid retry_policy_id FK
        int attempt
        int max_attempts
        int timeout_sec
        uuid locked_by "worker holding it"
        timestamptz lock_expires_at
        bigint fence_token "stale workers rejected"
        uuid batch_id
        uuid_array depends_on "workflow deps"
        text last_error
        timestamptz completed_at
    }
    batches {
        uuid id PK
        uuid queue_id FK
        text name
        int total
    }
    scheduled_jobs {
        uuid id PK
        uuid queue_id FK
        text handler
        jsonb payload
        text cron_expression
        bool is_active
        timestamptz next_run_at
        timestamptz last_run_at
    }
    workers {
        uuid id PK
        text name
        text hostname
        worker_status status "alive|draining|dead"
        int concurrency
        int running_count
        timestamptz last_heartbeat
        timestamptz started_at
    }
    worker_heartbeats {
        bigserial id PK
        uuid worker_id FK
        int running_count
        timestamptz ts
    }
    job_executions {
        bigserial id PK
        uuid job_id FK
        uuid worker_id FK
        int attempt
        job_status status
        timestamptz started_at
        timestamptz finished_at
        int duration_ms
        text error
        jsonb result
    }
    job_logs {
        bigserial id PK
        uuid job_id FK
        bigint execution_id FK
        text level "debug|info|warn|error"
        text message
        timestamptz ts
    }
    dead_letters {
        uuid id PK
        uuid job_id FK "UNIQUE"
        uuid queue_id FK
        text reason
        int attempts
        jsonb payload
        text ai_summary
        text ai_category
        numeric ai_confidence
    }
    dispatcher_lease {
        int id PK "singleton = 1"
        text holder
        bigint fence_token
        timestamptz acquired_at
        timestamptz expires_at
    }
```

## Cardinality summary

| Relationship | Type | Delete behaviour |
|---|---|---|
| organization → project | 1 : N | CASCADE |
| organization → membership | 1 : N | CASCADE |
| user → membership | 1 : N | CASCADE |
| project → queue | 1 : N | CASCADE |
| project → retry_policy | 1 : N | CASCADE |
| queue → job | 1 : N | CASCADE |
| retry_policy → queue / job | 1 : N | SET NULL (policy deletion doesn't orphan work) |
| job → job_execution | 1 : N | CASCADE |
| job → job_log | 1 : N | CASCADE |
| job → dead_letter | 1 : 0..1 | CASCADE, `UNIQUE(job_id)` |
| worker → job_execution | 1 : N | SET NULL (keep history if a worker record is removed) |
| worker → worker_heartbeat | 1 : N | CASCADE |
| batch → job | 1 : N | (batch_id is a soft link, indexed) |

## Why it is normalised this way

- **Retry policies are their own table**, not columns on the queue, because one
  policy is reused by many queues *and* individual jobs can override it. This
  removes duplication and lets an operator retune backoff in one place.
- **`job_executions` is separate from `jobs`.** The `jobs` row is mutable state
  (current status, attempt counter); each *attempt* is an immutable fact. Keeping
  attempts in their own append-only table gives us free retry history and makes
  throughput/latency metrics a simple aggregate query without bloating the hot
  `jobs` row.
- **`scheduled_jobs` is separate from `jobs`.** A recurrence *definition* (cron)
  is edited and paused independently of the concrete runs it spawns. Materialising
  runs into `jobs` keeps the claim path uniform — the worker only ever reads one
  table.
- **`worker_heartbeats` is an append-only time series** distinct from the
  workers' latest `last_heartbeat`. The current value lives on `workers` for a
  cheap liveness check; the history table supports charts and post-mortems.
- **`dead_letters` is not just a status.** Although a job also carries the
  `dead_letter` status, the DLQ table stores the *why* (reason, attempt count,
  frozen payload, AI diagnosis) so the operator view and requeue flow don't have
  to reconstruct it.

See [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for indexing and concurrency
rationale.
