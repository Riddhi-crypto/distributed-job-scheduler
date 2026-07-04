# AEGIS — Distributed Job Scheduler

> A production-shaped distributed job scheduler with a live **mission-control**
> dashboard. Jobs are claimed atomically from PostgreSQL with
> `SELECT … FOR UPDATE SKIP LOCKED`, workers self-heal after crashes via lease
> reclaim + fencing tokens, and a single-leader dispatcher handles scheduling and
> recovery. The React control plane gives every capability its own page.

**Demo login:** `demo@aegis.dev` / `password123`

**Video Demonstration:** [Google Drive Link](https://drive.google.com/drive/folders/15gdfdKvkz7bliCusRVMPkw_9txj-_PWw)
or 


https://github.com/user-attachments/assets/db9e2744-02c7-4868-a7aa-0e8805630ae9





---

## Quick start (Docker — one command)

```bash
docker compose up --build
```

This starts PostgreSQL, runs the migration (schema + seed + demo password),
launches the API + dispatcher, a worker, and the dashboard. Then open:

- **Dashboard →** http://localhost:5173
- **API →** http://localhost:4000/api  (health: http://localhost:4000/health)

Sign in with the demo credentials above. To run a bigger fleet and watch
distributed claiming across workers:

```bash
docker compose up --build --scale worker=3
```

---

## Quick start (manual — no Docker)

Requires **Node 20+** and **PostgreSQL 13+** running locally.

```bash
# 0) one-time: create the database
createdb aegis
#    (or: psql -c "CREATE DATABASE aegis;")
#    The default DSN is postgres://aegis:aegis@localhost:5432/aegis — either
#    create a matching role, or set DATABASE_URL to your own (see .env.example).

# 1) migrate + seed (creates tables, demo org/user/queues, sets demo password)
cd backend
npm install
npm run migrate

# 2) start the API + dispatcher            (terminal 1)
npm start                                    # → :4000

# 3) start a worker                          (terminal 2)
cd ../worker && npm install && npm start

# 4) start the dashboard                     (terminal 3)
cd ../frontend && npm install && npm run dev # → :5173
```

Open http://localhost:5173 and sign in.

> **Want to see dispatcher HA?** Start a second API instance on another port —
> `PORT=4001 npm start` in `backend/`. Both run the dispatcher loop; exactly one
> wins the lease. Watch the **Dispatcher Leader** card show the holder, fence
> token, and lease countdown, and fail over if you kill the leader.

---

## Take the tour (what to click)

The dashboard is multi-page — one route per capability, via the left sidebar:

| Page | What it shows |
|---|---|
| **Overview** | Six live KPI cards, the real-time event stream, and the dispatcher-leader / HA card. |
| **Metrics** | Throughput (done vs failed per minute) with a selectable time window. |
| **Workers** | The worker fleet with liveness, concurrency meters, and heartbeats. |
| **Queues** | Every queue with live counts, priority/concurrency/shard, and pause/resume. |
| **Queue detail** | Per-queue config editor + throughput and latency charts. |
| **Jobs** | The job explorer (filter by queue/status/handler) **and** the submit-a-job form for all five job kinds. |
| **Job detail** | Full lifecycle: retry history per attempt, structured logs, retry/cancel. |
| **Dead Letters** | AI failure insights — category, confidence, suggested fix, one-click requeue. |
| **Projects** | Project management. |
| **Chaos Lab** | Inject failures/latency, flood a queue, and kill a worker — then watch it recover. |

**A good 60-second demo:**
1. **Jobs →** submit a few `cpu` jobs; watch them flow on **Overview**.
2. **Chaos Lab →** set fail rate to ~40%; watch jobs fail, retry with backoff, and
   land in **Dead Letters** with an automatic diagnosis. Requeue one.
3. **Chaos Lab →** flood a queue with 200 jobs, then **kill a worker** mid-drain
   and watch its in-flight jobs get reclaimed and finished by others.

---

## Architecture at a glance

```
React dashboard ──HTTP/JWT──► Express API + dispatcher ──SQL──► PostgreSQL
                                                                    ▲
                        workers claim jobs directly (SKIP LOCKED) ──┘
```

Three stateless Node services around one Postgres source of truth. Workers claim
jobs **directly** against the database (not through the API) so claiming is a
single atomic statement. Full detail, diagrams, and the claim query are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, job lifecycle, the SKIP LOCKED claim path, fault-tolerance model. |
| [docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md) | Full Mermaid ER diagram of all tables + normalisation rationale. |
| [docs/API.md](docs/API.md) | Every REST endpoint: method, path, roles, request/response. |
| [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) | Trade-offs, guarantees vs best-effort, and honest limits + upgrade paths. |

---

## Testing

```bash
cd backend
npm test                 # unit tests — no database needed, always run

# integration test proving no duplicate claims under concurrent workers:
DATABASE_URL=postgres://aegis:aegis@localhost:5432/aegis npm test
```

- **Unit tests** cover backoff computation (fixed/linear/exponential + clamping +
  jitter bounds) and the failure classifier (every category + fallback).
- **The integration test** seeds an isolated table, runs 8 concurrent claimers,
  and asserts every job is claimed exactly once — validating the core
  `FOR UPDATE … SKIP LOCKED` guarantee. It's gated on `DATABASE_URL` so the unit
  suite stays offline-friendly.

---

## Project structure

```
aegis-scheduler/
├── docker-compose.yml         # full stack in one command
├── .env.example               # every env var, documented
├── db/
│   ├── schema.sql             # all tables, enums, indexes, triggers
│   └── seed.sql               # demo org/user/project/queues/retry policies
├── backend/                   # Express REST API + dispatcher
│   ├── src/
│   │   ├── index.js           # app wiring, health, graceful shutdown
│   │   ├── config.js  db.js  migrate.js
│   │   ├── middleware/        # auth (JWT + RBAC), http helpers
│   │   ├── routes/            # auth, projects, queues, jobs, workers,
│   │   │                      #   dead-letters, metrics, retry-policies, chaos
│   │   └── services/          # dispatcher (leader lease, reclaim), retry, ai
│   └── tests/                 # unit + concurrency integration tests
├── worker/                    # standalone worker service
│   └── src/
│       ├── worker.js          # poll → SKIP LOCKED claim → run → heartbeat → drain
│       └── handlers.js        # echo/sleep/cpu/http/fail + fault injection
├── frontend/                  # React + Vite + React Router dashboard
│   └── src/
│       ├── pages/             # one page per capability (11 routes)
│       ├── components/        # Layout, shared UI kit, hand-rolled charts
│       └── styles.css         # dark mission-control design system
└── docs/                      # architecture, ER, API, design decisions
```

---

## Tech stack

- **Backend:** Node.js (ESM) · Express · `pg` · JWT (`jsonwebtoken`, `bcryptjs`) ·
  `zod` validation · `cron-parser`
- **Worker:** Node.js · `pg` (own pool)
- **Database:** PostgreSQL 13+ (`FOR UPDATE … SKIP LOCKED`, partial indexes,
  `JSONB`, `citext`, array columns)
- **Frontend:** React 18 · Vite · React Router — dependency-light, charts are
  hand-rolled SVG (no charting library)

---

## Assignment requirement coverage

| Requirement | Where it lives |
|---|---|
| Auth + project management | `routes/auth.js`, `routes/projects.js`; Projects page |
| Queues: priority, concurrency, retry policy, pause/resume, stats | `routes/queues.js`; Queues + Queue-detail pages |
| Job kinds: immediate, delayed, scheduled, recurring (cron), batch | `routes/jobs.js` (`createSchema`); Jobs page submit form |
| Worker: poll, atomic claim, concurrent execution, heartbeat, graceful shutdown | `worker/src/worker.js` |
| Lifecycle Queued→Scheduled→Claimed→Running→Completed + retries + DLQ | `db/schema.sql` (`job_status`), worker + dispatcher |
| Retry strategies: fixed, linear, exponential backoff (+ jitter) | `services/retry.js`, `retry_policies` table |
| Execution logs, retry history, worker assignment, metrics | `job_executions`, `job_logs`; Job-detail + Metrics pages |
| Dashboard: queue health, workers, job explorer, logs, throughput | entire `frontend/` |
| **Bonus:** workflow dependencies (`depends_on`) | claim query dependency gate; job create `dependsOn` |
| **Bonus:** distributed locking / fencing tokens | `fence_token` on jobs + dispatcher lease |
| **Bonus:** queue sharding | `queues.shard` |
| **Bonus:** RBAC | `memberships` + `requireRole` |
| **Bonus:** AI failure summaries | `services/ai.js`; Dead Letters page |
| **Bonus:** live updates | `usePoll` polling across the dashboard |
| Deliverables: setup, architecture + ER diagrams, API docs, design doc, tests | `README.md`, `docs/`, `backend/tests/` |

See [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md) for an honest account
of what is a hard guarantee versus best-effort (e.g. per-queue concurrency), and
the concrete upgrade path for each.
