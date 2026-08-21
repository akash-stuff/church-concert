'use strict';

const db = require('../db');
const { conflict, notFound, badRequest, forbidden } = require('../lib/helpers');

const ACTIVE = "('PENDING','CONFIRMED')";

/** Hard ceiling on one request, so a single call cannot lock 500 seat rows. */
const MAX_SEATS_PER_REQUEST = 25;

/** Every concert, newest event first, each with its own availability. */
async function listConcerts({ activeOnly = true } = {}) {
  const concerts = await db.query(
    `SELECT * FROM concerts ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY event_date ASC, start_time ASC, id ASC`,
  );
  return Promise.all(
    concerts.map(async (concert) => ({
      concert,
      availability: await getAvailability(concert),
    })),
  );
}

async function getConcert(concertId, runner = db.pool) {
  const [rows] = await runner.execute('SELECT * FROM concerts WHERE id = ? LIMIT 1', [concertId]);
  if (!rows.length) throw notFound('That concert does not exist.', 'CONCERT_NOT_FOUND');
  return rows[0];
}

/**
 * The concert to show when none was asked for: the next active one that has not
 * happened yet, falling back to the most recent.
 */
async function getDefaultConcert(runner = db.pool) {
  const [rows] = await runner.execute(
    `SELECT * FROM concerts WHERE is_active = 1
      ORDER BY (event_date < CURDATE()) ASC, event_date ASC, id ASC LIMIT 1`,
  );
  if (!rows.length) throw notFound('No concert is set up yet.', 'NO_CONCERT');
  return rows[0];
}

/** Seat and capacity numbers for one concert. */
async function getAvailability(concert) {
  const counts = await db.query(
    `SELECT status, COUNT(*) AS count FROM seats WHERE concert_id = ? GROUP BY status`,
    [concert.id],
  );
  const byStatus = { AVAILABLE: 0, SELECTED: 0, BOOKED: 0, RESERVED: 0, DISABLED: 0 };
  let totalSeats = 0;
  for (const row of counts) {
    byStatus[row.status] = Number(row.count);
    totalSeats += Number(row.count);
  }

  const live = await db.queryOne(
    `SELECT COUNT(*) AS seats, COUNT(DISTINCT booking_reference) AS parties
       FROM bookings WHERE concert_id = ? AND status IN ${ACTIVE}`,
    [concert.id],
  );
  const bookedSeats = Number(live.seats);
  const capacity = Number(concert.max_capacity);
  const remaining = Math.max(0, capacity - bookedSeats);
  const bookable = Math.min(byStatus.AVAILABLE, remaining);

  return {
    concert_id: concert.id,
    max_capacity: capacity,
    max_seats_per_booking: Number(concert.max_seats_per_booking) || 0,
    total_seats: totalSeats,
    seats_by_status: byStatus,
    available_seats: byStatus.AVAILABLE,
    bookable_seats: bookable,
    booked_seats: bookedSeats,
    parties: Number(live.parties),
    reserved_seats: byStatus.RESERVED,
    disabled_seats: byStatus.DISABLED,
    remaining_capacity: remaining,
    fully_booked: remaining === 0 || bookable === 0,
  };
}

/** Availability plus the account totals the admin dashboard shows. */
async function getStats(concertId) {
  const concert = await getConcert(concertId);
  const availability = await getAvailability(concert);

  const users = await db.queryOne(
    `SELECT COUNT(*) AS total,
            SUM(whatsapp_verified = 1) AS verified,
            SUM(is_active = 1) AS active
       FROM users`,
  );

  return {
    ...availability,
    registered_users: Number(users.total || 0),
    eligible_users: Number(users.active || 0),
    whatsapp_verified_users: Number(users.verified || 0),
  };
}

/**
 * Seat map for the booking screen. Booked seats are returned without any
 * personal detail — occupant names are admin-only.
 */
