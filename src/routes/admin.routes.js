'use strict';

const express = require('express');
const db = require('../db');
const env = require('../env');
const bookingService = require('../services/booking');
const notifications = require('../services/notifications');
const feed = require('../services/console-feed');
const emailService = require('../services/email');
const { renderTicket } = require('../lib/ticket');
const fs = require('fs/promises');
const path = require('path');
const { audit, getSettings, setSettings } = require('../lib/audit');
const {
  asyncRoute,
  badRequest,
  notFound,
  conflict,
  ageOn,
  maskPhone,
  randomToken,
} = require('../lib/helpers');
const schemas = require('../lib/schemas');
const { parse } = schemas;
const auth = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires an admin session.
router.use(auth.requireAdmin);

/**
 * Which concert an admin request is about.
 *
 * Several concerts can run at once now, so nothing may assume "the" concert.
 * `?concert_id=` or a `concert_id` in the body picks one; without either, the
 * next upcoming concert is used, which is what the dashboard opens on.
 */
const resolveConcert = (req) => {
  const raw = req.query.concert_id ?? req.body?.concert_id;
  return raw ? bookingService.getConcert(Number(raw)) : bookingService.getDefaultConcert();
};

/**
 * Paging, and the LIMIT clause to go with it.
 *
 * `limit` is interpolated into the SQL rather than bound as `LIMIT ? OFFSET ?`.
 * That is not an oversight: db.query uses pool.execute(), i.e. real prepared
 * statements, and MySQL rejects placeholders in LIMIT there — every paginated
 * endpoint failed with "Incorrect arguments to mysqld_stmt_execute" (errno
 * 1210) while the unpaginated ones were fine.
 *
 * Interpolating is safe *because of the two lines above it*: both numbers come
 * out of Number.parseInt and are then clamped, so they can only ever be
 * integers in [1, ∞) and [5, 100]. Nothing a caller sends survives into the
 * string. Building the clause here rather than at each call site is the point —
 * it keeps that guarantee in one place instead of five.
 */
const pageParams = (req, defaultSize = 25) => {
  // The upper clamp on `page` is what keeps `offset` a plain integer. Without
  // it, ?page=99999999999999999999 makes offset exceed MAX_SAFE_INTEGER, which
  // stringifies as "1e+22" and lands in the SQL as a syntax error — a 500 any
  // caller could trigger at will. A million pages is far past anything real.
  const page = Math.min(1_000_000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const size = Math.min(100, Math.max(5, Number.parseInt(req.query.per_page, 10) || defaultSize));
  const offset = (page - 1) * size;
  return { page, size, offset, limit: `LIMIT ${size} OFFSET ${offset}` };
};

router.get(
  '/me',
  asyncRoute(async (req, res) => {
    res.json({
      admin: {
        id: req.admin.id,
        full_name: req.admin.full_name,
        email: req.admin.email,
        role: req.admin.role,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const concert = await resolveConcert(req);
    const stats = await bookingService.getStats(concert.id);

    const recentBookings = await db.query(
      `SELECT b.id, b.booking_reference, b.status, b.created_at, s.seat_number, u.full_name
         FROM bookings b
         JOIN seats s ON s.id = b.seat_id
         JOIN users u ON u.id = b.user_id
        WHERE b.concert_id = ?
        ORDER BY b.id DESC LIMIT 8`,
      [concert.id],
    );

    const failedNotifications = await db.queryOne(
      `SELECT COUNT(*) AS count FROM notifications WHERE status = 'FAILED'`,
    );

    res.json({
      concert: {
        id: concert.id,
        name: concert.name,
        event_date: concert.event_date,
        start_time: concert.start_time,
        venue: concert.venue,
      },
      stats,
      recent_bookings: recentBookings,
      failed_notifications: Number(failedNotifications.count),
    });
  }),
);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get(
  '/users',
  asyncRoute(async (req, res) => {
    const { page, size, limit } = pageParams(req);
    const where = [];
    const params = [];

    if (req.query.search) {
      const term = `%${String(req.query.search).trim()}%`;
      where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.mobile_number LIKE ? OR u.whatsapp_number LIKE ?)');
      params.push(term, term, term, term);
    }
    if (req.query.status === 'active') where.push('u.is_active = 1');
    if (req.query.status === 'disabled') where.push('u.is_active = 0');
    // Both spellings are accepted. The console sends true/false; the older UI
    // sent yes/no, and a filter that quietly does nothing is worse than either.
    const yes = (value) => value === 'yes' || value === 'true';
    const no = (value) => value === 'no' || value === 'false';
    if (yes(req.query.verified)) where.push('u.whatsapp_verified = 1');
    if (no(req.query.verified)) where.push('u.whatsapp_verified = 0');

    // Seats held is a correlated count, not a join.
    //
    // The join this replaces produced one row per seat: somebody holding four
    // seats appeared four times, the page showed fewer than `per_page` distinct
    // people, and `total` counted seat rows rather than accounts — so the pager
    // reported a number that could never be reached.
    const heldSeats = `(SELECT COUNT(*) FROM bookings b
                         WHERE b.user_id = u.id AND b.status IN ${bookingService.ACTIVE})`;
    if (yes(req.query.booked)) where.push(`${heldSeats} > 0`);
    if (no(req.query.booked)) where.push(`${heldSeats} = 0`);

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.query(
      `SELECT u.id, u.full_name, u.email, u.mobile_number, u.whatsapp_number, u.date_of_birth,
              u.gender, u.whatsapp_verified, u.is_active, u.created_at, u.last_login_at,
              ${heldSeats} AS live_seats,
              (SELECT COUNT(DISTINCT b.booking_reference) FROM bookings b
                WHERE b.user_id = u.id AND b.status IN ${bookingService.ACTIVE}) AS live_bookings
         FROM users u
         ${clause}
         ORDER BY u.id DESC
         ${limit}`,
      params,
    );

    const total = await db.queryOne(
      `SELECT COUNT(*) AS count FROM users u ${clause}`,
      params,
    );

    res.json({
      users: rows.map((u) => ({
        ...u,
        age: ageOn(u.date_of_birth),
        live_seats: Number(u.live_seats),
        live_bookings: Number(u.live_bookings),
      })),
      pagination: { page, per_page: size, total: Number(total.count) },
    });
  }),
);

router.get(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) throw notFound('User not found.');
    delete user.password_hash;

    const bookings = await db.query(
      `SELECT b.id, b.booking_reference, b.status, b.created_at, b.cancelled_at, b.cancel_reason,
              s.seat_number
         FROM bookings b JOIN seats s ON s.id = b.seat_id
        WHERE b.user_id = ? ORDER BY b.id DESC`,
      [req.params.id],
    );

    const messages = await db.query(
      `SELECT id, type, status, failure_reason, sent_at, created_at
         FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
      [req.params.id],
    );

    const verifications = await db.query(
      `SELECT id, phone_e164, attempts, expires_at, consumed_at, created_at
         FROM whatsapp_verifications WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
      [req.params.id],
    );

    res.json({
      user: { ...user, age: ageOn(user.date_of_birth) },
      bookings,
      notifications: messages,
      whatsapp_verifications: verifications,
    });
  }),
);

