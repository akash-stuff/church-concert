'use strict';

const express = require('express');
const db = require('../db');
const env = require('../env');
const bookingService = require('../services/booking');
const { renderTicket } = require('../lib/ticket');
const notifications = require('../services/notifications');
const feed = require('../services/console-feed');
const whatsapp = require('../services/whatsapp');
const { audit, getSettings } = require('../lib/audit');
const {
  asyncRoute,
  hashPassword,
  verifyPassword,
  badRequest,
  notFound,
  conflict,
  forbidden,
  maskPhone,
} = require('../lib/helpers');
const schemas = require('../lib/schemas');
const { parse } = schemas;
const auth = require('../middleware/auth');
const { publicUser } = require('./auth.routes');

const router = express.Router();

const publicConcert = (concert) => ({
  id: concert.id,
  name: concert.name,
  description: concert.description,
  poster_path: concert.poster_path,
  event_date: concert.event_date,
  start_time: concert.start_time,
  end_time: concert.end_time,
  venue: concert.venue,
  address: concert.address,
  max_capacity: concert.max_capacity,
  registration_opens_at: concert.registration_opens_at,
  registration_closes_at: concert.registration_closes_at,
  booking_opens_at: concert.booking_opens_at,
  booking_closes_at: concert.booking_closes_at,
});

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Every concert on offer, each with its own live availability. */
router.get(
  '/concerts',
  asyncRoute(async (req, res) => {
    const includeInactive = req.query.all === '1' && Boolean(req.admin);
    const list = await bookingService.listConcerts({ activeOnly: !includeInactive });

    res.json({
      concerts: list.map(({ concert, availability }) => ({
        ...publicConcert(concert),
        availability,
        registration: bookingService.withinWindow(
          concert.registration_opens_at,
          concert.registration_closes_at,
        ),
        booking: bookingService.withinWindow(concert.booking_opens_at, concert.booking_closes_at),
      })),
      app_name: env.appName,
    });
  }),
);

/**
 * One concert. `?concert_id=` picks it; without that, the next upcoming one.
 * Kept at /concert (singular) so existing links and bookmarks still work.
 */
router.get(
  '/concert',
  asyncRoute(async (req, res) => {
    const concert = req.query.concert_id
      ? await bookingService.getConcert(Number(req.query.concert_id))
      : await bookingService.getDefaultConcert();
    const availability = await bookingService.getAvailability(concert);

    res.json({
      concert: publicConcert(concert),
      availability,
      registration: bookingService.withinWindow(
        concert.registration_opens_at,
        concert.registration_closes_at,
      ),
      booking: bookingService.withinWindow(concert.booking_opens_at, concert.booking_closes_at),
      app_name: env.appName,
    });
  }),
);

router.get(
  '/seats',
  asyncRoute(async (req, res) => {
    const concert = req.query.concert_id
      ? await bookingService.getConcert(Number(req.query.concert_id))
      : await bookingService.getDefaultConcert();

    const [sections, availability] = await Promise.all([
      bookingService.getSeatMap(concert.id),
      bookingService.getAvailability(concert),
    ]);

    // What this person already holds for this concert, so the map can mark
    // their own seats rather than showing them as anonymous and taken.
    const mine = req.user
      ? await bookingService.getUserBookings(req.user.id, { concertId: concert.id })
      : [];
    const mySeatIds = new Set(mine.flatMap((party) => party.seats.map((seat) => seat.seat_id)));

    res.json({
      concert: publicConcert(concert),
      sections: sections.map((section) => ({
        ...section,
        seats: section.seats.map((seat) => ({ ...seat, is_mine: mySeatIds.has(seat.id) })),
      })),
      availability,
      my_bookings: mine,
      my_seat_count: mySeatIds.size,
    });
  }),
);

// ---------------------------------------------------------------------------
// Signed-in user
// ---------------------------------------------------------------------------

router.get(
  '/me',
  asyncRoute(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const settings = await getSettings();
    const bookings = await bookingService.getUserBookings(req.user.id);
    return res.json({
      user: publicUser(req.user),
      bookings,
      seat_count: bookings.reduce((total, party) => total + party.seat_count, 0),
      // A person may hold seats at several concerts now, so holding one booking
      // no longer stops them booking again.
      can_book: Boolean(req.user.whatsapp_verified),
      requires_whatsapp_verification: settings.require_whatsapp_verification,
      allow_self_cancel: settings.allow_user_self_cancel,
    });
  }),
);