async function getSeatMap(concertId, { includeOccupant = false } = {}) {
  const sections = await db.query(
    `SELECT id, name, display_order FROM sections WHERE concert_id = ?
      ORDER BY display_order ASC, name ASC`,
    [concertId],
  );

  const seats = await db.query(
    `SELECT s.id, s.section_id, s.seat_number, s.row_label, s.display_order, s.status, s.note,
            b.id AS booking_id, b.booking_reference, b.status AS booking_status,
            ${includeOccupant ? 'u.id AS user_id, u.full_name AS occupant_name, u.whatsapp_number AS occupant_whatsapp' : 'NULL AS user_id, NULL AS occupant_name, NULL AS occupant_whatsapp'}
       FROM seats s
       LEFT JOIN bookings b ON b.seat_id = s.id AND b.status IN ${ACTIVE}
       LEFT JOIN users u ON u.id = b.user_id
      WHERE s.concert_id = ?
      ORDER BY s.display_order ASC, s.seat_number ASC`,
    [concertId],
  );

  return sections.map((section) => ({
    ...section,
    seats: seats
      .filter((seat) => seat.section_id === section.id)
      .map((seat) => ({
        id: seat.id,
        seat_number: seat.seat_number,
        row_label: seat.row_label,
        display_order: seat.display_order,
        status: seat.status,
        note: includeOccupant ? seat.note : undefined,
        is_taken: Boolean(seat.booking_id) || seat.status !== 'AVAILABLE',
        booking: seat.booking_id
          ? {
              id: seat.booking_id,
              reference: seat.booking_reference,
              status: seat.booking_status,
              user_id: includeOccupant ? seat.user_id : undefined,
              occupant_name: includeOccupant ? seat.occupant_name : undefined,
              occupant_whatsapp: includeOccupant ? seat.occupant_whatsapp : undefined,
            }
          : null,
      })),
  }));
}

/**
 * Next reference for a concert, e.g. CHC-2026-00001. Counters are per concert,
 * so two concerts running side by side each number from one under their own
 * prefix. Must run inside a transaction.
 */
async function nextBookingReference(conn, concert) {
  const key = `booking_reference:${concert.id}`;
  await conn.execute(
    `INSERT INTO counters (name, value) VALUES (?, 0) ON DUPLICATE KEY UPDATE name = name`,
    [key],
  );
  const [rows] = await conn.execute(`SELECT value FROM counters WHERE name = ? FOR UPDATE`, [key]);
  const next = Number(rows[0].value) + 1;
  await conn.execute(`UPDATE counters SET value = ? WHERE name = ?`, [next, key]);

  const year = String(concert.event_date).slice(0, 4) || String(new Date().getUTCFullYear());
  return `${concert.booking_ref_prefix}-${year}-${String(next).padStart(5, '0')}`;
}

function withinWindow(opensAt, closesAt, now = new Date()) {
  if (opensAt && now < new Date(opensAt)) return 'NOT_OPEN';
  if (closesAt && now > new Date(closesAt)) return 'CLOSED';
  return 'OPEN';
}

/**
 * Book one or more seats for one person, as a single party sharing one
 * reference. All-or-nothing: if any requested seat has gone, the whole request
 * fails and nothing is written, because a family told "you got 3 of your 4
 * seats" has to start over anyway.
 *
 * Locks are taken in a fixed order — concert, user, then seats by ascending id
 * — so two overlapping multi-seat requests can never hold what the other
 * wants. The unique index on (seat_id, active_key) is the final backstop.
 *
 * @param {object}   params
 * @param {number}   params.userId
 * @param {number}   params.concertId
 * @param {number[]} params.seatIds   one or many
 * @returns {{reference: string, seats: object[], bookings: object[], concert: object, user: object}}
 */
