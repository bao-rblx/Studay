// Test helper: an in-memory PostgreSQL (pg-mem) with the real schema applied.
const { newDb } = require('pg-mem');
const { migrate } = require('../src/db');
const { createApp } = require('../src/app');

async function setup() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return { pool, app: createApp({ pool }) };
}

module.exports = { setup };