router.patch(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.adminUserUpdateSchema, req.body);
    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) throw notFound('User not found.');

    const updates = [];
    const params = [];

    if (data.is_active !== undefined) {
      updates.push('is_active = ?', 'disabled_reason = ?', 'token_version = token_version + 1');
      params.push(data.is_active ? 1 : 0, data.is_active ? null : (data.disabled_reason ?? null));
    }
    if (data.whatsapp_verified !== undefined) {
      updates.push('whatsapp_verified = ?', 'whatsapp_verified_at = ?');
      params.push(data.whatsapp_verified ? 1 : 0, data.whatsapp_verified ? new Date() : null);
    }

    params.push(req.params.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    await audit(req, {
      action: data.is_active === false ? 'USER_DISABLED' : 'USER_UPDATED',
      entityType: 'USER',
      entityId: req.params.id,
      metadata: data,
    });

    const updated = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    delete updated.password_hash;
    res.json({ user: updated });
  }),
);

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
router.get(
  '/bookings',
  asyncRoute(async (req, res) => {
    const { page, size, limit } = pageParams(req);
    const where = [];
    const params = [];

    if (req.query.search) {
      const term = `%${String(req.query.search).trim()}%`;
      where.push('(b.booking_reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR s.seat_number LIKE ?)');
      params.push(term, term, term, term);
    }
    if (req.query.status) {
      where.push('b.status = ?');
      params.push(String(req.query.status).toUpperCase());
    }
    // Filtering by concert belongs here rather than in the browser: doing it on
    // the page silently drops rows out of an already-paginated result, so the
    // count under the table stops matching what is in it.
    if (req.query.concert_id) {
      where.push('b.concert_id = ?');
      params.push(Number(req.query.concert_id));
    }
    if (req.query.verified === 'true') where.push('u.whatsapp_verified = 1');
    if (req.query.verified === 'false') where.push('u.whatsapp_verified = 0');

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.query(
      `SELECT b.id, b.booking_reference, b.status, b.source, b.created_at, b.confirmed_at,
              b.cancelled_at, b.cancelled_by, b.cancel_reason, b.note,
              b.concert_id, c.name AS concert_name,
              s.id AS seat_id, s.seat_number, sec.name AS section_name,
              u.id AS user_id, u.full_name, u.email, u.whatsapp_number, u.whatsapp_verified
         FROM bookings b
         JOIN seats s ON s.id = b.seat_id
         JOIN sections sec ON sec.id = s.section_id
         JOIN users u ON u.id = b.user_id
         JOIN concerts c ON c.id = b.concert_id
         ${clause}
         ORDER BY b.id DESC ${limit}`,
      params,
    );

    const total = await db.queryOne(
      `SELECT COUNT(*) AS count FROM bookings b
         JOIN seats s ON s.id = b.seat_id
         JOIN users u ON u.id = b.user_id
         ${clause}`,
      params,
    );

    res.json({ bookings: rows, pagination: { page, per_page: size, total: Number(total.count) } });
  }),
);

router.post(
  '/bookings',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.adminBookingCreateSchema, req.body);

    const concert = data.concert_id
      ? await bookingService.getConcert(data.concert_id)
      : await resolveConcert(req);

    const result = await bookingService.createBooking({
      userId: data.user_id,
      concertId: concert.id,
      seatIds: data.seat_ids,
      source: 'ADMIN',
      adminId: req.admin.id,
      note: data.note ?? 'Created by admin',
    });

    const seatNumbers = result.seats.map((seat) => seat.seat_number);

    await audit(req, {
      action: 'BOOKING_CREATED_BY_ADMIN',
      entityType: 'BOOKING',
      entityId: result.bookings[0].id,
      metadata: {
        user_id: data.user_id,
        concert_id: concert.id,
        seats: seatNumbers,
        reference: result.reference,
      },
    });

    notifications
      .sendBookingConfirmation(result.user, result.concert, seatNumbers, result.reference)
      .catch(() => {});

    feed.bookingCreated({
      reference: result.reference,
      userName: result.user.full_name,
      seatNumbers,
      concertId: result.concert.id,
      bookingId: result.bookings[0].id,
      byStaff: true,
    });

    res.status(201).json({
      booking: {
        booking_reference: result.reference,
        seat_numbers: seatNumbers,
        seat_number: seatNumbers.join(', '),
        seat_count: seatNumbers.length,
        status: 'CONFIRMED',
        concert: { id: result.concert.id, name: result.concert.name },
      },
      message: `${seatNumbers.length === 1 ? `Seat ${seatNumbers[0]}` : `${seatNumbers.length} seats`} booked for ${result.user.full_name} under ${result.reference}.`,
    });
  }),
);

router.patch(
  '/bookings/:id',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.adminBookingUpdateSchema, req.body);

    const result = await bookingService.reassignSeat({
      bookingId: req.params.id,
      newSeatId: data.seat_id,
      adminId: req.admin.id,
      note: data.note ?? null,
    });

    await audit(req, {
      action: 'BOOKING_SEAT_REASSIGNED',
      entityType: 'BOOKING',
      entityId: req.params.id,
      metadata: { from: result.oldSeat, to: result.newSeat },
    });

    notifications
      .sendSeatReassignment(
        result.user,
        result.concert,
        result.oldSeat,
        result.newSeat,
        result.booking.booking_reference,
      )
      .catch(() => {});

    res.json({
      ok: true,
      from: result.oldSeat,
      to: result.newSeat,
      message: `Moved ${result.booking.booking_reference} from ${result.oldSeat} to ${result.newSeat}.`,
    });
  }),
);

router.delete(
  '/bookings/:id',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.cancelBookingSchema, req.body ?? {});

    const result = await bookingService.cancelBooking({
      bookingId: req.params.id,
      cancelledBy: `ADMIN:${req.admin.id}`,
      reason: data.reason ?? 'Cancelled by admin',
    });

    await audit(req, {
      action: 'BOOKING_CANCELLED_BY_ADMIN',
      entityType: 'BOOKING',
      entityId: req.params.id,
      metadata: { seat: result.seatNumber, reason: data.reason ?? null },
    });

    if (result.user) {
      notifications
        .sendBookingCancellation(
          result.user,
          result.concert,
          result.seatNumber,
          result.booking.booking_reference,
        )
        .catch(() => {});
    }

    res.json({ ok: true, message: `Booking cancelled and seat ${result.seatNumber} released.` });
  }),
);

// ---------------------------------------------------------------------------
// Sections and seats
// ---------------------------------------------------------------------------
router.get(
  '/seats',
  asyncRoute(async (req, res) => {
    const concert = await resolveConcert(req);
    const [sections, stats] = await Promise.all([
      bookingService.getSeatMap(concert.id, { includeOccupant: true }),
      bookingService.getStats(concert.id),
    ]);
    res.json({ concert_id: concert.id, sections, stats });
  }),
);

router.post(
  '/sections',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.sectionSchema, req.body);
    const concert = await resolveConcert(req);
    try {
      const result = await db.query(
        'INSERT INTO sections (concert_id, name, display_order) VALUES (?, ?, ?)',
        [concert.id, data.name, data.display_order ?? 0],
      );
      await audit(req, {
        action: 'SECTION_CREATED',
        entityType: 'SECTION',
        entityId: result.insertId,
        metadata: data,
      });
      res.status(201).json({ id: result.insertId, ...data });
    } catch (err) {
      if (db.isDuplicateKey(err)) throw conflict('A section with that name already exists.');
      throw err;
    }
  }),
);