async function createBooking({
  userId,
  concertId,
  seatIds,
  source = 'USER',
  adminId = null,
  note = null,
  guests = null,
}) {
  const requested = [...new Set((seatIds || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);

  if (!requested.length) throw badRequest('Choose at least one seat.', 'NO_SEATS');
  if (requested.length > MAX_SEATS_PER_REQUEST) {
    throw badRequest(
      `That is more than ${MAX_SEATS_PER_REQUEST} seats in one booking. Book them in smaller groups.`,
      'TOO_MANY_SEATS',
    );
  }
  // Ascending id order is what makes concurrent multi-seat requests safe.
  requested.sort((a, b) => a - b);

  /* Keyed by seat id, because of the sort immediately above: the order the
     client sent its seats in is not the order they are written, so pairing
     guests to seats by array index would attach people to the wrong chairs. */
  const guestBySeat = new Map(
    (guests || []).map((guest) => [Number(guest.seat_id), guest]),
  );

  return db.transaction(async (conn) => {
    // The capacity mutex, and the source of truth for the ceiling. See db.js on
    // why this is a single-row lock and why the count below is not FOR UPDATE.
    const [concertRows] = await conn.execute(
      'SELECT * FROM concerts WHERE id = ? FOR UPDATE',
      [concertId],
    );
    if (!concertRows.length) throw notFound('That concert does not exist.', 'CONCERT_NOT_FOUND');
    const concert = concertRows[0];
    const maxCapacity = Number(concert.max_capacity);
    const perPersonLimit = Number(concert.max_seats_per_booking) || 0;

    if (source === 'USER') {
      if (!concert.is_active) {
        throw forbidden('That concert is not open for booking.', 'CONCERT_INACTIVE');
      }
      const window = withinWindow(concert.booking_opens_at, concert.booking_closes_at);
      if (window === 'NOT_OPEN') {
        throw forbidden('Seat booking has not opened yet.', 'BOOKING_NOT_OPEN');
      }
      if (window === 'CLOSED') {
        throw forbidden('Seat booking for this concert has closed.', 'BOOKING_CLOSED');
      }
    }

    const [userRows] = await conn.execute(
      `SELECT id, full_name, email, whatsapp_number, whatsapp_verified, is_active, date_of_birth
         FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    if (!userRows.length) throw notFound('User not found.');
    const user = userRows[0];

    if (!user.is_active) throw forbidden('This account is disabled.', 'ACCOUNT_DISABLED');
    if (source === 'USER' && !user.whatsapp_verified) {
      throw forbidden('Verify your WhatsApp number before booking.', 'WHATSAPP_NOT_VERIFIED');
    }

    // Capacity. Accurate under READ COMMITTED while we hold the concert lock.
    const [capacityRows] = await conn.execute(
      `SELECT COUNT(*) AS count FROM bookings WHERE concert_id = ? AND status IN ${ACTIVE}`,
      [concert.id],
    );
    const alreadyBooked = Number(capacityRows[0].count);
    const remaining = maxCapacity - alreadyBooked;

    if (remaining <= 0) {
      throw conflict('Every seat has been taken. The concert is fully booked.', 'FULLY_BOOKED');
    }
    if (requested.length > remaining) {
      throw conflict(
        remaining === 1
          ? 'Only 1 seat is left, so that many will not fit. Choose 1 seat.'
          : `Only ${remaining} seats are left, so that many will not fit. Choose up to ${remaining}.`,
        'NOT_ENOUGH_CAPACITY',
        { remaining_capacity: remaining, requested: requested.length },
      );
    }

    // Optional per-person ceiling for this concert. 0 means no limit.
    if (perPersonLimit > 0) {
      const [heldRows] = await conn.execute(
        `SELECT COUNT(*) AS count FROM bookings
          WHERE concert_id = ? AND user_id = ? AND status IN ${ACTIVE}`,
        [concert.id, userId],
      );
      const held = Number(heldRows[0].count);
      if (held + requested.length > perPersonLimit) {
        throw conflict(
          `This concert allows ${perPersonLimit} seat${perPersonLimit === 1 ? '' : 's'} per person, and this account already holds ${held}.`,
          'PER_PERSON_LIMIT',
          { limit: perPersonLimit, already_held: held, requested: requested.length },
        );
      }
    }

    // Lock every requested seat, in ascending id order, before writing anything.
    const seats = [];
    for (const seatId of requested) {
      const [seatRows] = await conn.execute(
        `SELECT id, seat_number, status, section_id FROM seats
          WHERE id = ? AND concert_id = ? FOR UPDATE`,
        [seatId, concert.id],
      );
      if (!seatRows.length) {
        throw notFound('One of those seats is not part of this concert.', 'SEAT_NOT_FOUND');
      }
      const seat = seatRows[0];

      if (seat.status === 'DISABLED') {
        throw conflict(`Seat ${seat.seat_number} is not in use. Choose another.`, 'SEAT_DISABLED', {
          seat_number: seat.seat_number,
        });
      }
      if (seat.status === 'RESERVED' && source === 'USER') {
        throw conflict(
          `Seat ${seat.seat_number} is held by the church office. Choose another.`,
          'SEAT_RESERVED',
          { seat_number: seat.seat_number },
        );
      }
      if (seat.status === 'BOOKED') {
        throw conflict(`Seat ${seat.seat_number} was just taken. Choose another.`, 'SEAT_TAKEN', {
          seat_number: seat.seat_number,
        });
      }

      const [taken] = await conn.execute(
        `SELECT id FROM bookings WHERE seat_id = ? AND status IN ${ACTIVE} LIMIT 1`,
        [seat.id],
      );
      if (taken.length) {
        throw conflict(`Seat ${seat.seat_number} was just taken. Choose another.`, 'SEAT_TAKEN', {
          seat_number: seat.seat_number,
        });
      }

      seats.push(seat);
    }

    // One reference for the whole party.
    const reference = await nextBookingReference(conn, concert);
    const bookingIds = [];

    for (const seat of seats) {
      /* Whose seat this is. Falling back to the account holder rather than
         leaving the row blank: every seat must name somebody, or the door list
         and the hand bands have nothing to print. A single-seat booking with no
         guest details given is exactly the old behaviour — the booker. */
      const guest = guestBySeat.get(seat.id);
      const guestName = guest?.name || user.full_name;
      const guestEmail = guest?.email ?? user.email;
      const guestPhone = guest?.phone ?? user.whatsapp_number;
      const guestAge = guest?.age ?? null;

      try {
        const [result] = await conn.execute(
          `INSERT INTO bookings
             (booking_reference, concert_id, user_id, seat_id, status, source,
              created_by_admin_id, confirmed_at, note,
              guest_name, guest_email, guest_phone, guest_age)
           VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, NOW(), ?, ?, ?, ?, ?)`,
          [
            reference,
            concert.id,
            userId,
            seat.id,
            source,
            adminId,
            note,
            guestName,
            guestEmail,
            guestPhone,
            guestAge,
          ],
        );
        bookingIds.push(result.insertId);
      } catch (err) {
        // The unique index did its job: someone else committed first.
        if (db.isDuplicateKey(err)) {
          throw conflict(`Seat ${seat.seat_number} was just taken. Choose another.`, 'SEAT_TAKEN', {
            seat_number: seat.seat_number,
          });
        }
        throw err;
      }
    }

    const placeholders = seats.map(() => '?').join(', ');
    await conn.execute(
      `UPDATE seats SET status = 'BOOKED' WHERE id IN (${placeholders})`,
      seats.map((seat) => seat.id),
    );

    const [bookingRows] = await conn.execute(
      `SELECT * FROM bookings WHERE id IN (${bookingIds.map(() => '?').join(', ')}) ORDER BY id ASC`,
      bookingIds,
    );

    return { reference, seats, bookings: bookingRows, concert, user };
  });
}

/**
 * Cancel one seat. `bookingId` identifies a single row, so this releases one
 * seat out of a party and leaves the rest standing.
 */
async function cancelBooking({ bookingId, cancelledBy, reason = null, userId = null }) {
  return db.transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT b.*, s.seat_number, s.id AS seat_id, s.status AS seat_status
         FROM bookings b JOIN seats s ON s.id = b.seat_id
        WHERE b.id = ? FOR UPDATE`,
      [bookingId],
    );
    if (!rows.length) throw notFound('Booking not found.');
    const booking = rows[0];

    if (userId && booking.user_id !== userId) throw forbidden('That is not your booking.');
    if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
      throw badRequest('That booking is not active.', 'NOT_ACTIVE');
    }

    await conn.execute(
      `UPDATE bookings
          SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
        WHERE id = ?`,
      [cancelledBy, reason, bookingId],
    );

    if (booking.seat_status === 'BOOKED') {
      await conn.execute(`UPDATE seats SET status = 'AVAILABLE' WHERE id = ?`, [booking.seat_id]);
    }

    const [userRows] = await conn.execute(
      `SELECT id, full_name, email, whatsapp_number FROM users WHERE id = ?`,
      [booking.user_id],
    );
    // The booking's own concert, not "the" concert: several run at once.
    const concert = await getConcert(booking.concert_id, conn);

    return {
      booking,
      seatNumbers: [booking.seat_number],
      seatNumber: booking.seat_number,
      user: userRows[0],
      concert,
    };
  });
}

