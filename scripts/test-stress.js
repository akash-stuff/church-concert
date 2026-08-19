#!/usr/bin/env node
'use strict';

/**
 * Contention test. Fires many simultaneous bookings at one seat, then has more
 * people than seats scramble for the last few places, and checks the database
 * afterwards for any double-booking.
 *
 *   node scripts/test-stress.js
 *
 * Writes test rows: run it against a scratch database only.
 */

const crypto = require('crypto');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const CONTENDERS = Number(process.env.STRESS_CONTENDERS || 20);

const stamp = Date.now().toString().slice(-5);
let counter = 0;
const nextPhone = () => `+91${stamp}${String((counter += 1)).padStart(5, '0')}`;

function client() {
  const jar = new Map();
  return {
    async request(path, { method = 'GET', body } = {}) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const csrf = jar.get('cc_csrf');
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      return { status: response.status, data };
    },
  };
}

async function recoverCode(db, userId) {
  const row = await db.queryOne(
    `SELECT code_hash FROM whatsapp_verifications
      WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  for (let n = 0; n < 1000000; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (crypto.createHash('sha256').update(candidate).digest('hex') === row.code_hash) return candidate;
  }
  throw new Error('code not recoverable');
}

async function makeVerifiedUser(db, index) {
  const api = client();
  await api.request('/api/csrf');
  const registered = await api.request('/api/auth/register', {
    method: 'POST',
    body: {
      full_name: `Stress ${index}`,
      email: `stress${index}.${stamp}@example.test`,
      mobile_number: nextPhone(),
      whatsapp_number: nextPhone(),
      password: 'ConcertSeat2026x',
      date_of_birth: '1988-03-04',
      gender: 'OTHER',
      address: '3 Bell Tower Road',
      emergency_contact: nextPhone(),
      accept_terms: true,
      confirm_age: true,
    },
  });
  if (registered.status !== 201) {
    throw new Error(`registration ${index} failed: ${JSON.stringify(registered.data)}`);
  }
  const userId = registered.data.user.id;
  const code = await recoverCode(db, userId);
  const verified = await api.request('/api/auth/whatsapp/verify', { method: 'POST', body: { code } });
  if (!verified.data.verified) {
    throw new Error(`verification ${index} failed: ${JSON.stringify(verified.data)}`);
  }
  return { api, userId };
}

async function main() {
  const db = require('../src/db');
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
    if (!ok) failures += 1;
  };

  console.log(`\nContention test against ${BASE} with ${CONTENDERS} concurrent people\n`);

  // Room for everyone, so capacity is not what limits the first round.
  await db.query('UPDATE concerts SET max_capacity = ? WHERE is_active = 1', [CONTENDERS + 10]);

  console.log(`Preparing ${CONTENDERS} verified accounts`);
  const people = [];
  for (let i = 0; i < CONTENDERS; i += 1) {
    // Sequential setup so the auth limiter is not the thing under test.
    people.push(await makeVerifiedUser(db, `${stamp}_${i}`));
  }
  console.log(`  ready\n`);

  // -------------------------------------------------------------------------
  console.log(`Round 1: all ${CONTENDERS} request the same seat at once`);
  const seats = await db.query(
    `SELECT id, seat_number FROM seats WHERE status = 'AVAILABLE' ORDER BY id ASC`,
  );
  if (seats.length < 3) throw new Error('not enough free seats to run the test');
  const target = seats[0];

  const round1 = await Promise.all(
    people.map((p) => p.api.request('/api/bookings', { method: 'POST', body: { seat_id: target.id } })),
  );
  const wins1 = round1.filter((r) => r.status === 201);
  const conflicts = round1.filter((r) => r.data.error?.code === 'SEAT_TAKEN');
  const other = round1.filter((r) => r.status !== 201 && r.data.error?.code !== 'SEAT_TAKEN');

  check(`exactly one booking succeeded on ${target.seat_number}`, wins1.length === 1, `${wins1.length} succeeded`);
  check(
    'every other request got a clear "seat taken" answer',
    conflicts.length === CONTENDERS - 1,
    `${conflicts.length} of ${CONTENDERS - 1}; other codes: ${[...new Set(other.map((r) => `${r.status}/${r.data.error?.code}`))].join(', ')}`,
  );
  check('no request returned a server error', !round1.some((r) => r.status >= 500));

  const liveOnSeat = await db.queryOne(
    `SELECT COUNT(*) AS c FROM bookings WHERE seat_id = ? AND status IN ('PENDING','CONFIRMED')`,
    [target.id],
  );
  check('one live booking on that seat in the database', Number(liveOnSeat.c) === 1, `found ${liveOnSeat.c}`);

  const seatStatus = await db.queryOne('SELECT status FROM seats WHERE id = ?', [target.id]);
  check('the seat row reads BOOKED', seatStatus.status === 'BOOKED', seatStatus.status);

  // -------------------------------------------------------------------------
  console.log('\nRound 2: everyone still seatless scrambles for the last 2 places');
  const stillFree = await db.query(
    `SELECT id FROM seats WHERE status = 'AVAILABLE' ORDER BY id ASC LIMIT 40`,
  );
  const currentLive = await db.queryOne(
    `SELECT COUNT(*) AS c FROM bookings WHERE status IN ('PENDING','CONFIRMED')`,
  );
  const ceiling = Number(currentLive.c) + 2;
  await db.query('UPDATE concerts SET max_capacity = ? WHERE is_active = 1', [ceiling]);
  console.log(`  capacity set to ${ceiling}, which leaves 2 places`);

  const seatless = people.filter((_, index) => round1[index].status !== 201);
  const round2 = await Promise.all(
    seatless.map((p, i) =>
      p.api.request('/api/bookings', {
        method: 'POST',
        body: { seat_ids: [stillFree[i % stillFree.length].id] },
      }),
    ),
  );
  const wins2 = round2.filter((r) => r.status === 201);
  check('exactly 2 more bookings succeeded', wins2.length === 2, `${wins2.length} succeeded`);
  check(
    'the rest were told it is fully booked or the seat was taken',
    round2
      .filter((r) => r.status !== 201)
      .every((r) => ['FULLY_BOOKED', 'SEAT_TAKEN'].includes(r.data.error?.code)),
    [...new Set(round2.filter((r) => r.status !== 201).map((r) => r.data.error?.code))].join(', '),
  );

  const finalLive = await db.queryOne(
    `SELECT COUNT(*) AS c FROM bookings WHERE status IN ('PENDING','CONFIRMED')`,
  );
  check(
    `live bookings never exceeded the ceiling of ${ceiling}`,
    Number(finalLive.c) === ceiling,
    `counted ${finalLive.c}`,
  );

  // -------------------------------------------------------------------------
  console.log('\nRound 3: overlapping multi-seat parties');
  await db.query('UPDATE concerts SET max_capacity = 100000 WHERE id = ?', [
    (await db.queryOne('SELECT concert_id FROM seats ORDER BY id ASC LIMIT 1')).concert_id,
  ]);

  const block = await db.query(
    `SELECT id, seat_number FROM seats WHERE status = 'AVAILABLE' ORDER BY id ASC LIMIT 6`,
  );

  if (block.length === 6) {
    // Every contender asks for four seats out of the same six, in a different
    // order each time. Overlapping sets in differing orders is precisely what
    // deadlocks a naive implementation, which is why seats are locked by
    // ascending id.
    const ids = block.map((seat) => seat.id);
    const parties = people.slice(0, 6).map((p, index) => {
      const rotated = [...ids.slice(index), ...ids.slice(0, index)].slice(0, 4);
      return p.api.request('/api/bookings', { method: 'POST', body: { seat_ids: rotated } });
    });

    const round3 = await Promise.all(parties);
    const won3 = round3.filter((r) => r.status === 201);

    check('no multi-seat request returned a server error', !round3.some((r) => r.status >= 500),
      round3.filter((r) => r.status >= 500).map((r) => JSON.stringify(r.data)).join(' '));
    check('at least one overlapping party succeeded', won3.length >= 1, `${won3.length} won`);
    check(
      'losers were told which seat had gone, not given an internal error',
      round3
        .filter((r) => r.status !== 201)
        .every((r) => ['SEAT_TAKEN', 'FULLY_BOOKED', 'NOT_ENOUGH_CAPACITY'].includes(r.data.error?.code)),
      [...new Set(round3.filter((r) => r.status !== 201).map((r) => r.data.error?.code))].join(', '),
    );

    // All-or-nothing: a party that failed must have left no seats behind.
    const seatOwners = await db.query(
      `SELECT seat_id, booking_reference FROM bookings
        WHERE seat_id IN (${ids.map(() => '?').join(', ')}) AND status IN ('PENDING','CONFIRMED')`,
      ids,
    );
    const perRef = new Map();
    for (const row of seatOwners) {
      perRef.set(row.booking_reference, (perRef.get(row.booking_reference) || 0) + 1);
    }
    check(
      'every successful party got all four of its seats, never a partial set',
      [...perRef.values()].every((count) => count === 4),
      [...perRef.entries()].map(([ref, count]) => `${ref}:${count}`).join(', '),
    );
  } else {
    console.log('  skipped: not enough free seats left for the multi-seat round');
  }

  // -------------------------------------------------------------------------
  console.log('\nDatabase integrity');
  const doubleSeats = await db.query(
    `SELECT seat_id, COUNT(*) AS c FROM bookings
      WHERE status IN ('PENDING','CONFIRMED') GROUP BY seat_id HAVING c > 1`,
  );
  check('no seat has two live bookings', doubleSeats.length === 0, JSON.stringify(doubleSeats));

  // Holding several seats is now allowed, so the old "one booking per user"
  // check is gone. What must hold is that a person never appears twice on the
  // same seat.
  const doubleOnSeat = await db.query(
    `SELECT user_id, seat_id, COUNT(*) AS c FROM bookings
      WHERE status IN ('PENDING','CONFIRMED') GROUP BY user_id, seat_id HAVING c > 1`,
  );
  check('nobody holds the same seat twice', doubleOnSeat.length === 0, JSON.stringify(doubleOnSeat));

  const mismatched = await db.query(
    `SELECT s.id, s.seat_number, s.status,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.seat_id = s.id AND b.status IN ('PENDING','CONFIRMED')) AS live
       FROM seats s
      HAVING (s.status = 'BOOKED' AND live = 0) OR (s.status = 'AVAILABLE' AND live > 0)`,
  );
  check(
    'every seat status matches its booking state',
    mismatched.length === 0,
    JSON.stringify(mismatched),
  );

  const dupeRefSeat = await db.query(
    `SELECT booking_reference, seat_id, COUNT(*) AS c FROM bookings
      GROUP BY booking_reference, seat_id HAVING c > 1`,
  );
  check('no seat appears twice under one reference', dupeRefSeat.length === 0, JSON.stringify(dupeRefSeat));

  const mixedRefs = await db.query(
    `SELECT booking_reference, COUNT(DISTINCT user_id) AS people, COUNT(DISTINCT concert_id) AS concerts
       FROM bookings GROUP BY booking_reference HAVING people > 1 OR concerts > 1`,
  );
  check(
    'each reference belongs to exactly one person and one concert',
    mixedRefs.length === 0,
    JSON.stringify(mixedRefs),
  );

  const gaps = await db.query(
    `SELECT DISTINCT booking_reference FROM bookings ORDER BY booking_reference ASC`,
  );
  const numbers = gaps.map((r) => Number(String(r.booking_reference).split('-').pop()));
  const sequential = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  check('references were issued in an unbroken sequence', sequential, numbers.join(','));

  console.log(`\n${failures === 0 ? 'All contention checks passed.' : `${failures} check(s) failed.`}\n`);
  await db.pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nStress run failed:', err.message);
  process.exit(1);
});
