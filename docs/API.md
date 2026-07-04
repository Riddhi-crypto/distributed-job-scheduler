# AEGIS — API Reference

Base URL: `http://localhost:4000/api`
All responses are JSON. All times are ISO-8601 UTC.

## Authentication

Every endpoint except `POST /auth/register`, `POST /auth/login`, and
`GET /health` requires a bearer token:

```
Authorization: Bearer <jwt>
```

The token is returned by register/login and encodes the user, their organization,
and their role. All data is automatically scoped to the caller's organization.

### Roles (RBAC)

| Role | Can read | Can enqueue / requeue / chaos | Can create queues / projects / policies |
|---|---|---|---|
| `viewer` | ✓ | ✗ | ✗ |
| `member` | ✓ | ✓ | ✗ |
| `admin` | ✓ | ✓ | ✓ |
| `owner` | ✓ | ✓ | ✓ |

Mutating routes list their minimum role below. A caller lacking the role gets
`403`.

### Error shape

```json
{ "error": "human-readable message" }
```

Validation errors (bad/missing fields) return `400` with the Zod issue detail.
Common codes: `400` invalid input · `401` missing/invalid token · `403`
insufficient role · `404` not found · `409` conflict (duplicate slug/name/key).

---

## Auth

### `POST /auth/register`
Create an organization, its first user (as `owner`), a default project, and a
default queue.

Request:
```json
{ "email": "you@example.com", "password": "secret12", "displayName": "You", "orgName": "Acme" }
```
Response `201`:
```json
{ "token": "<jwt>", "user": { "id": "…", "email": "you@example.com", "display_name": "You", "role": "owner", "org_id": "…", "org_name": "Acme" } }
```

### `POST /auth/login`
Request: `{ "email": "…", "password": "…" }`
Response `200`: same shape as register (`{ token, user }`).

### `GET /auth/me`
Returns the current user: `{ id, email, display_name, role, org_id, org_name }`.

---

## Projects

### `GET /projects`
```json
{ "data": [ { "id": "…", "name": "default", "slug": "default", "created_at": "…", "queue_count": 2 } ] }
```

### `POST /projects` — role: **admin**
Request: `{ "name": "Billing", "slug": "billing" }` (slug must match `^[a-z0-9-]+$`)
Response `201`: `{ id, name, slug, created_at }` · `409` if slug exists.

---

## Retry policies

### `GET /retry-policies`
`{ "data": [ { id, name, strategy, base_delay_ms, max_delay_ms, max_attempts, jitter, project_id } ] }`

### `POST /retry-policies` — role: **admin**
Request:
```json
{ "projectId": "…", "name": "aggressive", "strategy": "exponential",
  "baseDelayMs": 1000, "maxDelayMs": 300000, "maxAttempts": 5, "jitter": true }
```
`strategy` ∈ `fixed | linear | exponential`.

---

## Queues

### `GET /queues`
Every queue in the org with live counts:
```json
{ "data": [ {
  "id": "…", "name": "default", "priority": 100, "concurrency_limit": 10,
  "rate_limit_per_sec": null, "is_paused": false, "shard": 0, "project_id": "…",
  "pending": 4, "running": 2, "done": 118, "failed": 3, "dead": 1
} ] }
```

### `GET /queues/:id`
Single queue: the full row plus the same live counts.

### `POST /queues` — role: **admin**
Request:
```json
{ "projectId": "…", "name": "critical", "priority": 200,
  "concurrencyLimit": 20, "rateLimitPerSec": null, "shard": 6 }
```
Response `201`: the created queue · `409` if the name exists in the project.

### `PATCH /queues/:id` — role: **admin**
Any subset of: `{ "priority": 150, "concurrencyLimit": 25, "rateLimitPerSec": 100 }`.
Returns the updated queue.

### `POST /queues/:id/pause` · `POST /queues/:id/resume` — role: **admin**
Toggles `is_paused`. Paused queues are skipped by the claim query, so workers
stop pulling from them without losing any jobs. Returns `{ id, name, is_paused }`.

### `GET /queues/:id/stats`
Per-minute throughput for this queue over the last hour:
```json
{ "data": [ { "minute": "2026-07-04T04:30:00Z", "completed": 12, "failed": 1, "avg_ms": 240 } ] }
```

---

## Jobs

### `POST /jobs` — role: **member**
Creates any of the five job kinds. Shared fields:

| Field | Type | Notes |
|---|---|---|
| `queueId` | uuid | **required** |
| `handler` | string | **required** — `echo`, `sleep`, `cpu`, `http`, `fail` |
| `payload` | object | handler input, default `{}` |
| `kind` | enum | `immediate` (default) `delayed` `scheduled` `recurring` `batch` |
| `priority` | int | overrides queue ordering |
| `idempotencyKey` | string | collapses duplicate enqueues in a queue |
| `retryPolicyId` | uuid | overrides the queue default |
| `maxAttempts` | int | |
| `timeoutSec` | int | hard per-attempt timeout |

Kind-specific fields:

| Kind | Extra field | Meaning |
|---|---|---|
| `delayed` | `delaySeconds` | run this many seconds from now |
| `scheduled` | `runAt` (ISO datetime) | run at an absolute time |
| `recurring` | `cronExpression`, `timezone` | cron schedule (materialised by dispatcher) |
| `batch` | `items` (array of payload objects) | fan out one job per item |
| any | `dependsOn` (array of job uuids) | workflow: only claimable once all deps are `completed` |

