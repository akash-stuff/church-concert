'use strict';

const env = require('./env');
const db = require('./db');
const app = require('./app');
const { passwordAlgorithm } = require('./lib/helpers');

async function start() {
  try {
    await db.ping();
    console.log(`[startup] connected to MySQL at ${env.db.host}:${env.db.port}/${env.db.database}`);
  } catch (err) {
    console.error(`[startup] cannot reach MySQL: ${err.message}`);
    console.error('[startup] check DATABASE_URL, the MySQL user grants, and any firewall rules.');
    process.exit(1);
  }

  const missing = await missingTables();
  if (missing.length) {
    console.error(`[startup] these tables are missing: ${missing.join(', ')}`);
    console.error('[startup] run `npm run migrate` first.');
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    console.log(`[startup] ${env.appName} listening on http://localhost:${env.port}`);
    console.log(`[startup] password hashing: ${passwordAlgorithm()}`);
    console.log(`[startup] whatsapp driver: ${env.whatsapp.driver}`);
  });

  const shutdown = (signal) => async () => {
    console.log(`[shutdown] ${signal} received, closing`);
    server.close(async () => {
      await db.pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection:', reason);
  });
}

async function missingTables() {
  const required = [
    'users',
    'admins',
    'concerts',
    'sections',
    'seats',
    'bookings',
    'whatsapp_verifications',
    'notifications',
    'audit_logs',
    'counters',
    'app_settings',
  ];
  const rows = await db.query(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?`,
    [env.db.database],
  );
  const present = new Set(rows.map((r) => String(r.name).toLowerCase()));
  return required.filter((t) => !present.has(t));
}

start();
