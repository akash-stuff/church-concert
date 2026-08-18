#!/usr/bin/env node
'use strict';

/**
 * Return a scratch database to its freshly-seeded state so the test scripts can
 * be run repeatedly. Deletes every user, booking, message and audit row, and
 * removes any concert, section or seat the tests added.
 *
 *   node scripts/test-reset.js
 *
 * This destroys data. It refuses to run with NODE_ENV=production, but that is a
 * seatbelt, not a guarantee: only ever point DATABASE_URL at a scratch database.
 */

const db = require('../src/db');
const env = require('../src/env');

const SEEDED_CONCERTS = ['Night of Worship', 'New Year Praise Night'];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production.');
  }

  console.log(`Resetting ${env.db.database} on ${env.db.host}\n`);

  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'bookings',
      'whatsapp_verifications',
      'password_resets',
      'notifications',
      'audit_logs',
      'users',
    ]) {
      await db.query(`TRUNCATE TABLE ${table}`);
      console.log(`  cleared  ${table}`);
    }

    const placeholders = SEEDED_CONCERTS.map(() => '?').join(', ');
    const extra = await db.query(
      `SELECT id, name FROM concerts WHERE name NOT IN (${placeholders})`,
      SEEDED_CONCERTS,
    );
    for (const concert of extra) {
      await db.query('DELETE FROM seats WHERE concert_id = ?', [concert.id]);
      await db.query('DELETE FROM sections WHERE concert_id = ?', [concert.id]);
      await db.query('DELETE FROM concerts WHERE id = ?', [concert.id]);
      await db.query('DELETE FROM counters WHERE name = ?', [`booking_reference:${concert.id}`]);
      console.log(`  removed  concert "${concert.name}"`);
    }

    // Sections the tests added to the seeded concerts, and their seats.
    const seeded = await db.query(
      `SELECT id FROM concerts WHERE name IN (${placeholders})`,
      SEEDED_CONCERTS,
    );
    const keep = new Set(['Section A', 'Section B', 'Nave']);
    for (const concert of seeded) {
      const sections = await db.query('SELECT id, name FROM sections WHERE concert_id = ?', [
        concert.id,
      ]);
      for (const section of sections) {
        if (keep.has(section.name)) continue;
        await db.query('DELETE FROM seats WHERE section_id = ?', [section.id]);
        await db.query('DELETE FROM sections WHERE id = ?', [section.id]);
        console.log(`  removed  section "${section.name}"`);
      }
    }

    await db.query(`UPDATE seats SET status = 'AVAILABLE', note = NULL`);
    await db.query('UPDATE counters SET value = 0');
    await db.query(
      `UPDATE concerts SET max_capacity = 10, max_seats_per_booking = 0 WHERE name = ?`,
      [SEEDED_CONCERTS[0]],
    );
    await db.query(
      `UPDATE concerts SET max_capacity = 30, max_seats_per_booking = 0 WHERE name = ?`,
      [SEEDED_CONCERTS[1]],
    );
    console.log('  reset    seats, counters and capacities');
  } finally {
    await db.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const seats = await db.queryOne('SELECT COUNT(*) AS c FROM seats');
  const concerts = await db.queryOne('SELECT COUNT(*) AS c FROM concerts');
  console.log(`\nReady: ${concerts.c} concerts, ${seats.c} seats, no users or bookings.\n`);

  await db.pool.end();
}

main().catch(async (err) => {
  console.error(`\nReset failed: ${err.message}\n`);
  try {
    await db.pool.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
