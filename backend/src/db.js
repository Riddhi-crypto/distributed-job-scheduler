import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Never let a background client error crash the process.
  console.error('[pg] idle client error', err.message);
});

export const query = (text, params) => pool.query(text, params);

/**
 * Run `fn` inside a transaction. Commits on success, rolls back on throw.
 * `fn` receives a dedicated client — use it for all queries in the txn.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