router.patch(
  '/sections/:id',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.sectionSchema.partial(), req.body);
    if (!Object.keys(data).length) throw badRequest('Nothing to update.');
    const updates = Object.keys(data).map((k) => `${k} = ?`);
    await db.query(`UPDATE sections SET ${updates.join(', ')} WHERE id = ?`, [
      ...Object.values(data),
      req.params.id,
    ]);
    await audit(req, {
      action: 'SECTION_UPDATED',
      entityType: 'SECTION',
      entityId: req.params.id,
      metadata: data,
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/sections/:id',
  asyncRoute(async (req, res) => {
    const held = await db.queryOne(
      `SELECT COUNT(*) AS count FROM bookings b JOIN seats s ON s.id = b.seat_id
        WHERE s.section_id = ? AND b.status IN ${bookingService.ACTIVE}`,
      [req.params.id],
    );
    if (Number(held.count) > 0) {
      throw conflict(
        'That section has live bookings. Cancel or move them before deleting it.',
        'SECTION_IN_USE',
      );
    }
    await db.query('DELETE FROM sections WHERE id = ?', [req.params.id]);
    await audit(req, { action: 'SECTION_DELETED', entityType: 'SECTION', entityId: req.params.id });
    res.json({ ok: true });
  }),
);

router.post(
  '/seats',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.seatSchema, req.body);
    const concert = await resolveConcert(req);
    try {
      const result = await db.query(
        `INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order, status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          concert.id,
          data.section_id,
          data.seat_number,
          data.row_label ?? null,
          data.display_order ?? 0,
          data.status ?? 'AVAILABLE',
          data.note ?? null,
        ],
      );
      await audit(req, {
        action: 'SEAT_CREATED',
        entityType: 'SEAT',
        entityId: result.insertId,
        metadata: data,
      });
      res.status(201).json({ id: result.insertId, ...data });
    } catch (err) {
      if (db.isDuplicateKey(err)) throw conflict(`Seat ${data.seat_number} already exists.`);
      throw err;
    }
  }),
);

/** Generate a run of seats, e.g. prefix A, 1 to 10 -> A01 ... A10. */
router.post(
  '/seats/bulk',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.bulkSeatSchema, req.body);
    if (data.to < data.from) throw badRequest('The last number must be at or above the first.');
    if (data.to - data.from > 499) throw badRequest('Create at most 500 seats at a time.');

    const concert = await resolveConcert(req);
    const pad = data.pad ?? 2;

    const created = [];
    const skipped = [];
    for (let n = data.from; n <= data.to; n += 1) {
      const seatNumber = `${data.prefix}${String(n).padStart(pad, '0')}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await db.query(
          `INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order)
           VALUES (?, ?, ?, ?, ?)`,
          [concert.id, data.section_id, seatNumber, data.row_label ?? (data.prefix || null), n],
        );
        created.push(seatNumber);
      } catch (err) {
        if (db.isDuplicateKey(err)) skipped.push(seatNumber);
        else throw err;
      }
    }

    await audit(req, {
      action: 'SEATS_BULK_CREATED',
      entityType: 'SECTION',
      entityId: data.section_id,
      metadata: { created: created.length, skipped: skipped.length, prefix: data.prefix },
    });

    res.status(201).json({
      created,
      skipped,
      message: `Added ${created.length} seats${skipped.length ? `, skipped ${skipped.length} that already existed` : ''}.`,
    });
  }),
);