router.patch(
  '/me',
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const data = parse(schemas.updateProfileSchema, req.body);

    // Email and date of birth are fixed after registration: one identifies the
    // account, the other is the basis of the age check. Both change only
    // through the church office.
    const updates = [];
    const params = [];
    let whatsappChanged = false;

    for (const field of ['full_name', 'mobile_number', 'address', 'emergency_contact']) {
      if (data[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    if (data.whatsapp_number && data.whatsapp_number !== req.user.whatsapp_number) {
      const taken = await db.queryOne(
        'SELECT id FROM users WHERE whatsapp_number = ? AND id <> ? LIMIT 1',
        [data.whatsapp_number, req.user.id],
      );
      if (taken) throw conflict('That WhatsApp number belongs to another account.', 'DUPLICATE_ACCOUNT');
      updates.push('whatsapp_number = ?', 'whatsapp_verified = 0', 'whatsapp_verified_at = NULL');
      params.push(data.whatsapp_number);
      whatsappChanged = true;
    }

    if (data.mobile_number && data.mobile_number !== req.user.mobile_number) {
      const taken = await db.queryOne(
        'SELECT id FROM users WHERE mobile_number = ? AND id <> ? LIMIT 1',
        [data.mobile_number, req.user.id],
      );
      if (taken) throw conflict('That mobile number belongs to another account.', 'DUPLICATE_ACCOUNT');
    }

    if (!updates.length) throw badRequest('Nothing to update.');

    params.push(req.user.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

    await audit(req, {
      action: 'PROFILE_UPDATED',
      entityType: 'USER',
      entityId: req.user.id,
      metadata: { fields: Object.keys(data), whatsapp_reverification: whatsappChanged },
    });

    let verification = null;
    if (whatsappChanged) {
      const { issueVerificationCode } = require('./auth.routes');
      const sent = await issueVerificationCode(user);
      verification = {
        sent: sent.ok,
        masked_number: maskPhone(user.whatsapp_number),
        message: 'Your WhatsApp number changed, so we sent a new verification code.',
      };
    }

    res.json({ user: publicUser(user), verification });
  }),
);

router.post(
  '/me/change-password',
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const { current_password: current, new_password: next } = parse(
      schemas.changePasswordSchema,
      req.body,
    );

    const row = await db.queryOne('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const ok = await verifyPassword(row.password_hash, current);
    if (!ok) {
      throw badRequest('Your current password is not right.', 'INVALID_CREDENTIALS', {
        current_password: 'Your current password is not right.',
      });
    }
    if (current === next) throw badRequest('Choose a password you have not used here before.');

    const hash = await hashPassword(next);
    await db.query(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [hash, req.user.id],
    );

    await audit(req, { action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: req.user.id });

    // Every other session is now invalid, including this one. Re-issue so the
    // person stays signed in on the device they used.
    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    auth.issueUserSession(res, user);

    res.json({ ok: true, message: 'Password changed. Other devices have been signed out.' });
  }),
);

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

router.post(
  '/bookings',
  auth.requireUser,
  auth.requireVerifiedUser,
  asyncRoute(async (req, res) => {
    const { concert_id: concertId, seat_ids: seatIds, guests } = parse(
      schemas.createBookingSchema,
      req.body,
    );

    // No concert named means the one the booking page defaults to.
    const target = concertId
      ? await bookingService.getConcert(concertId)
      : await bookingService.getDefaultConcert();

    const result = await bookingService.createBooking({
      userId: req.user.id,
      concertId: target.id,
      seatIds,
      guests,
    });

    const seatNumbers = result.seats.map((seat) => seat.seat_number);

    await audit(req, {
      action: 'BOOKING_CREATED',
      entityType: 'BOOKING',
      entityId: result.bookings[0].id,
      metadata: {
        reference: result.reference,
        concert_id: result.concert.id,
        seats: seatNumbers,
        seat_count: seatNumbers.length,
      },
    });

    // Fire the WhatsApp confirmation after the commit. A messaging outage must
    // not undo confirmed seats.
    notifications
      .sendBookingConfirmation(req.user, result.concert, seatNumbers, result.reference)
      .catch((err) => console.error('[bookings] confirmation failed:', err.message));

    // Tell the console, and warn staff if this booking took the concert near
    // capacity. Both are after the commit and neither is awaited: the seats are
    // already the attendee's whatever happens here.
    feed.bookingCreated({
      reference: result.reference,
      userName: req.user.full_name,
      seatNumbers,
      concertId: result.concert.id,
      bookingId: result.bookings[0].id,
    });
    bookingService
      .getAvailability(result.concert)
      .then((availability) =>
        feed.capacityWarning({
          concertId: result.concert.id,
          concertName: result.concert.name,
          percentFull: availability.max_capacity
            ? Math.round((availability.booked_seats / availability.max_capacity) * 100)
            : 0,
          remaining: availability.remaining_capacity,
        }),
      )
      .catch(() => {});

    res.status(201).json({
      booking: {
        booking_reference: result.reference,
        status: 'CONFIRMED',
        seat_count: seatNumbers.length,
        seats: result.seats.map((seat) => ({ id: seat.id, seat_number: seat.seat_number })),
        seat_numbers: seatNumbers,
        booked_at: result.bookings[0].created_at,
        booking_fee: 'FREE',
      },
      concert: publicConcert(result.concert),
      message:
        seatNumbers.length === 1
          ? `Seat ${seatNumbers[0]} is yours. A WhatsApp confirmation is on the way.`
          : `${seatNumbers.length} seats are yours: ${seatNumbers.join(', ')}. A WhatsApp confirmation is on the way.`,
    });
  }),
);

/** Everything this person holds, grouped by reference, across all concerts. */
router.get(
  '/bookings/mine',
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const concertId = req.query.concert_id ? Number(req.query.concert_id) : null;
    const bookings = await bookingService.getUserBookings(req.user.id, { concertId });
    res.json({
      bookings,
      seat_count: bookings.reduce((total, party) => total + party.seat_count, 0),
    });
  }),
);