/**
 * Cancel a whole party by reference, releasing every seat it holds.
 * This is what an attendee gets when they cancel from their dashboard.
 */
async function cancelBookingGroup({ reference, cancelledBy, reason = null, userId = null }) {
  return db.transaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT b.*, s.seat_number, s.id AS seat_id, s.status AS seat_status
         FROM bookings b JOIN seats s ON s.id = b.seat_id
        WHERE b.booking_reference = ? AND b.status IN ${ACTIVE}
        ORDER BY s.id ASC
        FOR UPDATE`,
      [reference],
    );
    if (!rows.length) throw notFound('No live booking has that reference.', 'NOT_FOUND');
    if (userId && rows.some((row) => row.user_id !== userId)) {
      throw forbidden('That is not your booking.');
    }

    const ids = rows.map((row) => row.id);
    await conn.execute(
      `UPDATE bookings
          SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
        WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [cancelledBy, reason, ...ids],
    );

    const heldSeats = rows.filter((row) => row.seat_status === 'BOOKED').map((row) => row.seat_id);
    if (heldSeats.length) {
      await conn.execute(
        `UPDATE seats SET status = 'AVAILABLE' WHERE id IN (${heldSeats.map(() => '?').join(', ')})`,
        heldSeats,
      );
    }

    const [userRows] = await conn.execute(
      `SELECT id, full_name, email, whatsapp_number FROM users WHERE id = ?`,
      [rows[0].user_id],
    );
    const concert = await getConcert(rows[0].concert_id, conn);

    return {
      reference,
      booking: rows[0],
      bookings: rows,
      seatNumbers: rows.map((row) => row.seat_number),
      user: userRows[0],
      concert,
    };
  });
}

