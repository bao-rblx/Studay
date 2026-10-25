// Entry point: load configuration, connect, migrate, listen.
require('dotenv').config();
const { createPool, migrate } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);

async function main() {
  const pool = createPool();
  await migrate(pool);
  const app = createApp({ pool });
  app.listen(PORT, '0.0.0.0', () => console.log(`Studay listening on port ${PORT}`));
}

main().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
