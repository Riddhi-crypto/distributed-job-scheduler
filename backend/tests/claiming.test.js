import { test } from 'node:test';
import assert from 'node:assert/strict';
// NOTE: `pg` is imported dynamically inside the test body (not at module top)
// so the offline unit suite runs even before `npm install` and when this test
// is skipped for lack of a DATABASE_URL.

/**
 * Integration test for the core correctness guarantee of the whole system:
 *   `SELECT ... FOR UPDATE SKIP LOCKED` never hands the same job to two workers.
 *
 * This is GATED on DATABASE_URL being set, so the offline unit suite still runs
 * with plain `npm test`. To run it:
 *
 *   DATABASE_URL=postgres://aegis:aegis@localhost:5432/aegis npm test
 *
 * It is fully isolated: it creates and drops its own throwaway table and never
 * touches application data. The claim query mirrors the worker's real claim
 * path (ordered by priority then run_at, FOR UPDATE SKIP LOCKED).
 */
const DSN = process.env.DATABASE_URL;
const RUN = Boolean(DSN);

test(
  'FOR UPDATE SKIP LOCKED gives every job to exactly one concurrent claimer',
  { skip: RUN ? false : 'set DATABASE_URL to run the DB integration test' },
  async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: DSN, max: 12 });
    const TABLE = 'claim_test_jobs';
    const N = 200; // jobs to seed
    const CLAIMERS = 8; // simulated concurrent workers
    const BATCH = 5; // rows each worker grabs per claim

    try {
      // ---- isolated fixture ------------------------------------------------
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await pool.query(`
        CREATE TABLE ${TABLE} (
          id       BIGSERIAL PRIMARY KEY,
          status   TEXT NOT NULL DEFAULT 'queued',
          priority INT  NOT NULL DEFAULT 100,
          run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          claimed_by INT
        )`);
      await pool.query(
        `INSERT INTO ${TABLE} (priority)
         SELECT (g % 5) * 10 FROM generate_series(1, $1) g`,
        [N]
      );

      // ---- one worker's claim loop ----------------------------------------
      // Mirrors worker.js: lock eligible rows with SKIP LOCKED, then flip them.
      async function claimLoop(workerId) {
        const client = await pool.connect();
        const got = [];
        try {
          for (;;) {
            await client.query('BEGIN');
            const { rows } = await client.query(
              `WITH eligible AS (
                 SELECT id FROM ${TABLE}
                  WHERE status = 'queued' AND run_at <= now()
                  ORDER BY priority DESC, run_at ASC
                  FOR UPDATE SKIP LOCKED
                  LIMIT $1
               )
               UPDATE ${TABLE} t
                  SET status = 'claimed', claimed_by = $2
                 FROM eligible e
                WHERE t.id = e.id
                RETURNING t.id`,
              [BATCH, workerId]
            );
            await client.query('COMMIT');
            if (rows.length === 0) break; // queue drained
            for (const r of rows) got.push(Number(r.id));
            // brief yield to interleave with other claimers
            await new Promise((res) => setImmediate(res));
          }
        } finally {
          client.release();
        }
        return got;
      }

      // ---- run all claimers concurrently ----------------------------------
      const results = await Promise.all(
        Array.from({ length: CLAIMERS }, (_, i) => claimLoop(i + 1))
      );
      const claimed = results.flat();

      // ---- assertions: the whole point ------------------------------------
      // 1) No id claimed more than once.
      const unique = new Set(claimed);
      assert.equal(unique.size, claimed.length, 'a job was claimed by more than one worker');

      // 2) Every job was claimed exactly once.
      assert.equal(claimed.length, N, 'not every job was claimed exactly once');

      // 3) The table agrees: nothing left queued, N rows claimed.
      const { rows: check } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'queued')::int  AS still_queued,
           COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed
         FROM ${TABLE}`
      );
      assert.equal(check[0].still_queued, 0, 'jobs left unclaimed');
      assert.equal(check[0].claimed, N, 'claimed count mismatch');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
      await pool.end();
    }
  }
);