router.patch(
  '/seats/:id',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.seatUpdateSchema, req.body);
    const seat = await db.queryOne('SELECT * FROM seats WHERE id = ?', [req.params.id]);
    if (!seat) throw notFound('Seat not found.');

    const live = await db.queryOne(
      `SELECT id FROM bookings WHERE seat_id = ? AND status IN ${bookingService.ACTIVE} LIMIT 1`,
      [seat.id],
    );
    if (live && (data.status || data.section_id)) {
      throw conflict(
        'That seat has a live booking. Cancel or move the booking first.',
        'SEAT_IN_USE',
      );
    }

    const updates = [];
    const params = [];
    for (const [key, value] of Object.entries(data)) {
      updates.push(`${key} = ?`);
      params.push(value);
    }
    params.push(req.params.id);
    await db.query(`UPDATE seats SET ${updates.join(', ')} WHERE id = ?`, params);

    await audit(req, {
      action: 'SEAT_UPDATED',
      entityType: 'SEAT',
      entityId: req.params.id,
      metadata: { from: { status: seat.status }, to: data },
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/seats/:id',
  asyncRoute(async (req, res) => {
    const live = await db.queryOne(
      `SELECT id FROM bookings WHERE seat_id = ? AND status IN ${bookingService.ACTIVE} LIMIT 1`,
      [req.params.id],
    );
    if (live) throw conflict('That seat has a live booking. Cancel it first.', 'SEAT_IN_USE');

    const anyBooking = await db.queryOne('SELECT id FROM bookings WHERE seat_id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (anyBooking) {
      // Cancelled bookings reference the seat for the audit trail, so disable
      // rather than delete to keep history intact.
      await db.query(`UPDATE seats SET status = 'DISABLED' WHERE id = ?`, [req.params.id]);
      await audit(req, { action: 'SEAT_DISABLED', entityType: 'SEAT', entityId: req.params.id });
      return res.json({
        ok: true,
        disabled_instead: true,
        message: 'That seat has past bookings, so it was disabled instead of deleted.',
      });
    }

    await db.query('DELETE FROM seats WHERE id = ?', [req.params.id]);
    await audit(req, { action: 'SEAT_DELETED', entityType: 'SEAT', entityId: req.params.id });
    return res.json({ ok: true });
  }),
);

/** Hold a seat for the office. */
router.post(
  '/seats/:id/reserve',
  asyncRoute(async (req, res) => {
    const note = String(req.body?.note ?? '').slice(0, 255) || 'Held by the church office';
    const seat = await db.queryOne('SELECT * FROM seats WHERE id = ?', [req.params.id]);
    if (!seat) throw notFound('Seat not found.');
    if (seat.status === 'BOOKED') throw conflict('That seat is booked. Cancel the booking first.');

    await db.query(`UPDATE seats SET status = 'RESERVED', note = ? WHERE id = ?`, [note, seat.id]);
    await audit(req, {
      action: 'SEAT_RESERVED',
      entityType: 'SEAT',
      entityId: seat.id,
      metadata: { note },
    });
    res.json({ ok: true, message: `Seat ${seat.seat_number} is now held.` });
  }),
);

/** Return a seat to the pool, cancelling any live booking on it. */
router.post(
  '/seats/:id/release',
  asyncRoute(async (req, res) => {
    const seat = await db.queryOne('SELECT * FROM seats WHERE id = ?', [req.params.id]);
    if (!seat) throw notFound('Seat not found.');

    const live = await db.queryOne(
      `SELECT id FROM bookings WHERE seat_id = ? AND status IN ${bookingService.ACTIVE} LIMIT 1`,
      [seat.id],
    );

    if (live) {
      const result = await bookingService.cancelBooking({
        bookingId: live.id,
        cancelledBy: `ADMIN:${req.admin.id}`,
        reason: 'Seat released by admin',
      });
      if (result.user) {
        notifications
          .sendBookingCancellation(
            result.user,
            result.concert,
            result.seatNumber,
            result.booking.booking_reference,
          )
          .catch(() => {});
      }
    } else {
      await db.query(`UPDATE seats SET status = 'AVAILABLE', note = NULL WHERE id = ?`, [seat.id]);
    }

    await audit(req, {
      action: 'SEAT_RELEASED',
      entityType: 'SEAT',
      entityId: seat.id,
      metadata: { cancelled_booking_id: live?.id ?? null },
    });
    res.json({ ok: true, message: `Seat ${seat.seat_number} is available again.` });
  }),
);

// ---------------------------------------------------------------------------
// Concerts: several may run at once, each with its own seats and capacity
// ---------------------------------------------------------------------------

/** Every concert, active or not, each with its own availability. */
router.get(
  '/concerts',
  asyncRoute(async (req, res) => {
    const list = await bookingService.listConcerts({ activeOnly: false });
    res.json({
      concerts: list.map(({ concert, availability }) => ({ ...concert, availability })),
    });
  }),
);

router.post(
  '/concerts',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.concertCreateSchema, req.body);

    const columns = Object.keys(data);
    const result = await db.query(
      `INSERT INTO concerts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((key) => (data[key] === '' ? null : data[key])),
    );

    await audit(req, {
      action: 'CONCERT_CREATED',
      entityType: 'CONCERT',
      entityId: result.insertId,
      metadata: data,
    });

    const concert = await bookingService.getConcert(result.insertId);
    res.status(201).json({
      concert,
      message: `"${concert.name}" created. Add sections and seats to it next.`,
    });
  }),
);

/**
 * Copy a concert's seat layout onto a new date. Building the same 200-seat plan
 * by hand for every event in a season is the kind of thing people give up on,
 * so duplicating is a first-class action.
 */
router.post(
  '/concerts/:id/duplicate',
  asyncRoute(async (req, res) => {
    const source = await bookingService.getConcert(Number(req.params.id));
    const data = parse(schemas.concertCreateSchema, {
      name: req.body.name ?? `${source.name} (copy)`,
      event_date: req.body.event_date ?? source.event_date,
      start_time: req.body.start_time ?? source.start_time,
      venue: req.body.venue ?? source.venue,
    });

    const created = await db.transaction(async (conn) => {
      const [result] = await conn.execute(
        `INSERT INTO concerts
           (name, description, event_date, start_time, end_time, venue, address,
            max_capacity, max_seats_per_booking, booking_ref_prefix, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          data.name,
          source.description,
          data.event_date,
          data.start_time,
          source.end_time,
          data.venue,
          source.address,
          source.max_capacity,
          source.max_seats_per_booking,
          req.body.booking_ref_prefix ?? source.booking_ref_prefix,
        ],
      );
      const newId = result.insertId;

      // Sections first, so seats can be pointed at the new section ids.
      const [sections] = await conn.execute(
        'SELECT id, name, display_order FROM sections WHERE concert_id = ? ORDER BY id ASC',
        [source.id],
      );
      const sectionMap = new Map();
      for (const section of sections) {
        const [inserted] = await conn.execute(
          'INSERT INTO sections (concert_id, name, display_order) VALUES (?, ?, ?)',
          [newId, section.name, section.display_order],
        );
        sectionMap.set(section.id, inserted.insertId);
      }

      // Seats are copied as AVAILABLE: the layout carries over, bookings do not.
      const [seats] = await conn.execute(
        `SELECT section_id, seat_number, row_label, display_order FROM seats
          WHERE concert_id = ? ORDER BY id ASC`,
        [source.id],
      );
      for (const seat of seats) {
        await conn.execute(
          `INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order, status)
           VALUES (?, ?, ?, ?, ?, 'AVAILABLE')`,
          [newId, sectionMap.get(seat.section_id), seat.seat_number, seat.row_label, seat.display_order],
        );
      }

      return { id: newId, sections: sections.length, seats: seats.length };
    });

    await audit(req, {
      action: 'CONCERT_DUPLICATED',
      entityType: 'CONCERT',
      entityId: created.id,
      metadata: { copied_from: source.id, sections: created.sections, seats: created.seats },
    });

    const concert = await bookingService.getConcert(created.id);
    res.status(201).json({
      concert,
      message: `Copied ${created.seats} seats in ${created.sections} section(s) from "${source.name}".`,
    });
  }),
);

/** One concert with its stats. `/concert` (singular) is kept for older clients. */
for (const path of ['/concerts/:id', '/concert']) {
  router.get(
    path,
    asyncRoute(async (req, res) => {
      const concert = req.params.id
        ? await bookingService.getConcert(Number(req.params.id))
        : await resolveConcert(req);
      const stats = await bookingService.getStats(concert.id);
      res.json({ concert, stats });
    }),
  );
}

const updateConcert = asyncRoute(async (req, res) => {
  const data = parse(schemas.concertSchema, req.body);
  if (!Object.keys(data).length) throw badRequest('Nothing to update.');

  const concert = req.params.id
    ? await bookingService.getConcert(Number(req.params.id))
    : await resolveConcert(req);

  // Capacity can rise freely, but it must never drop below the number of seats
  // already taken, or the overview would show a negative remainder.
  if (data.max_capacity !== undefined) {
    const stats = await bookingService.getStats(concert.id);
    if (data.max_capacity < stats.booked_seats) {
      throw conflict(
        `${stats.booked_seats} seats are already booked for "${concert.name}". Set capacity to ${stats.booked_seats} or higher, or cancel bookings first.`,
        'CAPACITY_BELOW_BOOKED',
      );
    }
  }

  const updates = [];
  const params = [];
  for (const [key, value] of Object.entries(data)) {
    updates.push(`${key} = ?`);
    params.push(value === '' ? null : value);
  }
  params.push(concert.id);
  await db.query(`UPDATE concerts SET ${updates.join(', ')} WHERE id = ?`, params);

  await audit(req, {
    action: 'CONCERT_UPDATED',
    entityType: 'CONCERT',
    entityId: concert.id,
    metadata: data,
  });

  const updated = await bookingService.getConcert(concert.id);
  res.json({ concert: updated, message: `"${updated.name}" saved.` });
});

router.patch('/concerts/:id', updateConcert);
router.patch('/concert', updateConcert);

/**
 * Delete a concert. Refused while anyone holds a seat: cascading the delete
 * would wipe those bookings silently and nobody would be told they had lost a
 * seat. Deactivating hides it from attendees without destroying the record.
 */
