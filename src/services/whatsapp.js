'use strict';

const env = require('../env');

/**
 * WhatsApp Business Cloud API (Meta) client.
 *
 * Credentials come from the environment only — never from source. Two drivers:
 *   meta  — real HTTP calls to the Graph API
 *   mock  — logs the message and returns a fake id, for local development
 *
 * Returns { ok, providerMessageId, error } and never throws, so a delivery
 * failure cannot roll back a booking that has already been committed.
 */

async function sendRaw(payload) {
  if (env.whatsapp.driver === 'mock') {
    console.log('[whatsapp:mock] would send ->', JSON.stringify(payload));
    return { ok: true, providerMessageId: `mock-${Date.now()}` };
  }

  if (!env.whatsapp.accessToken || !env.whatsapp.phoneNumberId) {
    return {
      ok: false,
      error: 'WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not configured.',
    };
  }

  const url = `${env.whatsapp.apiUrl}/${env.whatsapp.phoneNumberId}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message || `WhatsApp API responded ${response.status} ${response.statusText}`;
      return { ok: false, error: message.slice(0, 500) };
    }

    return { ok: true, providerMessageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'WhatsApp API request timed out.' : err.message;
    return { ok: false, error: String(reason).slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Graph API wants the number without the leading +. */
const toRecipient = (phone) => String(phone).replace(/^\+/, '');

function textMessage(phone, body) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toRecipient(phone),
    type: 'text',
    text: { preview_url: false, body },
  };
}

function templateMessage(phone, templateName, parameters, languageCode = 'en') {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toRecipient(phone),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: parameters.map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  };
}

/**
 * Outside a 24-hour customer service window WhatsApp only permits approved
 * templates, so a template name is used when one is configured and plain text
 * is the fallback for development.
 */
async function sendVerificationCode({ phone, name, code, minutes }) {
  const body =
    `Hello ${name}, your ${env.appName} verification code is ${code}. ` +
    `It expires in ${minutes} minutes. Reply with this code, or enter it on the website, ` +
    `to authorise WhatsApp updates about your seat. If you did not request this, ignore this message.`;

  const payload = env.whatsapp.templateVerification
    ? templateMessage(phone, env.whatsapp.templateVerification, [name, code, String(minutes)])
    : textMessage(phone, body);

  const result = await sendRaw(payload);
  return { ...result, body };
}

/**
 * `seatNumber` may be one seat or a list. A party of four gets one message
 * listing all four seats under a single reference, not four separate messages.
 */
function seatWords(seatNumber) {
  const seats = Array.isArray(seatNumber) ? seatNumber : [seatNumber];
  return {
    seats,
    label: seats.length === 1 ? 'Seat' : `Seats (${seats.length})`,
    list: seats.join(', '),
  };
}

async function sendBookingConfirmation({ phone, name, concert, seatNumber, bookingReference }) {
  const { seats, label, list } = seatWords(seatNumber);
  const body =
    `Booking confirmed. ${name}, ${seats.length === 1 ? 'your seat' : `your ${seats.length} seats`} for ${concert.name} ${seats.length === 1 ? 'is' : 'are'} reserved.\n\n` +
    `Date: ${formatDate(concert.event_date)}\n` +
    `Time: ${formatTime(concert.start_time)}\n` +
    `Venue: ${concert.venue}\n` +
    `${label}: ${list}\n` +
    `Booking reference: ${bookingReference}\n\n` +
    `Admission is free. Please arrive 20 minutes early and show this reference at the door.`;

  const payload = env.whatsapp.templateBooking
    ? templateMessage(phone, env.whatsapp.templateBooking, [
        name,
        concert.name,
        formatDate(concert.event_date),
        concert.venue,
        list,
        bookingReference,
      ])
    : textMessage(phone, body);

  const result = await sendRaw(payload);
  return { ...result, body };
}

async function sendBookingCancellation({ phone, name, concert, seatNumber, bookingReference }) {
  const { seats, list } = seatWords(seatNumber);
  const body =
    `${name}, your booking for ${concert.name} has been cancelled.\n\n` +
    `${seats.length === 1 ? 'Seat' : 'Seats'} released: ${list}\n` +
    `Booking reference: ${bookingReference}\n\n` +
    `If this was not you, sign in to the website or contact the church office.`;
  const result = await sendRaw(textMessage(phone, body));
  return { ...result, body };
}

async function sendSeatReassignment({ phone, name, concert, oldSeat, newSeat, bookingReference }) {
  const body =
    `${name}, your seat for ${concert.name} has been moved from ${oldSeat} to ${newSeat}.\n\n` +
    `Booking reference: ${bookingReference}\n` +
    `Date: ${formatDate(concert.event_date)} at ${formatTime(concert.start_time)}\n` +
    `Venue: ${concert.venue}`;
  const result = await sendRaw(textMessage(phone, body));
  return { ...result, body };
}

async function sendRegistrationWelcome({ phone, name, concert }) {
  const body =
    `Welcome ${name}. You are registered for ${concert.name} on ` +
    `${formatDate(concert.event_date)} at ${concert.venue}. ` +
    `Verify this WhatsApp number, then choose your seat on the website. Admission is free.`;
  const result = await sendRaw(textMessage(phone, body));
  return { ...result, body };
}

async function sendEventReminder({ phone, name, concert, seatNumber, bookingReference }) {
  const { seats, list } = seatWords(seatNumber);
  const body =
    `Reminder: ${concert.name} is on ${formatDate(concert.event_date)} at ` +
    `${formatTime(concert.start_time)}, ${concert.venue}.\n\n` +
    `${name}, ${seats.length === 1 ? `your seat is ${list}` : `your ${seats.length} seats are ${list}`} ` +
    `(reference ${bookingReference}). See you there.`;
  const result = await sendRaw(textMessage(phone, body));
  return { ...result, body };
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTime(value) {
  if (!value) return '';
  const [h, m] = String(value).split(':');
  const hour = Number(h);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}.${m ?? '00'} ${suffix}`;
}

module.exports = {
  sendRaw,
  textMessage,
  sendVerificationCode,
  sendBookingConfirmation,
  sendBookingCancellation,
  sendSeatReassignment,
  sendRegistrationWelcome,
  sendEventReminder,
  formatDate,
  formatTime,
};
