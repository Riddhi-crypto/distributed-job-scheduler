# AEGIS — System Architecture

AEGIS is a distributed job scheduler built around a single principle:
**PostgreSQL is the source of truth, and jobs are claimed atomically with
`SELECT … FOR UPDATE SKIP LOCKED`.** Every hard guarantee in the system —
no duplicate execution, self-healing after a worker crash, exactly-one leader —
is enforced at the database layer, not in application memory. That makes the
components stateless and horizontally scalable.

---

## 1. Component map

```
                         ┌───────────────────────────────┐
                         │   React dashboard (Vite SPA)   │
                         │  11 routed pages, polls REST   │
                         └───────────────┬───────────────┘
                                         │ HTTPS / JSON (JWT)
                                         ▼
                         ┌───────────────────────────────┐
             ┌──────────►│      API server (Express)      │◄──────────┐
             │           │  auth · CRUD · metrics · chaos │           │
             │           │  in-process dispatcher (opt.)  │           │
             │           └───────────────┬───────────────┘           │
   run N for HA                          │                    run N for HA
             │                           │ SQL (pg pool)              │
             │                           ▼                            │
             │           ┌───────────────────────────────┐           │
             └───────────┤          PostgreSQL 13+         ├───────────┘
                         │  jobs · executions · leases…   │
                         └───────────────┬───────────────┘
                                         ▲
                                         │ SKIP LOCKED claim · heartbeat
                                         │ (direct SQL, NOT via the API)
                         ┌───────────────┴───────────────┐
                         │      Worker pool (Node)        │
                         │  poll → claim → run → report   │
                         │   run N for throughput         │
                         └───────────────────────────────┘
```

Three independent services, each a plain Node process:

| Service | Responsibility | Scale by |
|---|---|---|
| **API server** (`backend/`) | REST API, auth, validation, metrics aggregation, chaos controls. Hosts the dispatcher loop in-process. | Run multiple instances behind a load balancer. Stateless. |
| **Worker** (`worker/`) | Polls queues, atomically claims jobs, executes handlers concurrently, heartbeats, drains on shutdown. | Run more processes / more machines. Each adds `WORKER_CONCURRENCY` slots. |
| **Dispatcher** (`backend/src/services/dispatcher.js`) | Promotes due jobs, materialises cron runs, reclaims expired leases, marks dead workers. Single active leader via DB lease. | Runs inside every API instance; only the lease-holder acts. |

**Key decision:** workers talk to Postgres *directly* for claiming, not through
the API. The claim is a single atomic SQL statement; routing it through HTTP
would add a network hop and a race window for no benefit. The API's
`/api/workers` endpoint is read-only reporting.

---

## 2. Job lifecycle

```
                    enqueue (REST)
                         │
          ┌──────────────┴───────────────┐
          │ kind=delayed/scheduled?      │
          ▼                              ▼
     ┌─────────┐  dispatcher promotes  ┌──────────┐
     │scheduled │ ────run_at reached──►│  queued  │
     └─────────┘                       └────┬─────┘
                                            │ worker: SKIP LOCKED claim
                                            ▼
                                       ┌──────────┐
                                       │ claimed  │ (attempt++, lease set)
                                       └────┬─────┘
                                            │ worker starts execution
                                            ▼
                                       ┌──────────┐   success    ┌───────────┐
                                       │ running  │ ────────────►│ completed │
                                       └────┬─────┘              └───────────┘
                                            │ throws / times out
                                            ▼
                                    ┌───────────────┐
                                    │ attempt < max?│
                                    └───┬───────┬───┘
                                    yes │       │ no
                        run_at = now+backoff    ▼
                                    │      ┌─────────────┐
                                    ▼      │ dead_letter │──► AI diagnosis
                                ┌────────┐ └─────────────┘    + requeue btn
                                │ queued │
                                └────────┘
```

The statuses match the assignment exactly: **Queued → Scheduled → Claimed →
Running → Completed**, with retries looping back to Queued and permanent
failures diverting to the Dead Letter Queue. `cancelled` is a terminal state for
user-cancelled pending jobs.

---

## 3. The claim path (the heart of the system)

