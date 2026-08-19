'use strict';

const db = require('../db');
const whatsapp = require('./whatsapp');
const email = require('./email');

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
async function dispatch({ userId, recipient, type, payload, send, channel = 'WHATSAPP' }) {
  let notificationId = null;
  try {
    notificationId = await record({ userId, recipient, type, payload, channel });
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
    console.error(`[notifications] ${channel} ${type} to ${recipient} failed: ${outcome.error}`);
  }
  return { ok: Boolean(outcome.ok), notificationId, channel, error: outcome.error };
}

/**
 * Send the same message on both channels.
 *
 * Each channel gets its own row in `notifications`, because each can fail on
 * its own — one WhatsApp number that has gone dead should not make the email
 * look undelivered in the console, or the other way round.
 *
 * Both are attempted regardless of the other's outcome, and the result reports
 * each separately. `ok` is true if *either* arrived, which is the question the
 * caller is actually asking: could we reach this person at all?
 */
async function both({ user, type, payload, whatsappSend, emailSend }) {
  const attempts = [];

  if (user.whatsapp_number && whatsappSend) {
    attempts.push(
      dispatch({
        userId: user.id,
        recipient: user.whatsapp_number,
        channel: 'WHATSAPP',
        type,
        payload,
        send: whatsappSend,
      }),
    );
  }
  if (user.email && emailSend) {
    attempts.push(
      dispatch({
        userId: user.id,
        recipient: user.email,
        channel: 'EMAIL',
        type,
        payload,
        send: emailSend,
      }),
    );
  }

  const results = await Promise.all(attempts);
  const byChannel = Object.fromEntries(results.map((r) => [r.channel, r]));
  return {
    ok: results.some((r) => r.ok),
    whatsapp: byChannel.WHATSAPP ?? null,
    email: byChannel.EMAIL ?? null,
  };
}

const sendVerificationCode = (user, code, minutes) =>
  both({
    user,
    type: 'WHATSAPP_VERIFICATION',
    payload: { expires_in_minutes: minutes },
    whatsappSend: () =>
      whatsapp.sendVerificationCode({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        code,
        minutes,
      }),
    emailSend: () =>
      email.sendVerificationCode({
        to: user.email,
        name: firstName(user.full_name),
        code,
        minutes,
      }),
  });

const sendRegistrationWelcome = (user, concert) =>
  both({
    user,
    type: 'REGISTRATION',
    payload: { concert: concert?.name },
    whatsappSend: () =>
      whatsapp.sendRegistrationWelcome({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
      }),
    emailSend: () =>
      email.sendRegistrationWelcome({
        to: user.email,
        name: firstName(user.full_name),
        concert,
      }),
  });

/**
 * Password reset goes by email only, on purpose.
 *
 * A reset link is a bearer credential: whoever opens it can take the account.
 * Email is the address the account is keyed on and the one the person proves
 * they control by using it; a WhatsApp number can be recycled by a carrier or
 * left signed in on a shared phone. Sending it to both would widen the blast
 * radius for no gain.
 */
const sendPasswordReset = (user, link, minutes) =>
  dispatch({
    userId: user.id,
    recipient: user.email,
    channel: 'EMAIL',
    type: 'PASSWORD_RESET',
    payload: { expires_in_minutes: minutes },
    send: () =>
      email.sendPasswordReset({
        to: user.email,
        name: firstName(user.full_name),
        link,
        minutes,
      }),
  });

const sendBookingConfirmation = (user, concert, seatNumber, bookingReference) =>
  both({
    user,
    type: 'BOOKING_CONFIRMATION',
    payload: { seat: seatNumber, booking_reference: bookingReference, concert: concert?.name },
    whatsappSend: () =>
      whatsapp.sendBookingConfirmation({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
    emailSend: () =>
      email.sendBookingConfirmation({
        to: user.email,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
  });

const sendBookingCancellation = (user, concert, seatNumber, bookingReference) =>
  both({
    user,
    type: 'BOOKING_CANCELLATION',
    payload: { seat: seatNumber, booking_reference: bookingReference },
    whatsappSend: () =>
      whatsapp.sendBookingCancellation({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
    emailSend: () =>
      email.sendBookingCancellation({
        to: user.email,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
  });

const sendSeatReassignment = (user, concert, oldSeat, newSeat, bookingReference) =>
  both({
    user,
    type: 'SEAT_REASSIGNMENT',
    payload: { from: oldSeat, to: newSeat, booking_reference: bookingReference },
    whatsappSend: () =>
      whatsapp.sendSeatReassignment({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        oldSeat,
        newSeat,
        bookingReference,
      }),
    emailSend: () =>
      email.sendSeatReassignment({
        to: user.email,
        name: firstName(user.full_name),
        concert,
        oldSeat,
        newSeat,
        bookingReference,
      }),
  });

const sendEventReminder = (user, concert, seatNumber, bookingReference) =>
  both({
    user,
    type: 'EVENT_REMINDER',
    payload: { seat: seatNumber, booking_reference: bookingReference },
    whatsappSend: () =>
      whatsapp.sendEventReminder({
        phone: user.whatsapp_number,
        name: firstName(user.full_name),
        concert,
        seatNumber,
        bookingReference,
      }),
    emailSend: () =>
      email.sendEventReminder({
        to: user.email,
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
  both,
  sendVerificationCode,
  sendPasswordReset,
  sendRegistrationWelcome,
  sendBookingConfirmation,
  sendBookingCancellation,
  sendSeatReassignment,
  sendEventReminder,
  updateDeliveryStatus,
};
