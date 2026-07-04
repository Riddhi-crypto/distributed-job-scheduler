import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, '../../db');

async function run() {
  const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(dbDir, 'seed.sql'), 'utf8');

  console.log('→ applying schema.sql');
  await pool.query(schema);

  console.log('→ applying seed.sql');
  await pool.query(seed);

  // Set a real bcrypt hash for the demo user (the seed placeholder is inert).
  const hash = await bcrypt.hash('password123', 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [
    hash,
    'demo@aegis.dev',
  ]);

  console.log('✓ migration complete. Login: demo@aegis.dev / password123');
  await pool.end();
}

run().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