A worker claims a batch of jobs in **one transaction** using a two-phase CTE:

```sql
WITH eligible AS (
  SELECT j.id
    FROM jobs j
    JOIN queues q ON q.id = j.queue_id
   WHERE j.status IN ('queued','scheduled')
     AND j.run_at <= now()
     AND q.is_paused = false
     AND NOT EXISTS (                          -- workflow dependencies
       SELECT 1 FROM unnest(j.depends_on) dep
        JOIN jobs d ON d.id = dep
       WHERE d.status <> 'completed')
   ORDER BY j.priority DESC, j.run_at ASC
   FOR UPDATE OF j SKIP LOCKED                 -- ← the magic
   LIMIT :lock_batch
),
ranked AS (                                    -- enforce concurrency headroom
  SELECT e.id,
         row_number() OVER (PARTITION BY q.id ORDER BY j.priority DESC) AS rn,
         q.concurrency_limit - running.cnt      AS headroom
    FROM eligible e … LEFT JOIN running …
)
UPDATE jobs SET status='claimed', locked_by=:worker,
                lock_expires_at=now()+:lease, attempt=attempt+1
 WHERE id IN (SELECT id FROM ranked WHERE rn <= GREATEST(headroom,0))
 RETURNING *;
```

- **`FOR UPDATE … SKIP LOCKED`** means two workers running this query at the
  same instant never see the same row — the second simply skips locked rows and
  moves on. This is what makes claiming duplicate-free without any external lock
  manager.
- The **partial index** `idx_jobs_claimable ON jobs(queue_id, priority DESC,
  run_at ASC) WHERE status IN ('queued','scheduled')` keeps this query O(log n)
  even with millions of finished jobs, because the index only contains rows that
  are still claimable.
- The **`ranked` phase** enforces the per-queue `concurrency_limit` best-effort
  (see [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for the honest limits).

---

## 4. Fault tolerance

### Worker crash → self-healing
Every claimed job carries `lock_expires_at`. A live worker renews it on each
heartbeat. If a worker dies, it stops renewing; the dispatcher's
`reclaimExpiredLeases()` finds jobs whose lease is in the past and either
requeues them (incrementing `fence_token`) or dead-letters them if retries are
exhausted. The Chaos Lab's "Kill a worker" button demonstrates this on demand.

### Fencing tokens → no zombie writes
A worker that pauses (GC, network partition) may wake up after its job was
reclaimed and given to another worker. To stop it corrupting state, every claim
records the current `fence_token`, and the worker completes/fails with
`WHERE fence_token = :token`. If the dispatcher bumped the token during reclaim,
the zombie's `UPDATE` matches 0 rows and its result is discarded.

### Dispatcher HA → single leader
The `dispatcher_lease` table holds one row. Each API instance tries to acquire a
short (15s) lease; only the holder runs promotion/reclaim work. If it dies, the
lease expires and another instance takes over. The fence token on the lease
increments on every takeover. This is the classic leader-election-via-lease
pattern, shown live in the "Dispatcher Leader" card.

---

## 5. Request flow (enqueue example)

```
Client                API server              PostgreSQL
  │  POST /api/jobs        │                       │
  │───────────────────────►│                       │
  │                        │ verify JWT            │
  │                        │ zod-validate body     │
  │                        │ resolve queue in org  │
  │                        │──── INSERT job ──────►│
  │                        │   (idempotency key    │
  │                        │    collapses dupes)   │
  │                        │◄──── job row ─────────│
  │◄─── 201 { job } ───────│                       │
  │                        │                       │
  │              (later)   │      Worker: claim ──►│  SKIP LOCKED
  │                        │      Worker: run      │
  │                        │      Worker: report ─►│  execution + status
```

---

## 6. Observability

Nothing is ephemeral. Every attempt is a row in `job_executions` (with
`duration_ms`), every log line is a row in `job_logs`, every heartbeat is a row
in `worker_heartbeats`. The dashboard's KPIs, throughput chart, and event stream
are all straightforward aggregate queries over these tables — no separate
metrics store required for this scale.

See [API.md](./API.md) for the full endpoint reference and
[DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) for the trade-offs behind each of
these choices.