router.delete(
  '/concerts/:id',
  auth.requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const concert = await bookingService.getConcert(Number(req.params.id));
    const live = await db.queryOne(
      `SELECT COUNT(*) AS count FROM bookings
        WHERE concert_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [concert.id],
    );
    if (Number(live.count) > 0) {
      throw conflict(
        `${live.count} seats are booked for "${concert.name}". Cancel those bookings first, or switch the concert off instead of deleting it.`,
        'CONCERT_HAS_BOOKINGS',
      );
    }

    await db.query('DELETE FROM concerts WHERE id = ?', [concert.id]);
    await db.query('DELETE FROM counters WHERE name = ?', [`booking_reference:${concert.id}`]);

    await audit(req, {
      action: 'CONCERT_DELETED',
      entityType: 'CONCERT',
      entityId: concert.id,
      metadata: { name: concert.name },
    });

    res.json({ ok: true, message: `"${concert.name}" deleted.` });
  }),
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * One CSV field.
 *
 * Fields are always quoted and inner quotes doubled, per RFC 4180, so a comma
 * in an address or a quote in a name cannot shift the columns.
 *
 * The leading apostrophe on anything starting with = + - @ is deliberate:
 * without it, Excel and Sheets treat the cell as a formula. A phone number
 * beginning "+91..." is the common case, and a field like
 * `=HYPERLINK(...)` in a name would otherwise execute on open. This is CSV
 * injection, and quoting alone does not prevent it.
 */
const csvCell = (value) => {
  if (value === null || value === undefined) return '""';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';

/** Send a CSV as a download named after the concert and today's date. */
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // A BOM so Excel opens UTF-8 names correctly instead of mangling accents.
  res.write('\uFEFF');
  res.write(csvRow(header));
  for (const row of rows) res.write(csvRow(row));
  res.end();
}

const slug = (text) =>
  String(text || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Every registered account as CSV, with what they hold.
 * `?concert_id=` narrows the seat columns to one concert.
 */
router.get(
  '/export/users.csv',
  asyncRoute(async (req, res) => {
    const concertId = req.query.concert_id ? Number(req.query.concert_id) : null;
    const params = [];
    let seatJoin = '';

    if (concertId) {
      seatJoin = `AND b.concert_id = ?`;
      params.push(concertId);
    }

    const users = await db.query(
      `SELECT u.id, u.full_name, u.email, u.mobile_number, u.whatsapp_number,
              u.whatsapp_verified, u.date_of_birth, u.gender, u.address,
              u.emergency_contact, u.is_active, u.disabled_reason,
              u.terms_accepted_at, u.created_at, u.last_login_at,
              COUNT(b.id) AS seats_held,
              GROUP_CONCAT(DISTINCT s.seat_number ORDER BY s.seat_number SEPARATOR ' ') AS seat_numbers,
              GROUP_CONCAT(DISTINCT b.booking_reference ORDER BY b.booking_reference SEPARATOR ' ') AS refs
         FROM users u
         LEFT JOIN bookings b
                ON b.user_id = u.id AND b.status IN ('PENDING','CONFIRMED') ${seatJoin}
         LEFT JOIN seats s ON s.id = b.seat_id
        GROUP BY u.id
        ORDER BY u.id ASC`,
      params,
    );

    await audit(req, {
      action: 'EXPORT_USERS',
      entityType: 'USER',
      metadata: { rows: users.length, concert_id: concertId },
    });

    const label = concertId ? slug((await bookingService.getConcert(concertId)).name) : 'all';

    sendCsv(
      res,
      `users-${label}-${today()}.csv`,
      [
        'User ID', 'Full name', 'Email', 'Mobile', 'WhatsApp', 'WhatsApp verified',
        'Date of birth', 'Age', 'Gender', 'Address', 'Emergency contact',
        'Account status', 'Disabled reason', 'Seats held', 'Seat numbers',
        'Booking references', 'Terms accepted', 'Registered', 'Last sign-in',
      ],
      users.map((u) => [
        u.id,
        u.full_name,
        u.email,
        u.mobile_number,
        u.whatsapp_number,
        u.whatsapp_verified ? 'Yes' : 'No',
        u.date_of_birth,
        ageOn(u.date_of_birth),
        String(u.gender || '').replace(/_/g, ' ').toLowerCase(),
        u.address,
        u.emergency_contact,
        u.is_active ? 'Active' : 'Disabled',
        u.disabled_reason,
        Number(u.seats_held),
        u.seat_numbers,
        u.refs,
        u.terms_accepted_at,
        u.created_at,
        u.last_login_at,
      ]),
    );
  }),
);

/**
 * Bookings as CSV, one row per seat so the file can be sorted by seat number
 * and used as a door list. `?concert_id=` narrows it; `?status=` defaults to
 * live bookings only, since that is what a door list needs.
 */
router.get(
  '/export/bookings.csv',
  asyncRoute(async (req, res) => {
    const where = [];
    const params = [];

    if (req.query.concert_id) {
      where.push('b.concert_id = ?');
      params.push(Number(req.query.concert_id));
    }

    const status = String(req.query.status || 'live').toLowerCase();
    if (status === 'live') {
      where.push("b.status IN ('PENDING','CONFIRMED')");
    } else if (status !== 'all') {
      where.push('b.status = ?');
      params.push(status.toUpperCase());
    }

    const rows = await db.query(
      `SELECT b.booking_reference, b.status, b.source, b.created_at, b.confirmed_at,
              b.cancelled_at, b.cancelled_by, b.cancel_reason, b.note,
              s.seat_number, sec.name AS section_name,
              c.name AS concert_name, c.event_date, c.start_time, c.venue,
              u.id AS user_id, u.full_name, u.email, u.mobile_number,
              u.whatsapp_number, u.whatsapp_verified, u.emergency_contact,
              a.full_name AS booked_by_admin,
              (SELECT COUNT(*) FROM bookings x
                WHERE x.booking_reference = b.booking_reference
                  AND x.status IN ('PENDING','CONFIRMED')) AS party_size
         FROM bookings b
         JOIN seats s ON s.id = b.seat_id
         JOIN sections sec ON sec.id = s.section_id
         JOIN concerts c ON c.id = b.concert_id
         JOIN users u ON u.id = b.user_id
         LEFT JOIN admins a ON a.id = b.created_by_admin_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.event_date ASC, s.display_order ASC, s.seat_number ASC`,
      params,
    );

    await audit(req, {
      action: 'EXPORT_BOOKINGS',
      entityType: 'BOOKING',
      metadata: { rows: rows.length, concert_id: req.query.concert_id || null, status },
    });

    const label = req.query.concert_id
      ? slug((await bookingService.getConcert(Number(req.query.concert_id))).name)
      : 'all-concerts';

    sendCsv(
      res,
      `bookings-${label}-${today()}.csv`,
      [
        'Seat', 'Section', 'Booking reference', 'Party size', 'Attendee', 'Email',
        'Mobile', 'WhatsApp', 'WhatsApp verified', 'Emergency contact',
        'Concert', 'Event date', 'Start time', 'Venue', 'Status', 'Booking fee',
        'Booked', 'Confirmed', 'Source', 'Booked by admin',
        'Cancelled', 'Cancelled by', 'Cancel reason', 'Note',
      ],
      rows.map((r) => [
        r.seat_number,
        r.section_name,
        r.booking_reference,
        Number(r.party_size),
        r.full_name,
        r.email,
        r.mobile_number,
        r.whatsapp_number,
        r.whatsapp_verified ? 'Yes' : 'No',
        r.emergency_contact,
        r.concert_name,
        r.event_date,
        r.start_time,
        r.venue,
        r.status,
        'FREE',
        r.created_at,
        r.confirmed_at,
        r.source,
        r.booked_by_admin,
        r.cancelled_at,
        r.cancelled_by,
        r.cancel_reason,
        r.note,
      ]),
    );
  }),
);

// ---------------------------------------------------------------------------
// Notifications, audit log, settings
// ---------------------------------------------------------------------------
router.get(
  '/notifications',
  asyncRoute(async (req, res) => {
    const { page, size, limit } = pageParams(req);
    const where = [];
    const params = [];

    if (req.query.status) {
      where.push('n.status = ?');
      params.push(String(req.query.status).toUpperCase());
    }
    if (req.query.type) {
      where.push('n.type = ?');
      params.push(String(req.query.type).toUpperCase());
    }
    if (req.query.search) {
      const term = `%${String(req.query.search).trim()}%`;
      where.push('(n.recipient LIKE ? OR u.full_name LIKE ?)');
      params.push(term, term);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.query(
      `SELECT n.id, n.recipient, n.channel, n.type, n.status, n.failure_reason, n.sent_at,
              n.created_at, n.body, u.full_name
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id
         ${clause}
         ORDER BY n.id DESC ${limit}`,
      params,
    );

    const total = await db.queryOne(
      `SELECT COUNT(*) AS count FROM notifications n LEFT JOIN users u ON u.id = n.user_id ${clause}`,
      params,
    );

    res.json({
      notifications: rows.map((n) => ({ ...n, recipient_masked: maskPhone(n.recipient) })),
      pagination: { page, per_page: size, total: Number(total.count) },
    });
  }),
);

router.get(
  '/audit-logs',
  asyncRoute(async (req, res) => {
    const { page, size, limit } = pageParams(req);
    const where = [];
    const params = [];
    if (req.query.action) {
      where.push('action LIKE ?');
      params.push(`%${String(req.query.action).trim()}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.query(
      `SELECT id, actor_type, actor_id, actor_label, action, entity_type, entity_id,
              metadata, ip_address, created_at
         FROM audit_logs ${clause} ORDER BY id DESC ${limit}`,
      params,
    );
    const total = await db.queryOne(`SELECT COUNT(*) AS count FROM audit_logs ${clause}`, params);

    res.json({ logs: rows, pagination: { page, per_page: size, total: Number(total.count) } });
  }),
);