/** Move one live seat booking to a different seat in the same concert. */
async function reassignSeat({ bookingId, newSeatId, adminId, note = null }) {
  return db.transaction(async (conn) => {
    const [bookingRows] = await conn.execute(
      `SELECT b.*, s.seat_number AS old_seat_number, s.id AS old_seat_id, s.status AS old_seat_status
         FROM bookings b JOIN seats s ON s.id = b.seat_id
        WHERE b.id = ? FOR UPDATE`,
      [bookingId],
    );
    if (!bookingRows.length) throw notFound('Booking not found.');
    const booking = bookingRows[0];
    if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
      throw badRequest('That booking is not active.', 'NOT_ACTIVE');
    }
    if (booking.old_seat_id === Number(newSeatId)) {
      throw badRequest('The booking is already on that seat.', 'NO_CHANGE');
    }

    const [seatRows] = await conn.execute(
      `SELECT id, seat_number, status FROM seats WHERE id = ? AND concert_id = ? FOR UPDATE`,
      [newSeatId, booking.concert_id],
    );
    if (!seatRows.length) {
      throw notFound('That seat is not part of the same concert.', 'SEAT_NOT_FOUND');
    }
    const newSeat = seatRows[0];
    if (newSeat.status === 'DISABLED') throw conflict('That seat is not in use.', 'SEAT_DISABLED');

    const [taken] = await conn.execute(
      `SELECT id FROM bookings WHERE seat_id = ? AND status IN ${ACTIVE} LIMIT 1`,
      [newSeat.id],
    );
    if (taken.length) throw conflict('That seat already has a booking.', 'SEAT_TAKEN');

    try {
      await conn.execute(`UPDATE bookings SET seat_id = ?, note = COALESCE(?, note) WHERE id = ?`, [
        newSeat.id,
        note,
        bookingId,
      ]);
    } catch (err) {
      if (db.isDuplicateKey(err)) throw conflict('That seat already has a booking.', 'SEAT_TAKEN');
      throw err;
    }

    await conn.execute(`UPDATE seats SET status = 'BOOKED' WHERE id = ?`, [newSeat.id]);
    if (booking.old_seat_status === 'BOOKED') {
      await conn.execute(`UPDATE seats SET status = 'AVAILABLE' WHERE id = ?`, [booking.old_seat_id]);
    }

    const [userRows] = await conn.execute(
      `SELECT id, full_name, email, whatsapp_number FROM users WHERE id = ?`,
      [booking.user_id],
    );
    const concert = await getConcert(booking.concert_id, conn);

    return {
      booking,
      oldSeat: booking.old_seat_number,
      newSeat: newSeat.seat_number,
      user: userRows[0],
      concert,
      adminId,
    };
  });
}

/**
 * Everything a person currently holds, grouped into parties by reference and
 * ordered by concert date. One row per reference, listing its seats.
 */
