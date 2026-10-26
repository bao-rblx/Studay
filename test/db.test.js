const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrateWithRetry, isDbDown, createPool } = require('../src/db');

const quiet = { warn: () => {} };
const refused = () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; return e; };

test('isDbDown recognises connection errors but not query errors', () => {
  assert.equal(isDbDown(refused()), true);
  assert.equal(isDbDown(Object.assign(new Error('syntax'), { code: '42601' })), false);
});

test('migrateWithRetry waits for the database to wake up', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; if (calls < 3) throw refused(); } };
  await migrateWithRetry(pool, { attempts: 5, delayMs: 1, log: quiet });
  assert.equal(calls, 3);
});

test('migrateWithRetry gives up after the last attempt', async () => {
  const pool = { query: async () => { throw refused(); } };
  await assert.rejects(migrateWithRetry(pool, { attempts: 2, delayMs: 1, log: quiet }), /ECONNREFUSED/);
});

test('createPool refuses to start without DATABASE_URL', () => {
  assert.throws(() => createPool({}), /DATABASE_URL is not set/);
});
