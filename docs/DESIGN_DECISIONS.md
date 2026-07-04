# AEGIS — Design Decisions & Trade-offs

This document explains the major engineering choices, *why* they were made, and
— importantly — where the honest limits are and how I would extend the system in
production. Engineering judgement matters more than feature count, so I've tried
to be candid about the trade-offs rather than overclaim.

---

## 1. PostgreSQL as the queue (not Redis / RabbitMQ / SQS)

**Decision:** Use one Postgres database as both the system of record and the
queue itself.

**Why:**
- The assignment demands atomic claiming, retries, scheduling, dead-lettering,
  and rich querying (job explorer, metrics, logs). A relational DB gives all of
  that *transactionally* in one place.
- `SELECT … FOR UPDATE SKIP LOCKED` (Postgres 9.5+) is a battle-tested primitive
  for exactly this problem — it's how Sidekiq-pg, Que, and GracefulWorker do it.
- Fewer moving parts: no separate broker to run, secure, and keep consistent
  with the metadata store.

**Trade-off:** A dedicated broker (Redis/SQS) can push higher raw throughput and
gives native pub/sub. At very large scale you'd shard the `jobs` table or move
the hot path to a broker while keeping Postgres for metadata. For an
intern-scale platform that must be *correct, observable, and inspectable*,
Postgres is the right call. The `shard` column on queues is the seam along which
you'd later partition.

---

## 2. Atomic claiming with `FOR UPDATE … SKIP LOCKED`

**Decision:** Workers claim jobs directly against Postgres in a single
transaction; the API is not in the claim path.

**Why it's duplicate-free:** When two workers run the claim query simultaneously,
`SKIP LOCKED` makes each skip rows the other has already row-locked. They can
never select the same job. This is the single most important correctness
property in the system and it's guaranteed by the database, not by application
code that could race.

**Why direct-to-DB, not via HTTP:** Routing claims through the API would add a
network hop and, worse, a window between "API picks a job" and "worker confirms"
where the job's state is ambiguous. One atomic SQL statement removes that window
entirely.

---

## 3. Per-queue concurrency limit: best-effort, and I'll say so

**Decision:** Enforce `concurrency_limit` with a lock-then-rank CTE: lock the
eligible rows, count how many of the queue's jobs are already running, and only
claim up to the remaining headroom.

**Honest limitation:** This is enforced **best-effort**, not with a hard
distributed semaphore. Two workers claiming in the same few milliseconds each
compute headroom against a running-count that doesn't yet include the other's
in-flight claim, so the queue can *transiently* overshoot its limit before the
counts settle. It always converges — it never runs away — but it can briefly
exceed the cap under a thundering herd.

**Why accept it:** A hard global limit requires serialising all claims for a
queue (an advisory lock or a token bucket keyed by queue), which throttles
throughput. For background jobs, a brief, self-correcting overshoot is an
acceptable trade for parallelism. I chose to document this honestly rather than
pretend the guarantee is stricter than it is.

**Production upgrade path:**
- `pg_advisory_xact_lock(queue_id)` around the claim to make the count-and-claim
  atomic per queue (simple; costs some parallelism).
- A Redis token-bucket per queue for a true distributed rate/concurrency limit
  (scales better; adds a dependency).

---

## 4. Fencing tokens against zombie workers

**Decision:** Every job has a monotonic `fence_token`. A worker records it at
claim time and includes `WHERE fence_token = :token` in its completion/failure
updates. The dispatcher bumps the token whenever it reclaims a job.

**The problem it solves:** A worker can stall (GC pause, network partition) long
enough for its lease to expire and its job to be reassigned. When it wakes up it
would happily write a stale result. The fence check makes that write match zero
rows, so the zombie is silently ignored while the new owner proceeds. This is
Martin Kleppmann's fencing-token pattern applied at row granularity.

---

## 5. Single-leader dispatcher via a database lease

**Decision:** A one-row `dispatcher_lease` table. Every API instance periodically
tries to acquire/renew a 15-second lease; only the current holder runs the
dispatcher's promotion and reclaim work.

**Why:** Promotion (scheduled→queued), cron materialisation, and lease reclaim
must run *once*, not once-per-instance, or you'd double-promote jobs. A DB lease
gives leader election without ZooKeeper/etcd.

**Failover:** If the leader dies, its lease expires within 15s and another
instance acquires it — with the lease's own fence token incremented, so a
revived old leader can't act. The "Dispatcher Leader" card shows the holder,
fence token, and remaining lease live. Run two API instances to see failover.

**Trade-off:** Up to ~15s of dispatcher downtime on failover. Tunable via
`DISPATCHER_LEASE_SECONDS`; shorter = faster failover but more lease churn.

---

## 6. Partial indexes for a hot table

**Decision:** The claim query is backed by a **partial** index:

```sql
CREATE INDEX idx_jobs_claimable
  ON jobs (queue_id, priority DESC, run_at ASC)
  WHERE status IN ('queued', 'scheduled');
```

**Why:** `jobs` is append-heavy — completed jobs accumulate forever. A normal
index would grow without bound and slow every claim. The partial index contains
*only claimable rows*, so it stays small and the claim remains O(log n) no matter
how many finished jobs exist. `idx_jobs_lease_expiry` does the same for the
reclaim scan. This is one of the highest-leverage decisions in the schema.

---

## 7. Idempotency

