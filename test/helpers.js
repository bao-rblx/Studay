// Test helper: an in-memory PostgreSQL (pg-mem) with the real schema applied.
const request = require('supertest');
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

// Same, but with a signed-in agent: nearly every endpoint now needs an account,
// and the cookie has to survive between calls, so tests use supertest's agent.
async function setupWithUser({ email = 'dot@example.com', password = 'password123', name = 'Dot' } = {}) {
  const ctx = await setup();
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/auth/register').send({ email, password, display_name: name });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...ctx, agent, user: res.body.user };
}

module.exports = { setup, setupWithUser, request };