Examples:
```jsonc
// immediate
{ "queueId": "…", "handler": "echo", "payload": { "msg": "hi" } }
// delayed 30s
{ "queueId": "…", "handler": "sleep", "kind": "delayed", "delaySeconds": 30, "payload": { "ms": 500 } }
// recurring every minute
{ "queueId": "…", "handler": "cpu", "kind": "recurring", "cronExpression": "* * * * *" }
// batch
{ "queueId": "…", "handler": "echo", "kind": "batch", "items": [ { "i": 1 }, { "i": 2 } ] }
```

Responses: a job row, or `{ kind, schedule }` for recurring, or
`{ kind, batchId, jobIds }` for batch.

### `GET /jobs`
Filterable, paginated job explorer.
Query params: `queueId`, `status`, `handler`, `page` (default 1), `limit`
(default 25, max 100).
```json
{ "data": [ {
  "id": "…", "handler": "cpu", "kind": "immediate", "status": "completed",
  "priority": 100, "attempt": 1, "max_attempts": 5, "run_at": "…",
  "created_at": "…", "updated_at": "…", "last_error": null, "queue_name": "default"
} ], "page": 1, "limit": 25, "total": 412 }
```

### `GET /jobs/:id`
Full job detail incl. `queue_name`, `retry_policy_name`, `strategy`, `payload`,
`fence_token`, `depends_on`, timestamps.

### `GET /jobs/:id/executions`
Retry history — one row per attempt:
```json
{ "data": [ { "id": 5, "attempt": 1, "status": "failed", "started_at": "…",
  "finished_at": "…", "duration_ms": 812, "error": "…", "worker_name": "worker-1" } ] }
```

### `GET /jobs/:id/logs`
`{ "data": [ { "id": 9, "level": "info", "message": "…", "ts": "…" } ] }`

### `POST /jobs/:id/retry` — role: **member**
Re-queues a `failed` or `dead_letter` job (resets attempt, bumps fence token).

### `POST /jobs/:id/cancel` — role: **member**
Cancels a `queued` or `scheduled` job (terminal `cancelled` status).

---

## Workers

### `GET /workers`
The fleet, with computed liveness:
```json
{ "data": [ {
  "id": "…", "name": "worker-1", "hostname": "box", "status": "alive",
  "concurrency": 4, "running_count": 2, "last_heartbeat": "…", "started_at": "…",
  "seconds_since_beat": 3, "is_alive": true
} ], "alive": 1, "total": 1 }
```
A worker is `is_alive` if it heartbeat within the liveness window (45s).

### `GET /workers/:id`
Single worker plus its recent heartbeats/executions.

> Workers register and claim work by talking to Postgres directly — this endpoint
> is read-only reporting.

---

## Dead letters (AI Failure Insights)

### `GET /dead-letters`
Query params: `queueId`, `page`, `limit`. Any entry missing a diagnosis is
lazily classified and persisted on read.
```json
{ "data": [ {
  "id": "…", "job_id": "…", "queue_id": "…", "reason": "handler timed out…",
  "attempts": 5, "created_at": "…", "ai_summary": "The handler exceeded its timeout.",
  "ai_category": "TIMEOUT", "ai_confidence": 0.88, "ai_fix": "Raise timeout_sec or…",
  "handler": "sleep", "queue_name": "default"
} ], "page": 1, "limit": 25 }
```
`ai_category` ∈ `TIMEOUT | NETWORK | RESOURCE | AUTH | BAD_INPUT | UNKNOWN`.

### `POST /dead-letters/:id/requeue` — role: **member**
Moves the dead job back to `queued` (attempt reset, fence token bumped) and
removes the DLQ entry. Returns `{ "requeued": "<jobId>" }`.

---

## Metrics

### `GET /metrics/overview`
The KPI cards:
```json
{ "in_flight": 2, "done_per_min": 14, "failed_per_min": 1, "dead_letters": 3,
  "avg_duration_ms": 240, "pending": 5, "workers_alive": 1, "workers_total": 1 }
```

### `GET /metrics/throughput?minutes=30`
`minutes` clamped 5–180.
`{ "data": [ { "t": "04:30", "done": 12, "failed": 1 } ] }`

### `GET /metrics/events`
Unified live feed (last 10 min, newest first, ≤60 rows):
```json
{ "data": [ { "job_id": "…", "handler": "cpu", "event": "completed",
  "status": "completed", "ts": "…", "duration_ms": 210, "queue_name": "default" } ] }
```
`event` ∈ `enqueued | running | completed | failed`.

### `GET /metrics/dispatcher`
Leader/HA card:
```json
{ "isLeader": true, "holder": "api-7f3c", "fenceToken": 4, "leaseRemainingSec": 11, "…": "…" }
```

---

## Chaos (demo controls)

All chaos routes require role **member**.

### `GET /chaos`
Current fault-injection settings: `{ "fail_rate": 0.0, "latency_ms": 0 }`.

### `POST /chaos/inject`
Body (any subset): `{ "failRate": 0.3, "latencyMs": 200 }` (`failRate` 0–1).
Workers read these live and apply them to every handler run. Returns the new
settings.

### `POST /chaos/clear`
Resets fail rate and latency to 0.

### `POST /chaos/kill-worker/:id`
Simulates a crash: marks the worker dead and requeues its in-flight jobs
(bumping their fence tokens). Returns `{ "killed": "<id>", "jobsRequeued": 2 }`.

### `POST /chaos/flood`
Body: `{ "queueId": "…", "count": 40, "handler": "cpu" }` (`count` 1–1000,
default 40). Bulk-enqueues jobs to stress the system. Returns
`{ "enqueued": 40, "queueId": "…" }`.

---

## Health

### `GET /health`
Unauthenticated liveness probe: `{ "ok": true }`.
