'use strict';

/**
 * The management console's own notification feed.
 *
 * Distinct from services/notifications.js, which is the outbound WhatsApp and
 * email log addressed to attendees. This one is addressed to staff: things they
 * should notice when they next open the console.
 *
 * Every emit here is best-effort. A feed entry failing must never fail the
 * booking that produced it, so `emit` swallows its own errors and logs them;
 * callers are not expected to await it for correctness.
 */

const db = require('../db');

const CATEGORIES = ['BOOKING', 'TICKET', 'CONCERT', 'SYSTEM'];

/**
 * Write one entry. Returns the new id, or null if the write failed — see the
 * note above about this never being allowed to break the caller.
 */
async function emit({
  category,
  title,
  body = null,
  entityType = null,
  entityId = null,
  concertId = null,
  severity = 'INFO',
}) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Unknown console-feed category: ${category}`);
  }
  try {
    const result = await db.query(
      `INSERT INTO admin_notifications
         (category, title, body, entity_type, entity_id, concert_id, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [category, title, body, entityType, entityId, concertId, severity],
    );
    return result.insertId ?? null;
  } catch (error) {
    console.error('[console-feed] could not record notification:', error.message);
    return null;
  }
}

/** A party has booked. One entry per booking reference, not per seat. */
function bookingCreated({ reference, userName, seatNumbers, concertId, bookingId, byStaff = false }) {
  const seats = Array.isArray(seatNumbers) ? seatNumbers : [seatNumbers];
  const count = seats.length;
  return emit({
    category: 'BOOKING',
    title: `New booking ${reference}`,
    body: `${userName} reserved ${count} ${count === 1 ? 'seat' : 'seats'} (${seats.join(', ')})${
      byStaff ? ' — created by staff' : ''
    }`,
    entityType: 'BOOKING',
    entityId: bookingId,
    concertId,
    severity: 'SUCCESS',
  });
}

/** A party has been cancelled, by whoever. */
function bookingCancelled({ reference, userName, seatNumbers, concertId, bookingId, reason }) {
  const seats = Array.isArray(seatNumbers) ? seatNumbers : [seatNumbers];
  return emit({
    category: 'BOOKING',
    title: `Booking ${reference} cancelled`,
    body: `${userName} released ${seats.length} ${seats.length === 1 ? 'seat' : 'seats'}${
      reason ? ` — ${reason}` : ''
    }`,
    entityType: 'BOOKING',
    entityId: bookingId,
    concertId,
    severity: 'WARNING',
  });
}

/**
 * Capacity warning, raised once per threshold rather than on every booking.
 * Without the de-duplication the feed would fill with the same warning as the
 * last few seats went, which is exactly when staff need to read it.
 */
async function capacityWarning({ concertId, concertName, percentFull, remaining }) {
  const threshold = percentFull >= 95 ? 95 : percentFull >= 80 ? 80 : null;
  if (threshold === null) return null;

  const existing = await db.queryOne(
    `SELECT id FROM admin_notifications
      WHERE concert_id = ? AND category = 'CONCERT' AND entity_type = ?
      LIMIT 1`,
    [concertId, `CAPACITY_${threshold}`],
  );
  if (existing) return null;

  return emit({
    category: 'CONCERT',
    title: `${concertName} is ${threshold}% full`,
    body: `${remaining} ${remaining === 1 ? 'seat remains' : 'seats remain'}. Consider opening another section or closing bookings.`,
    entityType: `CAPACITY_${threshold}`,
    concertId,
    severity: 'WARNING',
  });
}

function concertUpdated({ concertId, concertName, what }) {
  return emit({
    category: 'CONCERT',
    title: `${concertName} updated`,
    body: what,
    entityType: 'CONCERT',
    entityId: concertId,
    concertId,
    severity: 'INFO',
  });
}

function ticketIssued({ reference, userName, concertId, bookingId }) {
  return emit({
    category: 'TICKET',
    title: `Ticket generated for ${reference}`,
    body: `${userName}'s confirmation is ready to download and has been queued for WhatsApp.`,
    entityType: 'BOOKING',
    entityId: bookingId,
    concertId,
    severity: 'SUCCESS',
  });
}

function deliveryFailed({ recipient, kind, reason }) {
  return emit({
    category: 'SYSTEM',
    title: `${kind} delivery failed`,
    body: `Could not reach ${recipient}${reason ? ` — ${reason}` : ''}`,
    entityType: 'NOTIFICATION',
    severity: 'WARNING',
  });
}

module.exports = {
  CATEGORIES,
  emit,
  bookingCreated,
  bookingCancelled,
  capacityWarning,
  concertUpdated,
  ticketIssued,
  deliveryFailed,
};
