// Local demo server with no database: the whole app on an in-memory Postgres (pg-mem).
// Handy for clicking through the UI without Docker or Supabase.
//   node scripts/dev-mem.js        -> http://127.0.0.1:3210
// Not used in production; server.js is the real entry point.
const { newDb } = require('pg-mem');
const { migrate } = require('../src/db');
const { createApp } = require('../src/app');

async function main() {
  const port = Number(process.env.PORT || 3210);
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const app = createApp({ pool });
  app.listen(port, '127.0.0.1', () => {
    console.log(`Studay dev server (in-memory Postgres) on http://127.0.0.1:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