/**
 * Scopes.
 *
 *   active    every live booking, whenever the concert is. The default, and
 *             what the ticket, the seat map and the confirmation screen want:
 *             a ticket for last month's concert must still resolve.
 *   upcoming  live bookings for concerts that have not happened yet. What the
 *             dashboard calls "my bookings".
 *   past      the ones that are done with — live bookings whose concert has
 *             been and gone, plus anything cancelled or expired.
 *
 * 'past' is deliberately not the complement of 'active': a booking cancelled
 * for a concert next month belongs in the history, not in the live list.
 */
const SCOPES = {
  active: 'AND b.status IN ' + ACTIVE,
  upcoming: 'AND b.status IN ' + ACTIVE + ' AND c.event_date >= CURDATE()',
  past:
    'AND ((b.status IN ' +
    ACTIVE +
    " AND c.event_date < CURDATE()) OR b.status IN ('CANCELLED','EXPIRED'))",
};

async function getUserBookings(userId, { concertId = null, scope = 'active' } = {}) {
  const params = [userId];
  let filter = '';
  if (concertId) {
    filter = 'AND b.concert_id = ?';
    params.push(concertId);
  }

  const where = SCOPES[scope] || SCOPES.active;
  // History reads newest first; everything else counts down to the next date.
  const order = scope === 'past' ? 'DESC' : 'ASC';

  const rows = await db.query(
    `SELECT b.id, b.booking_reference, b.status, b.created_at AS booked_at, b.confirmed_at,
            b.cancelled_at, b.cancel_reason,
            b.source, b.concert_id,
            b.guest_name, b.guest_email, b.guest_phone, b.guest_age,
            s.id AS seat_id, s.seat_number, sec.name AS section_name,
            c.name AS concert_name, c.event_date, c.start_time, c.end_time,
            c.venue, c.address
       FROM bookings b
       JOIN seats s ON s.id = b.seat_id
       JOIN sections sec ON sec.id = s.section_id
       JOIN concerts c ON c.id = b.concert_id
      WHERE b.user_id = ? ${where} ${filter}
      ORDER BY c.event_date ${order}, b.booking_reference ASC,
               s.display_order ASC, s.seat_number ASC`,
    params,
  );

  const parties = new Map();
  for (const row of rows) {
    if (!parties.has(row.booking_reference)) {
      parties.set(row.booking_reference, {
        booking_reference: row.booking_reference,
        status: row.status,
        booked_at: row.booked_at,
        cancelled_at: row.cancelled_at,
        cancel_reason: row.cancel_reason,
        source: row.source,
        concert: {
          id: row.concert_id,
          name: row.concert_name,
          event_date: row.event_date,
          start_time: row.start_time,
          end_time: row.end_time,
          venue: row.venue,
          address: row.address,
        },
        seats: [],
      });
    }
    parties.get(row.booking_reference).seats.push({
      booking_id: row.id,
      seat_id: row.seat_id,
      seat_number: row.seat_number,
      section_name: row.section_name,
      // Who is in this particular seat. Backfilled to the account holder for
      // bookings made before guest details existed (migration 006).
      guest_name: row.guest_name,
      guest_email: row.guest_email,
      guest_phone: row.guest_phone,
      guest_age: row.guest_age,
    });
  }

  return [...parties.values()].map((party) => ({ ...party, seat_count: party.seats.length }));
}

/** One party by reference, for the confirmation screen. */
async function getBookingByReference(reference, { userId = null } = {}) {
  const parties = await db.query(
    `SELECT DISTINCT user_id FROM bookings WHERE booking_reference = ? AND status IN ${ACTIVE}`,
    [reference],
  );
  if (!parties.length) return null;
  if (userId && parties[0].user_id !== userId) throw forbidden('That is not your booking.');

  const all = await getUserBookings(parties[0].user_id);
  return all.find((party) => party.booking_reference === reference) || null;
}

module.exports = {
  // The live-booking status list, shared with the admin queries so that
  // "counts as holding a seat" is defined in exactly one place.
  ACTIVE,
  listConcerts,
  getConcert,
  getDefaultConcert,
  getAvailability,
  getStats,
  getSeatMap,
  createBooking,
  cancelBooking,
  cancelBookingGroup,
  reassignSeat,
  getUserBookings,
  getBookingByReference,
  withinWindow,
  nextBookingReference,
  MAX_SEATS_PER_REQUEST,
};