/**
 * Cancel a whole party by reference, or a single seat with `?seat_id=`.
 * Releasing one seat out of four is a common ask when plans change.
 */
router.delete(
  '/bookings/mine/:reference',
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    if (!settings.allow_user_self_cancel) {
      throw forbidden('Contact the church office to change your booking.', 'SELF_CANCEL_DISABLED');
    }

    const reference = String(req.params.reference).trim();
    const party = await bookingService.getBookingByReference(reference, { userId: req.user.id });
    if (!party) throw notFound('No live booking has that reference.', 'NO_BOOKING');

    const seatId = req.query.seat_id ? Number(req.query.seat_id) : null;
    let released;

    if (seatId) {
      const line = party.seats.find((seat) => seat.seat_id === seatId);
      if (!line) throw notFound('That seat is not part of this booking.', 'SEAT_NOT_IN_BOOKING');

      const result = await bookingService.cancelBooking({
        bookingId: line.booking_id,
        cancelledBy: 'USER',
        userId: req.user.id,
        reason: 'Cancelled by the attendee',
      });
      released = result.seatNumbers;
    } else {
      const result = await bookingService.cancelBookingGroup({
        reference,
        cancelledBy: 'USER',
        userId: req.user.id,
        reason: 'Cancelled by the attendee',
      });
      released = result.seatNumbers;
    }

    await audit(req, {
      action: 'BOOKING_CANCELLED',
      entityType: 'BOOKING',
      entityId: party.seats[0].booking_id,
      metadata: { reference, seats: released, whole_party: !seatId },
    });

    notifications
      .sendBookingCancellation(req.user, party.concert, released, reference)
      .catch(() => {});

    feed.bookingCancelled({
      reference,
      userName: req.user.full_name,
      seatNumbers: released,
      concertId: party.concert.id,
      bookingId: party.seats[0].booking_id,
      reason: 'Cancelled by the attendee',
    });

    const remaining = await bookingService.getBookingByReference(reference);

    res.json({
      ok: true,
      released_seats: released,
      remaining_seats: remaining ? remaining.seats.map((seat) => seat.seat_number) : [],
      message:
        released.length === 1
          ? `Seat ${released[0]} released.`
          : `${released.length} seats released: ${released.join(', ')}.`,
    });
  }),
);

/**
 * Which of the signed-in attendee's parties a printable document is about.
 *
 * `?reference=` picks one; without it, the next concert coming up. The
 * candidates only ever come from this user's own rows, so the parameter cannot
 * be pointed at somebody else's reference.
 */
async function ownParty(req) {
  const parties = await bookingService.getUserBookings(req.user.id);
  if (!parties.length) throw notFound('You have not booked a seat yet.', 'NO_BOOKING');

  const wanted = req.query.reference ? String(req.query.reference).trim() : null;
  const party = wanted ? parties.find((item) => item.booking_reference === wanted) : parties[0];
  if (!party) throw notFound('No live booking has that reference.', 'NO_BOOKING');
  return party;
}

/**
 * Printable confirmation, server-rendered so it works without JavaScript.
 * `?reference=` picks a party; without it, the next concert coming up.
 */
router.get(
  '/bookings/mine/confirmation',
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const party = await ownParty(req);

    // ?print=1 opens the print dialog on load, which is what the "Download PDF"
    // links point at; without it the page is a readable preview.
    res.type('html').send(
      await renderTicket(party, req.user, { autoPrint: req.query.print === '1' }),
    );
  }),
);


module.exports = { router, publicConcert };
