import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://aegis:aegis@localhost:5432/aegis',
  max: 10,
});

pool.on('error', (err) => console.error('[worker pg] idle error', err.message));

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
