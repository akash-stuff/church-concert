'use strict';

const db = require('../db');
const whatsapp = require('./whatsapp');

/**
 * Every outbound message is written to `notifications` before it is sent and
 * updated afterwards, so the admin dashboard shows an accurate history
 * including failures. Sending never throws.
 */
async function record({ userId, recipient, type, channel = 'WHATSAPP', payload = null }) {
  const result = await db.query(
    `INSERT INTO notifications (user_id, recipient, channel, type, payload, status)
     VALUES (?, ?, ?, ?, ?, 'QUEUED')`,
    [userId ?? null, recipient, channel, type, payload ? JSON.stringify(payload) : null],
  );
  return result.insertId;
}

async function markSent(id, { body, providerMessageId }) {
  await db.query(
    `UPDATE notifications
        SET status = 'SENT', body = ?, provider_message_id = ?, sent_at = NOW(), failure_reason = NULL
      WHERE id = ?`,
    [body ?? null, providerMessageId ?? null, id],
  );
}

async function markFailed(id, { body, reason }) {
  await db.query(
    `UPDATE notifications SET status = 'FAILED', body = ?, failure_reason = ? WHERE id = ?`,
    [body ?? null, String(reason ?? 'Unknown error').slice(0, 500), id],
  );
}

/** Runs a sender, logging the outcome. Returns { ok, notificationId }. */
async function dispatch({ userId, recipient, type, payload, send }) {
  let notificationId = null;
  try {
    notificationId = await record({ userId, recipient, type, payload });
  } catch (err) {
    console.error('[notifications] could not record notification:', err.message);
  }

  let outcome;
  try {
    outcome = await send();
  } catch (err) {
    outcome = { ok: false, error: err.message };
  }

  if (notificationId) {
    try {
      if (outcome.ok) {
        await markSent(notificationId, {
          body: outcome.body,
          providerMessageId: outcome.providerMessageId,
        });
      } else {
        await markFailed(notificationId, { body: outcome.body, reason: outcome.error });
      }
    } catch (err) {
      console.error('[notifications] could not update notification:', err.message);
    }
  }

  if (!outcome.ok) {
    console.error(`[notifications] ${type} to ${recipient} failed: ${outcome.error}`);
  }
  return { ok: Boolean(outcome.ok), notificationId };
}

const sendVerificationCode = (user, code, minutes) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'WHATSAPP_VERIFICATION',
    payload: { expires_in_minutes: minutes },
    send: () =>
      whatsapp.sendVerificationCode({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        code,
        minutes,
      }),
  });

const sendRegistrationWelcome = (user, concert) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'REGISTRATION',
    payload: { concert: concert?.name },
    send: () =>
      whatsapp.sendRegistrationWelcome({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
      }),
  });

const sendBookingConfirmation = (user, concert, seatNumber, bookingReference) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'BOOKING_CONFIRMATION',
    payload: { seat: seatNumber, booking_reference: bookingReference, concert: concert?.name },
    send: () =>
      whatsapp.sendBookingConfirmation({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
  });

const sendBookingCancellation = (user, concert, seatNumber, bookingReference) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'BOOKING_CANCELLATION',
    payload: { seat: seatNumber, booking_reference: bookingReference },
    send: () =>
      whatsapp.sendBookingCancellation({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
  });

const sendSeatReassignment = (user, concert, oldSeat, newSeat, bookingReference) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'SEAT_REASSIGNMENT',
    payload: { from: oldSeat, to: newSeat, booking_reference: bookingReference },
    send: () =>
      whatsapp.sendSeatReassignment({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        oldSeat,
        newSeat,
        bookingReference,
      }),
  });

const sendEventReminder = (user, concert, seatNumber, bookingReference) =>
  dispatch({
    userId: user.id,
    recipient: user.whatsapp_number,
    type: 'EVENT_REMINDER',
    payload: { seat: seatNumber, booking_reference: bookingReference },
    send: () =>
      whatsapp.sendEventReminder({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
  });

/** Called from the delivery-status webhook. */
async function updateDeliveryStatus(providerMessageId, status, failureReason) {
  const map = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
  const mapped = map[String(status).toLowerCase()];
  if (!mapped || !providerMessageId) return;
  await db.query(
    `UPDATE notifications
        SET status = ?, failure_reason = COALESCE(?, failure_reason)
      WHERE provider_message_id = ?`,
    [mapped, failureReason ? String(failureReason).slice(0, 500) : null, providerMessageId],
  );
}

const firstName = (fullName) => String(fullName || '').trim().split(/\s+/)[0] || 'friend';

module.exports = {
  record,
  markSent,
  markFailed,
  dispatch,
  sendVerificationCode,
  sendRegistrationWelcome,
  sendBookingConfirmation,
  sendBookingCancellation,
  sendSeatReassignment,
  sendEventReminder,
  updateDeliveryStatus,
};
