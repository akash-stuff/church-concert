#!/usr/bin/env node
'use strict';

/**
 * Creates or updates the first admin account.
 *
 *   npm run seed:admin
 *
 * Reads SEED_ADMIN_EMAIL / SEED_ADMIN_NAME / SEED_ADMIN_PASSWORD from .env, and
 * prompts for anything missing. The password is never echoed or logged.
 */

const readline = require('readline');
const env = require('../src/env');
const db = require('../src/db');
const { hashPassword, passwordAlgorithm } = require('../src/lib/helpers');

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      const onData = (char) => {
        const c = String(char);
        if (c === '\n' || c === '\r' || c === '\u0004') {
          process.stdin.removeListener('data', onData);
        } else {
          readline.moveCursor(process.stdout, -1, 0);
          readline.clearLine(process.stdout, 1);
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function weakPassword(password) {
  if (password.length < 12) return 'Use at least 12 characters for an admin password.';
  if (!/[a-z]/.test(password)) return 'Include a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Include an uppercase letter.';
  if (!/\d/.test(password)) return 'Include a number.';
  return null;
}

async function main() {
  const email = (env.seedAdmin.email || (await ask('Admin email: '))).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('That is not a valid email address.');
    process.exit(1);
  }

  const name = env.seedAdmin.name || (await ask('Full name: ')) || 'Administrator';

  let password = env.seedAdmin.password;
  if (!password) {
    password = await ask('Password (not shown): ', { silent: true });
    const confirm = await ask('Repeat password: ', { silent: true });
    if (password !== confirm) {
      console.error('Those passwords do not match.');
      process.exit(1);
    }
  }

  const weakness = weakPassword(password);
  if (weakness) {
    console.error(weakness);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await db.queryOne('SELECT id FROM admins WHERE email = ?', [email]);

  if (existing) {
    await db.query(
      `UPDATE admins
          SET password_hash = ?, full_name = ?, is_active = 1, token_version = token_version + 1
        WHERE id = ?`,
      [hash, name, existing.id],
    );
    console.log(`\nUpdated the admin account for ${email}. Existing admin sessions are now signed out.`);
  } else {
    const isFirst = await db.queryOne('SELECT COUNT(*) AS count FROM admins');
    const role = Number(isFirst.count) === 0 ? 'SUPER_ADMIN' : 'ADMIN';
    await db.query(
      'INSERT INTO admins (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, role],
    );
    console.log(`\nCreated ${role} ${email}.`);
  }

  console.log(`Hashing: ${passwordAlgorithm()}`);
  console.log(`Sign in at ${env.appUrl}/admin/login.html`);

  if (env.seedAdmin.password) {
    console.log('\nRemove SEED_ADMIN_PASSWORD from .env now that the account exists.');
  }

  await db.pool.end();
}

main().catch(async (err) => {
  console.error(err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