router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    res.json({ settings: await getSettings() });
  }),
);

router.patch(
  '/settings',
  asyncRoute(async (req, res) => {
    const data = parse(schemas.settingsSchema, req.body);
    if (!Object.keys(data).length) throw badRequest('Nothing to update.');
    await setSettings(data);
    await audit(req, { action: 'SETTINGS_UPDATED', entityType: 'SETTINGS', metadata: data });
    res.json({ settings: await getSettings(), message: 'Settings saved.' });
  }),
);

/** Send the event reminder to everyone holding a live booking. */
router.post(
  '/notifications/remind',
  asyncRoute(async (req, res) => {
    const concert = await resolveConcert(req);
    const rows = await db.query(
      `SELECT u.id, u.full_name, u.email, u.whatsapp_number, b.booking_reference, s.seat_number
         FROM bookings b
         JOIN users u ON u.id = b.user_id
         JOIN seats s ON s.id = b.seat_id
        WHERE b.concert_id = ? AND b.status IN ${bookingService.ACTIVE} AND u.whatsapp_verified = 1`,
      [concert.id],
    );

    let sent = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      const result = await notifications.sendEventReminder(
        row,
        concert,
        row.seat_number,
        row.booking_reference,
      );
      if (result.ok) sent += 1;
    }

    await audit(req, {
      action: 'REMINDERS_SENT',
      entityType: 'CONCERT',
      entityId: concert.id,
      metadata: { attempted: rows.length, sent },
    });

    res.json({
      ok: true,
      message: `Sent ${sent} of ${rows.length} reminders. Check the notification log for failures.`,
    });
  }),
);


// ---------------------------------------------------------------------------
// Console notification feed
//
// Staff-facing, and deliberately not the same thing as /notifications above,
// which lists outbound WhatsApp and email to attendees. See
// services/console-feed.js for why the two are separate tables.
// ---------------------------------------------------------------------------

router.get(
  '/console-notifications',
  asyncRoute(async (req, res) => {
    const { page, size, limit } = pageParams(req, 20);
    const where = [];
    const params = [];

    const category = String(req.query.category || '').toUpperCase();
    if (category && category !== 'ALL') {
      if (!feed.CATEGORIES.includes(category)) throw badRequest('Unknown category.');
      where.push('n.category = ?');
      params.push(category);
    }
    if (req.query.unread === 'true') where.push('n.read_at IS NULL');

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.query(
      `SELECT n.*, c.name AS concert_name
         FROM admin_notifications n
         LEFT JOIN concerts c ON c.id = n.concert_id
         ${clause}
        ORDER BY n.id DESC ${limit}`,
      params,
    );

    const total = await db.queryOne(
      `SELECT COUNT(*) AS count FROM admin_notifications n ${clause}`,
      params,
    );

    // Counts for the category chips and the header bell, in one round trip.
    const counts = await db.query(
      `SELECT category, COUNT(*) AS total, SUM(read_at IS NULL) AS unread
         FROM admin_notifications GROUP BY category`,
    );
    const byCategory = {};
    let unreadTotal = 0;
    let grandTotal = 0;
    for (const row of counts) {
      byCategory[row.category] = { total: Number(row.total), unread: Number(row.unread || 0) };
      unreadTotal += Number(row.unread || 0);
      grandTotal += Number(row.total);
    }

    res.json({
      notifications: rows,
      counts: { by_category: byCategory, unread: unreadTotal, total: grandTotal },
      pagination: { page, per_page: size, total: Number(total.count) },
    });
  }),
);

