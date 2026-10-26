// Database access layer: PostgreSQL connection pool and schema migration.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function createPool(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env, or set it on the platform.');
  }
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // Supabase requires TLS; the local Compose Postgres does not.
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(env.DB_POOL_MAX || 5),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // An idle client can be dropped when Supabase pauses or restarts.
  // Without this listener the 'error' event would crash the whole process.
  pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
  return pool;
}

// Codes that mean "the database is unreachable", as opposed to a bad query.
const DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P03', '08006', '08001']);
const isDbDown = (err) => Boolean(err) && (DOWN_CODES.has(err.code) || /timeout exceeded when trying to connect|Connection terminated/i.test(err.message || ''));

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Retry the first connection: a paused free-tier database can take ~30 s to wake.
async function migrateWithRetry(pool, { attempts = 10, delayMs = 3000, log = console } = {}) {
  for (let i = 1; ; i++) {
    try {
      await migrate(pool);
      return;
    } catch (err) {
      if (i >= attempts || !isDbDown(err)) throw err;
      log.warn(`[db] not reachable (${err.code || err.message}), retry ${i}/${attempts - 1} in ${delayMs} ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { createPool, migrate, migrateWithRetry, isDbDown };