**Decision:** A partial unique index `uq_jobs_idempotency (queue_id,
idempotency_key) WHERE idempotency_key IS NOT NULL`. Enqueues that supply the
same key in the same queue collapse to a single job.

**Why:** Clients retry on network failure. Without idempotency, a retried POST
would enqueue the job twice. The DB constraint makes de-duplication a guarantee,
not a hope. Handlers are also written to be safe to re-run, since at-least-once
delivery means a job can execute more than once across retries.

---

## 8. Retry strategies

**Decision:** Three configurable strategies in `retry_policies` — `fixed`,
`linear`, and `exponential` — each with `base_delay_ms`, `max_delay_ms`,
`max_attempts`, and an optional `jitter` flag. Backoff is computed in
`services/retry.js` (and mirrored in the worker so it needs no API round-trip).

**Why jitter matters:** When many jobs fail together (e.g. a downstream outage),
identical backoff makes them all retry at the same instant — a thundering herd
that re-triggers the outage. Full jitter spreads the retries out. It defaults on.

**Trade-off:** Policies are reusable rows referenced by queues and overridable
per job. This is more tables than hard-coding delays, but it lets operators
retune reliability behaviour without a deploy.

---

## 9. Live updates: polling, not WebSockets

**Decision:** The dashboard polls REST endpoints on sensible intervals (2–5s)
via a `usePoll` hook that skips overlapping requests and pauses when the tab is
hidden.

**Why:** Polling is simple, stateless, and survives API restarts and load-balancer
reconnects with zero extra machinery. For a control-plane dashboard with a
handful of viewers, the traffic is negligible and the operational simplicity is
worth more than push latency.

**Trade-off:** Up to one interval of staleness and more requests than a push
model. WebSockets/SSE would cut latency and load at high viewer counts; the
event-stream and KPI endpoints are already shaped to drop into an SSE stream
later. This was a deliberate simplicity-over-latency choice, called out in the
assignment as an acceptable option.

---

## 10. AI failure summaries: transparent heuristics, not a hidden LLM call

**Decision:** `services/ai.js` classifies a failure into a category (TIMEOUT,
NETWORK, RESOURCE, AUTH, BAD_INPUT, UNKNOWN) with a confidence score and a
suggested fix, using explainable rules over the error text and handler.

**Why:** It's deterministic, instant, free, needs no API key, and runs offline —
appropriate for a self-contained submission. The results are persisted on the
`dead_letters` row and surfaced on the AI Failure Insights page.

**Upgrade path:** The classifier is a single function with a clean input
(`{error, handler}`) and output (`{category, summary, fix, confidence}`).
Swapping in a real LLM call (e.g. Claude) is a one-function change; the schema
columns (`ai_summary`, `ai_category`, `ai_confidence`) and UI already exist. I
deliberately kept the *interface* production-shaped while keeping the
*implementation* dependency-free.

---

## 11. Authentication & RBAC

**Decision:** JWT bearer tokens (bcrypt-hashed passwords), with a `memberships`
table giving each user a role in an org (`owner`/`admin`/`member`/`viewer`).
Mutating routes require `requireRole(...)`.

**Why:** Stateless JWTs mean the API scales horizontally without shared session
storage. RBAC via a join table is the standard normalised approach and satisfies
the bonus requirement. Every data query is scoped by `org_id`, so tenants are
isolated at the query layer.

**Trade-off:** Stateless JWTs can't be revoked before expiry without a denylist.
For this scope, a 7-day expiry is fine; a production system would add refresh
tokens and a revocation list.

---

## 12. Normalisation to 3NF

**Decision:** Separate tables for retry policies, executions, scheduled jobs,
heartbeats, logs, and dead letters rather than folding them into `jobs`/`workers`.

**Why:** Each represents an independent entity with its own lifecycle. Executions
and heartbeats are append-only time series; policies and schedules are edited
independently of the work they govern. Normalisation removes update anomalies and
keeps the hot `jobs` row lean, which directly helps claim performance. Where a
value is read on every liveness check (a worker's latest heartbeat) it's
*denormalised* onto `workers.last_heartbeat` for speed — a conscious exception,
not an oversight.

---

## 13. Rate limiting: modelled, partially enforced

**Honest status:** `queues.rate_limit_per_sec` exists and is configurable through
the API and UI, and the schema/dispatcher are built to honour it. Full
per-second token-bucket *enforcement* across a distributed worker fleet is the
one bonus item I scoped as "modelled but not fully enforced" — doing it correctly
needs the same distributed-token-bucket machinery described in §3, which I chose
not to half-implement. I'd rather ship an honest boundary than a fragile one.

---

## Summary of what's guaranteed vs best-effort

| Property | Guarantee level |
|---|---|
| No duplicate claim of a job | **Hard** (SKIP LOCKED) |
| At-least-once execution | **Hard** (lease reclaim) |
| Zombie writes rejected | **Hard** (fence tokens) |
| Single dispatcher leader | **Hard** (DB lease) |
| Idempotent enqueue | **Hard** (unique index) |
| Per-queue concurrency cap | **Best-effort** (converges; brief overshoot possible) |
| Per-second rate limit | **Modelled**, not fully enforced |
| Live dashboard freshness | **~1 poll interval** (polling by design) |

Being explicit about this table is itself a design decision: a scheduler you
can't reason about is worse than one with well-understood limits.