/** Just the badge number, for polling without pulling the whole feed. */
router.get(
  '/console-notifications/unread-count',
  asyncRoute(async (req, res) => {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS count FROM admin_notifications WHERE read_at IS NULL`,
    );
    res.json({ unread: Number(row.count) });
  }),
);

router.patch(
  '/console-notifications/read-all',
  asyncRoute(async (req, res) => {
    await db.query(`UPDATE admin_notifications SET read_at = NOW() WHERE read_at IS NULL`);
    res.json({ ok: true, unread: 0, message: 'All notifications marked as read.' });
  }),
);

router.patch(
  '/console-notifications/:id',
  asyncRoute(async (req, res) => {
    const read = req.body?.read !== false;
    const result = await db.query(`UPDATE admin_notifications SET read_at = ? WHERE id = ?`, [
      read ? new Date() : null,
      req.params.id,
    ]);
    if (!result.affectedRows) throw notFound('Notification not found.');
    res.json({ ok: true });
  }),
);

router.delete(
  '/console-notifications/:id',
  asyncRoute(async (req, res) => {
    const result = await db.query(`DELETE FROM admin_notifications WHERE id = ?`, [req.params.id]);
    if (!result.affectedRows) throw notFound('Notification not found.');
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Concert poster upload
//
// Multipart would mean a new dependency, so the browser sends a data URI in
// JSON instead and this decodes it. The checks below are the whole security
// story, so they are deliberately strict:
//
//   * only raster types are accepted. SVG is refused on purpose — it is a
//     document that can carry script, and these files are served same-origin
//     from a page with a CSP that trusts 'self'.
//   * the extension is derived from the declared type, never from anything
//     the client sends as a filename, so no path or double-extension games.
//   * the filename is generated here, so nothing user-supplied reaches the
//     filesystem at all.
// ---------------------------------------------------------------------------

const POSTER_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const POSTER_MAX_BYTES = 2 * 1024 * 1024;
const POSTER_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'posters', 'uploads');

router.post(
  '/concerts/:id/poster',
  asyncRoute(async (req, res) => {
    const concert = await bookingService.getConcert(Number(req.params.id));

    const dataUri = String(req.body?.image || '');
    const match = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
    if (!match) throw badRequest('Send the image as a base64 data URI.', 'BAD_IMAGE');

    const extension = POSTER_TYPES[match[1]];
    if (!extension) {
      throw badRequest('Posters must be PNG, JPEG or WebP.', 'BAD_IMAGE_TYPE');
    }

    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length) throw badRequest('That image is empty.', 'BAD_IMAGE');
    if (bytes.length > POSTER_MAX_BYTES) {
      throw badRequest('Posters must be 2 MB or smaller.', 'IMAGE_TOO_LARGE');
    }

    await fs.mkdir(POSTER_DIR, { recursive: true });
    const filename = `concert-${concert.id}-${randomToken(8)}.${extension}`;
    await fs.writeFile(path.join(POSTER_DIR, filename), bytes);

    const posterPath = `/assets/posters/uploads/${filename}`;
    const previous = concert.poster_path;
    await db.query('UPDATE concerts SET poster_path = ? WHERE id = ?', [posterPath, concert.id]);

    // Best-effort cleanup of the file this one replaces. Only ever inside the
    // uploads directory, so a hand-set poster_path pointing at bundled artwork
    // can never be deleted by an upload.
    if (previous && previous.startsWith('/assets/posters/uploads/')) {
      fs.unlink(path.join(POSTER_DIR, path.basename(previous))).catch(() => {});
    }

    await audit(req, {
      action: 'CONCERT_POSTER_UPDATED',
      entityType: 'CONCERT',
      entityId: concert.id,
      metadata: { poster_path: posterPath, bytes: bytes.length },
    });

    res.json({ poster_path: posterPath, message: 'Poster updated.' });
  }),
);

router.delete(
  '/concerts/:id/poster',
  asyncRoute(async (req, res) => {
    const concert = await bookingService.getConcert(Number(req.params.id));
    if (concert.poster_path && concert.poster_path.startsWith('/assets/posters/uploads/')) {
      fs.unlink(path.join(POSTER_DIR, path.basename(concert.poster_path))).catch(() => {});
    }
    await db.query('UPDATE concerts SET poster_path = NULL WHERE id = ?', [concert.id]);
    await audit(req, {
      action: 'CONCERT_POSTER_CLEARED',
      entityType: 'CONCERT',
      entityId: concert.id,
    });
    res.json({ poster_path: null, message: 'Poster removed. The bundled artwork is back.' });
  }),
);

// ---------------------------------------------------------------------------
// Dashboard and report aggregates
// ---------------------------------------------------------------------------

/** Clamp a ?days= window to something a chart can actually draw. */
const windowDays = (req, fallback = 30) =>
  Math.min(365, Math.max(7, Number.parseInt(req.query.days, 10) || fallback));

/**
 * Day-by-day booking activity for the overview chart.
 *
 * The SQL only returns days that had activity, so the gaps are filled in here
 * — a line chart with missing days draws a misleading slope.
 */
router.get(
  '/analytics/bookings',
  asyncRoute(async (req, res) => {
    const days = windowDays(req);
    const concertId = req.query.concert_id ? Number(req.query.concert_id) : null;

    const where = ['b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
    const params = [days];
    if (concertId) {
      where.push('b.concert_id = ?');
      params.push(concertId);
    }

    const rows = await db.query(
      `SELECT DATE(b.created_at) AS day,
              COUNT(*) AS seats,
              COUNT(DISTINCT b.booking_reference) AS bookings,
              SUM(b.status = 'CANCELLED') AS cancellations
         FROM bookings b
        WHERE ${where.join(' AND ')}
        GROUP BY DATE(b.created_at)
        ORDER BY day ASC`,
      params,
    );

    const byDay = new Map(
      rows.map((row) => [
        row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
        row,
      ]),
    );

    const series = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().slice(0, 10);
      const row = byDay.get(key);
      series.push({
        date: key,
        seats: row ? Number(row.seats) : 0,
        bookings: row ? Number(row.bookings) : 0,
        cancellations: row ? Number(row.cancellations || 0) : 0,
      });
    }

    res.json({ days, series });
  }),
);

/**
 * One row per concert: capacity, what is taken, and how full it is. Drives the
 * concert-performance chart and the occupancy report.
 */
router.get(
  '/analytics/concerts',
  asyncRoute(async (req, res) => {
    const rows = await db.query(
      `SELECT c.id, c.name, c.event_date, c.start_time, c.venue, c.max_capacity, c.is_active,
              (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id) AS total_seats,
              (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'AVAILABLE') AS available_seats,
              (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'RESERVED') AS reserved_seats,
              (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'DISABLED') AS blocked_seats,
              (SELECT COUNT(*) FROM bookings b
                WHERE b.concert_id = c.id AND b.status IN ${bookingService.ACTIVE}) AS booked_seats,
              (SELECT COUNT(DISTINCT b.booking_reference) FROM bookings b
                WHERE b.concert_id = c.id AND b.status IN ${bookingService.ACTIVE}) AS parties,
              (SELECT COUNT(*) FROM bookings b
                WHERE b.concert_id = c.id AND b.status = 'CANCELLED') AS cancellations
         FROM concerts c
        ORDER BY c.event_date DESC`,
    );

    const concerts = rows.map((row) => {
      const capacity = Number(row.max_capacity) || 0;
      const booked = Number(row.booked_seats) || 0;
      return {
        ...row,
        total_seats: Number(row.total_seats),
        available_seats: Number(row.available_seats),
        reserved_seats: Number(row.reserved_seats),
        blocked_seats: Number(row.blocked_seats),
        booked_seats: booked,
        parties: Number(row.parties),
        cancellations: Number(row.cancellations),
        occupancy: capacity ? Math.round((booked / capacity) * 100) : 0,
      };
    });

    res.json({ concerts });
  }),
);

/**
 * The numbers behind Reports & Export, for whatever window and filters the page
 * is showing. Deliberately returns the same shape whether or not a concert is
 * named, so the page does not branch on it.
 */
router.get(
  '/analytics/summary',
  asyncRoute(async (req, res) => {
    const days = windowDays(req, 90);
    const concertId = req.query.concert_id ? Number(req.query.concert_id) : null;

    const scope = ['b.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
    const params = [days];
    if (concertId) {
      scope.push('b.concert_id = ?');
      params.push(concertId);
    }
    const clause = scope.join(' AND ');

    const bookings = await db.queryOne(
      `SELECT COUNT(DISTINCT b.booking_reference) AS parties,
              COUNT(*) AS seats,
              SUM(b.status IN ('PENDING','CONFIRMED')) AS live_seats,
              SUM(b.status = 'CANCELLED') AS cancelled_seats,
              SUM(b.source = 'ADMIN') AS staff_created
         FROM bookings b WHERE ${clause}`,
      params,
    );

    const seatScope = concertId ? 'WHERE concert_id = ?' : '';
    const seatParams = concertId ? [concertId] : [];
    const seats = await db.queryOne(
      `SELECT COUNT(*) AS total,
              SUM(status = 'AVAILABLE') AS available,
              SUM(status = 'RESERVED') AS reserved,
              SUM(status = 'BOOKED') AS booked,
              SUM(status = 'DISABLED') AS blocked
         FROM seats ${seatScope}`,
      seatParams,
    );

    const people = await db.queryOne(
      `SELECT COUNT(*) AS registered,
              SUM(whatsapp_verified = 1) AS verified,
              SUM(is_active = 1) AS active
         FROM users`,
    );

    const capacityRow = await db.queryOne(
      concertId
        ? 'SELECT SUM(max_capacity) AS capacity FROM concerts WHERE id = ?'
        : 'SELECT SUM(max_capacity) AS capacity FROM concerts',
      seatParams,
    );

    const liveSeats = Number(bookings.live_seats || 0);
    const capacity = Number(capacityRow.capacity || 0);
    const cancelledSeats = Number(bookings.cancelled_seats || 0);
    const totalSeatRows = Number(bookings.seats || 0);

    res.json({
      window_days: days,
      concert_id: concertId,
      bookings: {
        parties: Number(bookings.parties || 0),
        seats: totalSeatRows,
        live_seats: liveSeats,
        cancelled_seats: cancelledSeats,
        staff_created: Number(bookings.staff_created || 0),
        cancellation_rate: totalSeatRows
          ? Math.round((cancelledSeats / totalSeatRows) * 100)
          : 0,
      },
      seats: {
        total: Number(seats.total || 0),
        available: Number(seats.available || 0),
        reserved: Number(seats.reserved || 0),
        booked: Number(seats.booked || 0),
        blocked: Number(seats.blocked || 0),
      },
      capacity: {
        total: capacity,
        taken: liveSeats,
        remaining: Math.max(0, capacity - liveSeats),
        occupancy: capacity ? Math.round((liveSeats / capacity) * 100) : 0,
      },
      people: {
        registered: Number(people.registered || 0),
        whatsapp_verified: Number(people.verified || 0),
        active: Number(people.active || 0),
      },
    });
  }),
);


/**
 * The same printable confirmation an attendee gets, fetched by reference.
 *
 * Staff reach this for anybody, which is the whole difference from
 * /api/bookings/mine/confirmation — the document itself is shared code in
 * lib/ticket.js. Behind requireAdmin like everything else in this file.
 */
router.get(
  '/bookings/:reference/ticket',
  asyncRoute(async (req, res) => {
    const reference = String(req.params.reference).trim();

    const holder = await db.queryOne(
      `SELECT u.id, u.full_name, u.whatsapp_number
         FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.booking_reference = ? AND b.status IN ${bookingService.ACTIVE}
        LIMIT 1`,
      [reference],
    );
    if (!holder) throw notFound('No live booking has that reference.', 'NO_BOOKING');

    const party = await bookingService.getBookingByReference(reference);
    if (!party) throw notFound('No live booking has that reference.', 'NO_BOOKING');

    res.type('html').send(
      await renderTicket(party, holder, { autoPrint: req.query.print === '1' }),
    );
  }),
);


/**
 * Check the mail credentials without sending anything.
 *
 * Worth its own endpoint: a wrong Gmail App Password is silent otherwise —
 * registrations still succeed, reset links still get generated, and the only
 * evidence is FAILED rows nobody is looking at. This turns that into a button.
 */
router.get(
  '/email/test',
  asyncRoute(async (req, res) => {
    const result = await emailService.verifyConnection();
    res.json({
      ...result,
      from: env.email.from || null,
      user: env.email.user || null,
    });
  }),
);

/** Send a real test message to the signed-in administrator. */
router.post(
  '/email/test',
  asyncRoute(async (req, res) => {
    const result = await emailService.sendRaw({
      to: req.admin.email,
      subject: `${env.appName}: test message`,
      text:
        `This is a test from the ${env.appName} console, sent by ${req.admin.full_name}.

` +
        `If you are reading it, outgoing email is working.`,
      html: `<p>This is a test from the <strong>${env.appName}</strong> console, sent by ${req.admin.full_name}.</p><p>If you are reading it, outgoing email is working.</p>`,
    });

    await audit(req, { action: 'EMAIL_TEST_SENT', entityType: 'SETTINGS', metadata: { to: req.admin.email } });

    if (!result.ok) throw badRequest(result.error, 'EMAIL_TEST_FAILED');
    res.json({ ok: true, message: `Test message sent to ${req.admin.email}.` });
  }),
);


/**
 * What a scanned ticket QR resolves to.
 *
 * Behind requireAdmin like everything else here, which is the point: a QR on a
 * piece of paper anybody could photograph must not, on its own, reveal who is
 * coming or what they hold. A steward signs in once on their phone; a stranger
 * scanning the same code gets the staff sign-in page and nothing else.
 */
router.get(
  '/checkin',
  asyncRoute(async (req, res) => {
    const reference = String(req.query.reference || '').trim();
    if (!reference) throw badRequest('No booking reference given.', 'NO_REFERENCE');

    const rows = await db.query(
      `SELECT b.id, b.booking_reference, b.status, b.created_at, b.cancelled_at, b.cancel_reason,
              s.seat_number, sec.name AS section_name,
              u.full_name, u.whatsapp_verified,
              c.id AS concert_id, c.name AS concert_name, c.event_date, c.start_time, c.venue
         FROM bookings b
         JOIN seats s ON s.id = b.seat_id
         JOIN sections sec ON sec.id = s.section_id
         JOIN users u ON u.id = b.user_id
         JOIN concerts c ON c.id = b.concert_id
        WHERE b.booking_reference = ?
        ORDER BY s.display_order ASC, s.seat_number ASC`,
      [reference],
    );

    if (!rows.length) {
      return res.json({
        found: false,
        valid: false,
        reference,
        verdict: 'UNKNOWN',
        message: 'No booking has that reference. Check the code and try again.',
      });
    }

    const live = rows.filter((row) => row.status === 'PENDING' || row.status === 'CONFIRMED');
    const first = rows[0];

    // "Is it tonight?" is the question a steward is really asking, and a ticket
    // for next month scans exactly like a ticket for tonight.
    const eventDate = String(first.event_date).slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const whenVerdict = eventDate === today ? 'TODAY' : eventDate < today ? 'PAST' : 'FUTURE';

    const valid = live.length > 0 && whenVerdict === 'TODAY';
    const verdict = live.length === 0 ? 'CANCELLED' : whenVerdict === 'TODAY' ? 'ADMIT' : whenVerdict;

    const message = {
      ADMIT: `Admit ${live.length} ${live.length === 1 ? 'person' : 'people'}.`,
      CANCELLED: 'This booking was cancelled. The seats have been released.',
      FUTURE: 'Valid, but not for today — this ticket is for a later date.',
      PAST: 'This ticket was for a concert that has already happened.',
    }[verdict];

    await audit(req, {
      action: 'BOOKING_CHECKED_IN',
      entityType: 'BOOKING',
      entityId: first.id,
      metadata: { reference, verdict },
    });

    return res.json({
      found: true,
      valid,
      verdict,
      message,
      reference,
      holder: first.full_name,
      whatsapp_verified: Boolean(first.whatsapp_verified),
      booked_at: first.created_at,
      cancelled_at: first.cancelled_at,
      cancel_reason: first.cancel_reason,
      concert: {
        id: first.concert_id,
        name: first.concert_name,
        event_date: first.event_date,
        start_time: first.start_time,
        venue: first.venue,
        is_today: whenVerdict === 'TODAY',
      },
      seats: rows.map((row) => ({
        seat_number: row.seat_number,
        section_name: row.section_name,
        status: row.status,
      })),
      live_seats: live.length,
      total_seats: rows.length,
    });
  }),
);

module.exports = router;
