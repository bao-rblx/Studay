// Test helper: an in-memory PostgreSQL (pg-mem) with the real schema applied.
const { newDb } = require('pg-mem');
const { migrate } = require('../src/db');
const { createApp } = require('../src/app');

// API tests must never call the real Gemini API, even if a key is set in the shell.
delete process.env.GEMINI_API_KEY;

async function setup() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return { pool, app: createApp({ pool }) };
}

module.exports = { setup };
