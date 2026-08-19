#!/usr/bin/env node
'use strict';

/**
 * End-to-end test against a running server and a real MySQL database.
 *
 *   node scripts/test-integration.js
 *
 * Exercises the rules that must never break: the age gate, one booking per
 * user, one booking per seat under concurrency, and the capacity ceiling.
 * It writes test rows into whatever database DATABASE_URL points at, so run it
 * against a scratch database, never production.
 */

const BASE = process.env.TEST_BASE_URL || 'https://church-concert-20gs.onrender.com';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  pass  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A tiny cookie-jar client, one per simulated person. */
function client() {
  const jar = new Map();

  return {
    jar,
    async request(path, { method = 'GET', body } = {}) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      if (jar.size) {
        headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      const csrf = jar.get('cc_csrf');
      if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;

      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }

      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      return { status: response.status, data };
    },
    async primeCsrf() {
      await this.request('/api/csrf');
    },
  };
}

const stamp = Date.now().toString().slice(-5);
/** Seat prefix unique to this run, so repeat runs cannot collide on seat numbers. */
const seatPrefix = String.fromCharCode(65 + (Number(stamp) % 26)) + String.fromCharCode(65 + (Number(stamp.slice(-2)) % 26));
let phoneCounter = 0;

/** Distinct E.164 numbers: +91, 5 digits of run stamp, 5 of counter. */
function nextPhone() {
  phoneCounter += 1;
  return `+91${stamp}${String(phoneCounter).padStart(5, '0')}`;
}

function person(index, { dob = '1990-05-12' } = {}) {
  return {
    full_name: `Test Person ${index}`,
    email: `person${index}.${stamp}@example.test`,
    mobile_number: nextPhone(),
    whatsapp_number: nextPhone(),
    password: 'ConcertSeat2026x',
    date_of_birth: dob,
    gender: 'PREFER_NOT_TO_SAY',
    address: '14 Chapel Lane, Springfield',
    emergency_contact: nextPhone(),
    accept_terms: true,
    confirm_age: true,
  };
}

/** Read the code the mock driver stored, so the flow can be completed. */
async function verifyWhatsapp(db, api, userId) {
  const code = await currentCode(db, userId);
  return api.request('/api/auth/whatsapp/verify', { method: 'POST', body: { code } });
}

const crypto = require('crypto');

/**
 * Poll until `probe` returns something truthy, or give up. For assertions about
 * work the server deliberately does after replying.
 */
