#!/usr/bin/env node
'use strict';

/**
 * Runs every .sql file in /migrations once, in filename order, recording each
 * in schema_migrations. Safe to re-run: applied files are skipped.
 *
 *   npm run migrate
 *   npm run migrate:status
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/env');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Split on semicolons that are not inside quotes or comments. */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      current += char;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (char === '-' && next === '-') {
        inLineComment = true;
        current += char;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        current += char;
        continue;
      }
    }

    if (char === "'" && !inDouble && !inBacktick && sql[i - 1] !== '\\') inSingle = !inSingle;
    else if (char === '"' && !inSingle && !inBacktick && sql[i - 1] !== '\\') inDouble = !inDouble;
    else if (char === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (char === ';' && !inSingle && !inDouble && !inBacktick) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => s.replace(/(--[^\n]*|\/\*[\s\S]*?\*\/)/g, '').trim().length);
}

async function main() {
  const statusOnly = process.argv.includes('--status');

  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: false,
    ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
  });

  console.log(`Database: ${env.db.database} on ${env.db.host}:${env.db.port}`);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(190) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [appliedRows] = await connection.execute('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (statusOnly) {
    for (const file of files) {
      console.log(`${applied.has(file) ? '  applied' : '  pending'}  ${file}`);
    }
    await connection.end();
    return;
  }

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip     ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    process.stdout.write(`  running  ${file} (${statements.length} statements) ... `);

    try {
      // DDL in MySQL is not transactional, so a failure part-way needs manual
      // review. Each file is kept small and idempotent to make that rare.
      for (const statement of statements) {
        await connection.query(statement);
      }
      await connection.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('done');
      ran += 1;
    } catch (err) {
      console.log('FAILED');
      console.error(`\n  ${err.message}\n`);
      await connection.end();
      process.exit(1);
    }
  }

  console.log(ran ? `\n${ran} migration(s) applied.` : '\nAlready up to date.');
  await connection.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
