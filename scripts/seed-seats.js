#!/usr/bin/env node
'use strict';

/**
 * Generate a seat layout from the command line.
 *
 *   node scripts/seed-seats.js --section "Section A" --prefix A --from 1 --to 10
 *   node scripts/seed-seats.js --section Balcony --prefix B --from 1 --to 24 --order 2
 *
 * Safe to re-run: seats that already exist are skipped, never overwritten.
 * The section is created if it does not exist yet.
 */

const db = require('../src/db');

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const opts = args();

  const sectionName = opts.section || 'Main Floor';
  const prefix = String(opts.prefix ?? 'A').toUpperCase();
  const from = Number(opts.from ?? 1);
  const to = Number(opts.to ?? 10);
  const displayOrder = Number(opts.order ?? 1);
  const pad = Number(opts.pad ?? 2);

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error('--from and --to must be whole numbers with --to no lower than --from');
  }
  if (to - from + 1 > 2000) {
    throw new Error('That is more than 2000 seats in one run. Split it into smaller batches.');
  }

  const concert = await db.queryOne(
    'SELECT id, name FROM concerts WHERE is_active = 1 ORDER BY id ASC LIMIT 1',
  );
  if (!concert) {
    throw new Error('No active concert found. Run "npm run migrate" first.');
  }

  let section = await db.queryOne(
    'SELECT id FROM sections WHERE concert_id = ? AND name = ?',
    [concert.id, sectionName],
  );

  if (!section) {
    const result = await db.query(
      'INSERT INTO sections (concert_id, name, display_order) VALUES (?, ?, ?)',
      [concert.id, sectionName, displayOrder],
    );
    section = { id: result.insertId };
    console.log(`Created section "${sectionName}".`);
  }

  const created = [];
  const skipped = [];

  for (let n = from; n <= to; n += 1) {
    const seatNumber = `${prefix}${String(n).padStart(pad, '0')}`;
    try {
      await db.query(
        `INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order, status)
         VALUES (?, ?, ?, ?, ?, 'AVAILABLE')`,
        [concert.id, section.id, seatNumber, prefix, n],
      );
      created.push(seatNumber);
    } catch (err) {
      if (db.isDuplicateKey(err)) skipped.push(seatNumber);
      else throw err;
    }
  }

  console.log(`\nConcert: ${concert.name}`);
  console.log(`Section: ${sectionName}`);
  console.log(`Created ${created.length}: ${created.join(', ') || '(none)'}`);
  if (skipped.length) {
    console.log(`Already existed, left alone (${skipped.length}): ${skipped.join(', ')}`);
  }

  const total = await db.queryOne(
    'SELECT COUNT(*) AS c FROM seats WHERE concert_id = ?',
    [concert.id],
  );
  const capacity = await db.queryOne('SELECT max_capacity FROM concerts WHERE id = ?', [concert.id]);
  console.log(`\n${total.c} seats now exist. Booking capacity is ${capacity.max_capacity}.`);
  if (Number(total.c) < Number(capacity.max_capacity)) {
    console.log('Note: there are fewer seats than the capacity allows, so seats run out first.');
  }

  await db.pool.end();
}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}\n`);
  try {
    await db.pool.end();
  } catch {
    /* pool already closed */
  }
  process.exit(1);
});