async function waitFor(probe, { attempts = 20, delayMs = 50 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await probe();
    if (result) return result;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function currentCode(db, userId) {
  // The database stores only a hash, so brute-force the 6-digit space against
  // it. Test-only: it is how we learn the code the mock driver "sent".
  const row = await db.queryOne(
    `SELECT code_hash FROM whatsapp_verifications
      WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  if (!row) throw new Error('no pending verification code');
  for (let n = 0; n < 1000000; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (crypto.createHash('sha256').update(candidate).digest('hex') === row.code_hash) {
      return candidate;
    }
  }
  throw new Error('could not recover the verification code');
}

async function main() {
  const db = require('../src/db');

  console.log(`\nTesting ${BASE}\n`);

  // -------------------------------------------------------------------------
  console.log('Health and setup');
  const anon = client();
  await anon.primeCsrf();
  const health = await anon.request('/api/health');
  check('health endpoint reports ok', health.data.status === 'ok', JSON.stringify(health.data));

  const concert = await anon.request('/api/concert');
  check('a concert is configured', Boolean(concert.data.concert?.name));
  check(
    'default capacity is 10',
    concert.data.availability?.max_capacity === 10,
    `got ${concert.data.availability?.max_capacity}`,
  );

  // -------------------------------------------------------------------------
  console.log('\nCSRF protection');
  const noCsrf = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'a@b.test', password: 'whatever123' }),
  });
  check('a state-changing request without a CSRF token is refused', noCsrf.status === 403);

  // -------------------------------------------------------------------------
  console.log('\nAge gate');
  const minor = client();
  await minor.primeCsrf();
  const under = await minor.request('/api/auth/register', {
    method: 'POST',
    body: person('minor', { dob: new Date(Date.now() - 15 * 365.25 * 864e5).toISOString().slice(0, 10) }),
  });
  check('a 15-year-old is refused', under.status === 403 && under.data.error?.code === 'UNDER_AGE');
  check(
    'the refusal uses the required wording',
    String(under.data.error?.message || '').includes(
      'Registration is available only for participants aged 18 years or above',
    ),
  );

  // A birthday tomorrow means still 17 today: the boundary must hold.
  const almost = new Date();
  almost.setUTCFullYear(almost.getUTCFullYear() - 18);
  almost.setUTCDate(almost.getUTCDate() + 1);
  const boundary = await minor.request('/api/auth/register', {
    method: 'POST',
    body: person('boundary', { dob: almost.toISOString().slice(0, 10) }),
  });
  check('someone who turns 18 tomorrow is refused', boundary.status === 403);

  // Eighteen today exactly must be allowed.
  const exactly = new Date();
  exactly.setUTCFullYear(exactly.getUTCFullYear() - 18);
  const eighteenToday = client();
  await eighteenToday.primeCsrf();
  const onDay = await eighteenToday.request('/api/auth/register', {
    method: 'POST',
    body: person('eighteen', { dob: exactly.toISOString().slice(0, 10) }),
  });
  check('someone who turns 18 today is accepted', onDay.status === 201, JSON.stringify(onDay.data));

  // -------------------------------------------------------------------------
  console.log('\nRegistration and duplicate accounts');
  const alice = client();
  await alice.primeCsrf();
  const aliceData = person('alice');
  const registered = await alice.request('/api/auth/register', { method: 'POST', body: aliceData });
  check('an adult can register', registered.status === 201, JSON.stringify(registered.data));
  const aliceId = registered.data.user?.id;
  check('registration returns the new user id', Number.isInteger(aliceId));
  if (!Number.isInteger(aliceId)) {
    throw new Error(`cannot continue without a registered user: ${JSON.stringify(registered.data)}`);
  }
  check('a verification code was issued', registered.data.verification?.sent === true);
  check(
    'the code went out on both channels',
    registered.data.verification?.channels?.whatsapp?.sent === true &&
      registered.data.verification?.channels?.email?.sent === true,
    JSON.stringify(registered.data.verification?.channels),
  );
  // The legacy `whatsapp` block is a compatibility shim for older front ends;
  // it is covered so that removing it cannot pass unnoticed.
  check('the legacy whatsapp block is still present', registered.data.whatsapp?.sent === true);

  const dupe = client();
  await dupe.primeCsrf();
  const duplicate = await dupe.request('/api/auth/register', { method: 'POST', body: aliceData });
  check(
    'the same email cannot register twice',
    duplicate.status === 409 && duplicate.data.error?.code === 'DUPLICATE_ACCOUNT',
  );

  const sharedPhone = { ...person('phonetwin'), whatsapp_number: aliceData.whatsapp_number };
  const dupePhone = await dupe.request('/api/auth/register', { method: 'POST', body: sharedPhone });
  check('a WhatsApp number cannot be reused', dupePhone.status === 409);

  // -------------------------------------------------------------------------
  console.log('\nPassword reset goes out by email, and only works once');

  // The reply must not differ between a registered and an unknown address, or
  // the endpoint becomes an account-enumeration oracle.
  const forgotKnown = await anon.request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: aliceData.email },
  });
  const forgotUnknown = await anon.request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: `nobody-${stamp}@example.org` },
  });
  check(
    'forgot-password accepts a registered address',
    forgotKnown.status === 200 && forgotKnown.data.ok === true,
    JSON.stringify(forgotKnown.data),
  );
  check(
    'an unknown address gets the identical reply',
    forgotUnknown.status === 200 &&
      JSON.stringify(forgotUnknown.data) === JSON.stringify(forgotKnown.data),
    `${JSON.stringify(forgotKnown.data)} vs ${JSON.stringify(forgotUnknown.data)}`,
  );

  // The link is delivered by email and nothing else. The route does not await
  // the send — awaiting SMTP would leak whether the address exists through
  // response timing — so poll briefly rather than reading once and racing it.
  const resetNotifications = await waitFor(async () => {
    const rows = await db.query(
      `SELECT channel, recipient, status FROM notifications
        WHERE user_id = ? AND type = 'PASSWORD_RESET' ORDER BY id DESC`,
      [aliceId],
    );
    return rows.length ? rows : null;
  });
  check('a reset notification was recorded', Array.isArray(resetNotifications));
  check(
    'the reset link was sent by email',
    (resetNotifications || []).some(
      (row) => row.channel === 'EMAIL' && row.recipient === aliceData.email,
    ),
    JSON.stringify(resetNotifications),
  );
  check(
    'the reset link was NOT sent over WhatsApp',
    !(resetNotifications || []).some((row) => row.channel === 'WHATSAPP'),
    JSON.stringify(resetNotifications),
  );

  // Only the hash is stored, so the test has to mint a token the same way the
  // route does rather than reading one back out of the table.
  const resetToken = crypto.randomBytes(24).toString('hex');
  const resetHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
    [aliceId, resetHash],
  );

  const badToken = await anon.request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: 'not-a-real-token', password: 'BrandNewPass1' },
  });
  check('an unknown reset token is refused', badToken.status === 400);

  const newPassword = 'ResetPass99x';
  const usedReset = await anon.request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: newPassword },
  });
  check('a valid reset token sets the new password', usedReset.status === 200, JSON.stringify(usedReset.data));

  const replay = await anon.request('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: 'AnotherPass1' },
  });
  check('the same reset token cannot be replayed', replay.status === 400);

  // Signing back in proves the new password took, and re-arms `alice` for the
  // checks that follow — the reset bumped token_version and signed her out.
  const reLogin = await alice.request('/api/auth/login', {
    method: 'POST',
    body: { identifier: aliceData.email, password: newPassword },
  });
  check('the new password signs in', reLogin.status === 200, JSON.stringify(reLogin.data));
  aliceData.password = newPassword;

  // -------------------------------------------------------------------------
  console.log('\nBooking is gated on WhatsApp verification');
  const seatList = await anon.request('/api/seats');
  const allSeats = seatList.data.sections.flatMap((s) => s.seats);
  check('the seat map has seats', allSeats.length >= 20, `got ${allSeats.length}`);

  const early = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_id: allSeats[0].id },
  });
  check(
    'an unverified user cannot book',
    early.status === 403 && early.data.error?.code === 'WHATSAPP_NOT_VERIFIED',
  );

  const wrongCode = await alice.request('/api/auth/whatsapp/verify', {
    method: 'POST',
    body: { code: '000000' },
  });
  check('a wrong code is refused', wrongCode.status === 400);

  const verified = await verifyWhatsapp(db, alice, aliceId);
  check('the right code verifies the number', verified.data.verified === true, JSON.stringify(verified.data));

  // -------------------------------------------------------------------------
  console.log('\nBooking');
  const booked = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_id: allSeats[0].id },
  });
  check('a verified adult can book a seat', booked.status === 201, JSON.stringify(booked.data));
  const reference = booked.data.booking?.booking_reference;
  check(
    `the reference looks like CHC-YYYY-00001 (got ${reference})`,
    /^CHC-\d{4}-\d{5}$/.test(String(reference)),
  );

  const seatAfter = await db.queryOne('SELECT status FROM seats WHERE id = ?', [allSeats[0].id]);
  check('the seat is marked BOOKED in the database', seatAfter.status === 'BOOKED');

  const second = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_ids: [allSeats[1].id] },
  });
  check(
    'the same account can now book a further seat',
    second.status === 201,
    JSON.stringify(second.data),
  );
  check(
    'a separate booking gets its own reference',
    second.data.booking?.booking_reference !== reference,
    `${second.data.booking?.booking_reference} vs ${reference}`,
  );

  // Book three seats in one go: one reference should cover the whole party.
  const party = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_ids: [allSeats[2].id, allSeats[3].id, allSeats[4].id] },
  });
  check('three seats can be booked in one request', party.status === 201, JSON.stringify(party.data));
  check('the party reports three seats', party.data.booking?.seat_count === 3);
  check(
    'all three seats share one reference',
    /^CHC-\d{4}-\d{5}$/.test(String(party.data.booking?.booking_reference)),
  );

  const partyRows = await db.query(
    `SELECT seat_id FROM bookings WHERE booking_reference = ? AND status IN ('PENDING','CONFIRMED')`,
    [party.data.booking.booking_reference],
  );
  check('the database holds three rows under that one reference', partyRows.length === 3);

  const mineNow = await alice.request('/api/bookings/mine');
  check('the account now holds five seats across three bookings', mineNow.data.seat_count === 5,
    `seats ${mineNow.data.seat_count}, parties ${mineNow.data.bookings?.length}`);

  // All-or-nothing: one taken seat must fail the whole request.
  const takenMix = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_ids: [allSeats[6].id, allSeats[0].id] },
  });
  check(
    'a party containing one taken seat is refused entirely',
    takenMix.status === 409 && takenMix.data.error?.code === 'SEAT_TAKEN',
    JSON.stringify(takenMix.data),
  );
  const untouched = await db.queryOne('SELECT status FROM seats WHERE id = ?', [allSeats[6].id]);
  check('nothing was written for the seats that were free', untouched.status === 'AVAILABLE');

  // Release the extra seats so the capacity section below starts predictably.
  for (const ref of [second.data.booking.booking_reference, party.data.booking.booking_reference]) {
    await alice.request(`/api/bookings/mine/${ref}`, { method: 'DELETE' });
  }
  const afterCleanup = await alice.request('/api/bookings/mine');
  check('cancelling the extras leaves one seat', afterCleanup.data.seat_count === 1,
    String(afterCleanup.data.seat_count));

  const confirmationPage = await alice.request('/api/bookings/mine/confirmation');
  check('the printable confirmation renders', confirmationPage.status === 200);

  // -------------------------------------------------------------------------
  console.log('\nConcurrency: two people, one seat');
  const contenders = [];
  for (let i = 0; i < 2; i += 1) {
    const api = client();
    await api.primeCsrf();
    const data = person(`race${i}`);
    const result = await api.request('/api/auth/register', { method: 'POST', body: data });
    await verifyWhatsapp(db, api, result.data.user.id);
    contenders.push(api);
  }

  const contestedSeat = allSeats[5].id;
  const raceResults = await Promise.all(
    contenders.map((api) =>
      api.request('/api/bookings', { method: 'POST', body: { seat_id: contestedSeat } }),
    ),
  );
  const winners = raceResults.filter((r) => r.status === 201);
  const losers = raceResults.filter((r) => r.status !== 201);
  check('exactly one of two simultaneous requests wins', winners.length === 1,
    `won ${winners.length}: ${raceResults.map((r) => r.status).join(', ')}`);
  check(
    'the loser is told the seat was taken',
    losers.length === 1 && losers[0].data.error?.code === 'SEAT_TAKEN',
    JSON.stringify(losers[0]?.data),
  );

  const seatBookings = await db.queryOne(
    `SELECT COUNT(*) AS count FROM bookings
      WHERE seat_id = ? AND status IN ('PENDING','CONFIRMED')`,
    [contestedSeat],
  );
  check('the database holds exactly one live booking for that seat', Number(seatBookings.count) === 1);

  // -------------------------------------------------------------------------
  console.log('\nConcurrency: one person, two tabs');
  const doubleTabber = client();
  await doubleTabber.primeCsrf();
  const tabPerson = await doubleTabber.request('/api/auth/register', {
    method: 'POST',
    body: person('twotabs'),
  });
  await verifyWhatsapp(db, doubleTabber, tabPerson.data.user.id);

  const tabResults = await Promise.all([
    doubleTabber.request('/api/bookings', { method: 'POST', body: { seat_ids: [allSeats[8].id] } }),
    doubleTabber.request('/api/bookings', { method: 'POST', body: { seat_ids: [allSeats[9].id] } }),
  ]);
  // Both should now succeed: holding more than one seat is the point of the
  // change. What must still hold is that each seat is booked exactly once.
  check(
    'one account can take two different seats at the same moment',
    tabResults.filter((r) => r.status === 201).length === 2,
    tabResults.map((r) => `${r.status}:${r.data.error?.code ?? 'ok'}`).join(', '),
  );
  const bothSeats = await db.queryOne(
    `SELECT COUNT(*) AS c FROM bookings
      WHERE seat_id IN (?, ?) AND status IN ('PENDING','CONFIRMED')`,
    [allSeats[8].id, allSeats[9].id],
  );
  check('both seats hold exactly one booking each', Number(bothSeats.c) === 2, String(bothSeats.c));

  // The same seat twice at once must still collapse to one booking.
  const sameSeatTwice = await Promise.all([
    doubleTabber.request('/api/bookings', { method: 'POST', body: { seat_ids: [allSeats[10].id] } }),
    doubleTabber.request('/api/bookings', { method: 'POST', body: { seat_ids: [allSeats[10].id] } }),
  ]);
  check(
    'the same seat requested twice at once is booked once',
    sameSeatTwice.filter((r) => r.status === 201).length === 1,
    sameSeatTwice.map((r) => `${r.status}:${r.data.error?.code ?? 'ok'}`).join(', '),
  );

  // -------------------------------------------------------------------------
  console.log('\nCapacity ceiling of 10');
  const liveNow = await db.queryOne(
    `SELECT COUNT(*) AS count FROM bookings WHERE status IN ('PENDING','CONFIRMED')`,
  );
  let live = Number(liveNow.count);
  const freeSeats = await db.query(
    `SELECT id FROM seats WHERE status = 'AVAILABLE' ORDER BY id ASC`,
  );

  let hitCeiling = false;
  let ceilingCode = null;
  let index = 0;

  while (live < 12 && index < freeSeats.length) {
    const api = client();
    await api.primeCsrf();
    const created = await api.request('/api/auth/register', {
      method: 'POST',
      body: person(`cap${index}`),
    });
    await verifyWhatsapp(db, api, created.data.user.id);

    const attempt = await api.request('/api/bookings', {
      method: 'POST',
      body: { seat_id: freeSeats[index].id },
    });
    index += 1;

    if (attempt.status === 201) {
      live += 1;
    } else if (['FULLY_BOOKED', 'NOT_ENOUGH_CAPACITY'].includes(attempt.data.error?.code)) {
      hitCeiling = true;
      ceilingCode = attempt.data.error.code;
      break;
    } else if (attempt.data.error?.code === 'SEAT_TAKEN') {
      continue;
    } else {
      console.log(`      unexpected: ${attempt.status} ${JSON.stringify(attempt.data)}`);
      break;
    }
  }

  check('booking stops at the configured capacity', hitCeiling, `code was ${ceilingCode}`);
  check('exactly 10 live bookings exist', live === 10, `counted ${live}`);

  const publicState = await anon.request('/api/concert');
  check('the public page reports fully booked', publicState.data.availability?.fully_booked === true);
  check(
    'remaining capacity is zero',
    publicState.data.availability?.remaining_capacity === 0,
    String(publicState.data.availability?.remaining_capacity),
  );

  // -------------------------------------------------------------------------
  console.log('\nAdmin');
  const adminApi = client();
  await adminApi.primeCsrf();
  const adminLogin = await adminApi.request('/api/auth/admin/login', {
    method: 'POST',
    body: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  check('an admin can sign in', adminLogin.status === 200, JSON.stringify(adminLogin.data));

  const overview = await adminApi.request('/api/admin/overview');
  check('the overview loads', overview.status === 200);
  check(
    'the overview counts 10 booked seats',
    overview.data.stats?.booked_seats === 10,
    String(overview.data.stats?.booked_seats),
  );
  check(
    'the overview counts verified users',
    overview.data.stats?.whatsapp_verified_users >= 10,
    String(overview.data.stats?.whatsapp_verified_users),
  );

  const asUser = await alice.request('/api/admin/overview');
  check('an attendee session cannot reach the admin API', asUser.status === 401);

  const capacityTooLow = await adminApi.request('/api/admin/concert', {
    method: 'PATCH',
    body: { max_capacity: 3 },
  });
  check(
    'capacity cannot drop below the number already booked',
    capacityTooLow.status === 409 && capacityTooLow.data.error?.code === 'CAPACITY_BELOW_BOOKED',
  );

  const raised = await adminApi.request('/api/admin/concert', {
    method: 'PATCH',
    body: { max_capacity: 12 },
  });
  check('capacity can be raised', raised.status === 200);

  const reopened = await anon.request('/api/concert');
  check(
    'raising capacity reopens booking',
    reopened.data.availability?.fully_booked === false &&
      reopened.data.availability?.remaining_capacity === 2,
    JSON.stringify(reopened.data.availability),
  );

  // Admin cancels Alice's booking and the seat returns to the pool.
  const bookingList = await adminApi.request(`/api/admin/bookings?search=${reference}`);
  const target = bookingList.data.bookings?.[0];
  check('admin booking rows carry a seat id', Number.isInteger(target?.seat_id));
  check('admin search finds a booking by reference', target?.booking_reference === reference);

  const cancelled = await adminApi.request(`/api/admin/bookings/${target.id}`, {
    method: 'DELETE',
    body: { reason: 'Integration test' },
  });
  check('an admin can cancel a booking', cancelled.status === 200);

  const releasedSeat = await db.queryOne('SELECT status FROM seats WHERE id = ?', [target.seat_id]);
  check('cancelling returns the seat to AVAILABLE', releasedSeat.status === 'AVAILABLE');

  const cancelledRow = await db.queryOne(
    'SELECT status, active_key FROM bookings WHERE id = ?',
    [target.id],
  );
  check('the cancelled booking releases its unique slot', cancelledRow.active_key === null);

  // The same person can book again after a cancellation.
  const rebooked = await alice.request('/api/bookings', {
    method: 'POST',
    body: { seat_ids: [target.seat_id] },
  });
  check('the attendee can book again after cancellation', rebooked.status === 201, JSON.stringify(rebooked.data));

  // -------------------------------------------------------------------------
  console.log('\nSeat management');
  const sectionCreated = await adminApi.request('/api/admin/sections', {
    method: 'POST',
    body: { name: `Balcony ${stamp}`, display_order: 9 },
  });
  check('an admin can add a section', sectionCreated.status === 201);

  const bulk = await adminApi.request('/api/admin/seats/bulk', {
    method: 'POST',
    body: { section_id: sectionCreated.data.id, prefix: seatPrefix, from: 1, to: 6 },
  });
  check('an admin can generate a run of seats', bulk.status === 201 && bulk.data.created.length === 6);
  check('generated seats are zero-padded', bulk.data.created[0] === `${seatPrefix}01`, bulk.data.created[0]);

  const rerun = await adminApi.request('/api/admin/seats/bulk', {
    method: 'POST',
    body: { section_id: sectionCreated.data.id, prefix: seatPrefix, from: 1, to: 6 },
  });
  check('re-running the generator skips existing seats', rerun.data.skipped.length === 6);

  const adminSeats = await adminApi.request('/api/admin/seats');
  const zSeat = adminSeats.data.sections
    .flatMap((s) => s.seats)
    .find((seat) => seat.seat_number === `${seatPrefix}01`);

  const held = await adminApi.request(`/api/admin/seats/${zSeat.id}/reserve`, {
    method: 'POST',
    body: { note: 'Reserved for the choir director' },
  });
  check('an admin can hold a seat', held.status === 200);

  const heldBooking = client();
  await heldBooking.primeCsrf();
  const heldPerson = await heldBooking.request('/api/auth/register', {
    method: 'POST',
    body: person('heldseat'),
  });
  await verifyWhatsapp(db, heldBooking, heldPerson.data.user.id);
  const heldAttempt = await heldBooking.request('/api/bookings', {
    method: 'POST',
    body: { seat_id: zSeat.id },
  });
  check(
    'attendees cannot book a held seat',
    heldAttempt.status === 409 && heldAttempt.data.error?.code === 'SEAT_RESERVED',
    JSON.stringify(heldAttempt.data),
  );

  const disabledSeat = adminSeats.data.sections
    .flatMap((s) => s.seats)
    .find((seat) => seat.seat_number === `${seatPrefix}02`);
  const disableSeat = await adminApi.request(`/api/admin/seats/${disabledSeat.id}`, {
    method: 'PATCH',
    body: { status: 'DISABLED' },
  });
  check('an admin can switch a seat off', disableSeat.status === 200, JSON.stringify(disableSeat.data));
  const disabledRow = await db.queryOne('SELECT status FROM seats WHERE id = ?', [disabledSeat.id]);
  check('the seat reads DISABLED in the database', disabledRow.status === 'DISABLED', disabledRow.status);
  const disabledAttempt = await heldBooking.request('/api/bookings', {
    method: 'POST',
    body: { seat_id: disabledSeat.id },
  });
  check(
    'attendees cannot book a disabled seat',
    disabledAttempt.status === 409 && disabledAttempt.data.error?.code === 'SEAT_DISABLED',
    `${disabledAttempt.status} ${JSON.stringify(disabledAttempt.data)}`,
  );

  // -------------------------------------------------------------------------
  console.log('\nSeveral concerts at once');
  const concertList = await anon.request('/api/concerts');
  check('the public concert list returns more than one', concertList.data.concerts?.length >= 2,
    String(concertList.data.concerts?.length));
  check(
    'each concert carries its own availability',
    concertList.data.concerts.every((c) => Number.isInteger(c.availability?.max_capacity)),
  );

  const created = await adminApi.request('/api/admin/concerts', {
    method: 'POST',
    body: {
      name: `Easter Praise ${stamp}`,
      event_date: '2027-04-04',
      start_time: '17:00',
      venue: 'Grace Community Church',
      max_capacity: 8,
      booking_ref_prefix: 'EAS',
    },
  });
  check('an admin can create another concert', created.status === 201, JSON.stringify(created.data));
  const newConcertId = created.data.concert?.id;

  const duplicated = await adminApi.request(`/api/admin/concerts/1/duplicate`, {
    method: 'POST',
    body: { name: `Copied layout ${stamp}`, event_date: '2027-05-05' },
  });
  check('a concert layout can be duplicated', duplicated.status === 201, JSON.stringify(duplicated.data));
  const copyId = duplicated.data.concert?.id;
  const copiedSeats = await db.queryOne('SELECT COUNT(*) AS c FROM seats WHERE concert_id = ?', [copyId]);
  const sourceSeats = await db.queryOne('SELECT COUNT(*) AS c FROM seats WHERE concert_id = 1');
  check(
    'the copy has the same number of seats as the original',
    Number(copiedSeats.c) === Number(sourceSeats.c),
    `${copiedSeats.c} vs ${sourceSeats.c}`,
  );
  const copiedBookings = await db.queryOne(
    'SELECT COUNT(*) AS c FROM bookings WHERE concert_id = ?',
    [copyId],
  );
  check('the copy carries no bookings over', Number(copiedBookings.c) === 0);

  // The same person books at a second concert while still holding seats at the
  // first. A newly created concert has no seats yet, so use the seeded second
  // concert, which comes with its own layout and its own NYP prefix.
  const secondConcertSeats = await db.query(
    `SELECT id FROM seats WHERE concert_id = 2 AND status = 'AVAILABLE' ORDER BY id ASC LIMIT 2`,
  );
  check('the seeded second concert has its own seats', secondConcertSeats.length === 2);

  const crossBooking = await alice.request('/api/bookings', {
    method: 'POST',
    body: { concert_id: 2, seat_ids: secondConcertSeats.map((row) => row.id) },
  });
  check(
    'one person can hold seats at two concerts at once',
    crossBooking.status === 201,
    JSON.stringify(crossBooking.data),
  );
  check(
    'the second concert numbers references under its own prefix',
    String(crossBooking.data.booking?.booking_reference).startsWith('NYP-'),
    crossBooking.data.booking?.booking_reference,
  );
  check(
    'its numbering starts at one, independent of the other concert',
    String(crossBooking.data.booking?.booking_reference).endsWith('-00001'),
    crossBooking.data.booking?.booking_reference,
  );

  const across = await alice.request('/api/bookings/mine');
  const concertsHeld = new Set(across.data.bookings.map((b) => b.concert.id));
  check('the dashboard groups bookings by concert', concertsHeld.size === 2, String(concertsHeld.size));

  const perConcert = await alice.request('/api/bookings/mine?concert_id=2');
  check('bookings can be filtered to one concert', perConcert.data.bookings.length === 1);

  // A newly created concert starts with no seats, which is what makes the
  // duplicate action worth having.
  const emptySeats = await db.queryOne('SELECT COUNT(*) AS c FROM seats WHERE concert_id = ?', [
    newConcertId,
  ]);
  check('a new concert starts with no seats', Number(emptySeats.c) === 0);

  const deleteBusy = await adminApi.request('/api/admin/concerts/2', { method: 'DELETE' });
  check(
    'a concert with live bookings cannot be deleted',
    deleteBusy.status === 409 && deleteBusy.data.error?.code === 'CONCERT_HAS_BOOKINGS',
    JSON.stringify(deleteBusy.data),
  );

  const deleteEmpty = await adminApi.request(`/api/admin/concerts/${copyId}`, { method: 'DELETE' });
  check('an empty concert can be deleted', deleteEmpty.status === 200, JSON.stringify(deleteEmpty.data));

  // -------------------------------------------------------------------------
  console.log('\nCSV export');
  const usersCsv = await fetch(`${BASE}/api/admin/export/users.csv`, {
    headers: { Cookie: `cc_admin_session=${adminApi.jar.get('cc_admin_session')}` },
  });
  check('the users export returns CSV', usersCsv.headers.get('content-type')?.includes('text/csv'));
  check(
    'it is sent as a download with a filename',
    /attachment; filename="users-.*\.csv"/.test(usersCsv.headers.get('content-disposition') || ''),
    usersCsv.headers.get('content-disposition'),
  );
  const usersBody = await usersCsv.text();
  const usersLines = usersBody.trim().split('\r\n');
  check('the users export has a header row', usersLines[0].includes('"Full name"'));
  check('the users export lists every account', usersLines.length - 1 >= 10, String(usersLines.length - 1));
  check('it reports seats held per account', usersLines[0].includes('"Seats held"'));
  check(
    'phone numbers are protected against spreadsheet formula execution',
    usersBody.includes("\"'+91"),
    'a leading + would otherwise be read as a formula by Excel',
  );

  const bookingsCsv = await fetch(`${BASE}/api/admin/export/bookings.csv?concert_id=1`, {
    headers: { Cookie: `cc_admin_session=${adminApi.jar.get('cc_admin_session')}` },
  });
  const bookingsBody = await bookingsCsv.text();
  const bookingLines = bookingsBody.trim().split('\r\n');
  check('the bookings export returns rows', bookingLines.length > 1, String(bookingLines.length));
  check('it is ordered as a door list, seat first', bookingLines[0].startsWith('"Seat"'));
  check('it names the party size', bookingLines[0].includes('"Party size"'));
  check('it records the free admission', bookingLines[0].includes('"Booking fee"'));
  const liveSeats = await db.queryOne(
    `SELECT COUNT(*) AS c FROM bookings WHERE concert_id = 1 AND status IN ('PENDING','CONFIRMED')`,
  );
  check(
    'one row per live seat',
    bookingLines.length - 1 === Number(liveSeats.c),
    `${bookingLines.length - 1} rows vs ${liveSeats.c} seats`,
  );

  const exportAudit = await adminApi.request('/api/admin/audit-logs?per_page=100');
  const exportActions = new Set(exportAudit.data.logs.map((l) => l.action));
  check('exports are written to the audit trail', exportActions.has('EXPORT_USERS'));

  // -------------------------------------------------------------------------
  console.log('\nAudit trail and notifications');
  const logs = await adminApi.request('/api/admin/audit-logs?per_page=100');
  const actions = new Set(logs.data.logs.map((l) => l.action));
  check('bookings are audited', actions.has('BOOKING_CREATED'));
  check('admin cancellations are audited', actions.has('BOOKING_CANCELLED_BY_ADMIN'));
  check('underage attempts are audited', actions.has('REGISTRATION_REJECTED_UNDERAGE'));
  check('capacity changes are audited', actions.has('CONCERT_UPDATED'));

  const messages = await adminApi.request('/api/admin/notifications?per_page=100');
  const types = new Set(messages.data.notifications.map((n) => n.type));
  check('verification messages are logged', types.has('WHATSAPP_VERIFICATION'));
  check('booking confirmations are logged', types.has('BOOKING_CONFIRMATION'));
  check('cancellations are logged', types.has('BOOKING_CANCELLATION'));
  check(
    'no message is stuck queued',
    messages.data.notifications.every((n) => n.status !== 'QUEUED'),
  );

  // -------------------------------------------------------------------------
  console.log('\nAccount disabling');
  const holder = await db.queryOne(
    `SELECT u.id, u.email, u.full_name FROM users u
       JOIN bookings b ON b.user_id = u.id AND b.status IN ('PENDING','CONFIRMED')
      WHERE u.is_active = 1 LIMIT 1`,
  );
  check('a user holding a seat was found to disable', Boolean(holder));
  await adminApi.request(`/api/admin/users/${holder.id}`, {
    method: 'PATCH',
    body: { is_active: false, disabled_reason: 'Integration test' },
  });
  const loginBlocked = client();
  await loginBlocked.primeCsrf();
  const blocked = await loginBlocked.request('/api/auth/login', {
    method: 'POST',
    body: { identifier: holder.email, password: 'ConcertSeat2026x' },
  });
  check(
    'a disabled account cannot sign in',
    blocked.status === 403 && blocked.data.error?.code === 'ACCOUNT_DISABLED',
    JSON.stringify(blocked.data),
  );

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  await db.pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nThe test run itself failed:', err);
  process.exit(1);
});
