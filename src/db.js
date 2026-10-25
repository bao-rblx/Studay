// Database access layer: PostgreSQL connection pool and schema migration.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function createPool(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env, or set it on the platform.');
  }
  return new Pool({
    connectionString: env.DATABASE_URL,
    // Supabase requires TLS; the local Compose Postgres does not.
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(env.DB_POOL_MAX || 5),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { createPool, migrate };
