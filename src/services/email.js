'use strict';

const nodemailer = require('nodemailer');
const env = require('../env');
const qr = require('../lib/qr');

/**
 * Email delivery, over Gmail SMTP by default.
 *
 * Deliberately the same shape as services/whatsapp.js: three drivers, one
 * `sendRaw`, a builder per message, and a return of
 * `{ ok, providerMessageId, error }` that never throws. A mail outage must not
 * roll back a booking that is already committed, so callers log the failure and
 * carry on.
 *
 *   gmail — smtp.gmail.com with an App Password
 *   smtp  — any other server, for a church already running one
 *   mock  — prints the message, for local development
 *
 * On Gmail specifically: the password must be a 16-character **App Password**
 * with 2-Step Verification switched on. Google removed plain-password SMTP
 * ("less secure app access") in 2022, so an account password returns
 * 535-5.7.8 and nothing is delivered.
 */

let transport = null;

/**
 * Built once and reused. Nodemailer pools connections, and Gmail is markedly
 * happier with one held connection than with a fresh TLS handshake per message
 * — which matters on the reminder blast, where a few hundred go out in a loop.
 */
function getTransport() {
  if (transport) return transport;

  if (env.email.driver === 'gmail') {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: env.email.user, pass: env.email.password },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    });
  } else {
    transport = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      auth: { user: env.email.user, pass: env.email.password },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    });
  }
  return transport;
}

/** Check the credentials without sending anything. Used by the console. */
async function verifyConnection() {
  if (env.email.driver === 'mock') {
    return { ok: true, driver: 'mock', detail: 'Mock driver: nothing is delivered.' };
  }
  try {
    await getTransport().verify();
    return { ok: true, driver: env.email.driver, detail: `Signed in as ${env.email.user}.` };
  } catch (err) {
    return { ok: false, driver: env.email.driver, error: explain(err) };
  }
}

/**
 * Turn nodemailer's errors into something a person can act on. The raw ones
 * name an SMTP code and nothing else, and "535-5.7.8" tells an administrator
 * nothing about App Passwords.
 */
function explain(err) {
  const raw = String(err?.message || err);
  if (/invalid login|535|BadCredentials/i.test(raw)) {
    return (
      'Gmail rejected the credentials. Use a 16-character App Password from ' +
      'myaccount.google.com/apppasswords (2-Step Verification must be on) — ' +
      'not the account password.'
    );
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
    return `Could not reach the mail server (${raw}). Check SMTP_HOST, SMTP_PORT and that outbound 465/587 is open.`;
  }
  if (/self.signed|unable to verify|certificate/i.test(raw)) {
    return `TLS problem talking to the mail server: ${raw}`;
  }
  return raw.slice(0, 500);
}

async function sendRaw({ to, subject, text, html }) {
  if (env.email.driver === 'mock') {
    console.log(`[email:mock] to ${to} — ${subject}\n${text}\n`);
    return { ok: true, providerMessageId: `mock-${Date.now()}` };
  }

  if (!env.email.user || !env.email.password) {
    return { ok: false, error: 'EMAIL_USER or EMAIL_PASSWORD is not configured.' };
  }

  try {
    const info = await getTransport().sendMail({
      from: `"${env.appName}" <${env.email.from}>`,
      replyTo: env.email.replyTo || undefined,
      to,
      subject,
      text,
      html,
    });
    return { ok: true, providerMessageId: info.messageId || null };
  } catch (err) {
    return { ok: false, error: explain(err) };
  }
}

// ---------------------------------------------------------------------------
// Layout
//
// Table-based and inline-styled on purpose. Email clients are not browsers:
// Outlook ignores flexbox and grid, and Gmail strips <style> blocks in some
// views. The CSP that governs the site does not apply here — nothing in this
// file is ever served as a page.
// ---------------------------------------------------------------------------

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const NAVY = '#1b1e3d';
const ACCENT = '#6d28d9';
// Violet is dark; on the navy masthead it needs the lighter step to stay legible.
const ACCENT_ON_DARK = '#a78bfa';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e6eaf0';

function layout({ heading, intro, body = '', callout = '', footer = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6fa;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6fa;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:${NAVY};padding:24px 32px;">
          <span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.01em;">${esc(env.appName)}</span>
          <span style="display:block;color:${ACCENT_ON_DARK};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;margin-top:2px;">Seat register</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${INK};">${esc(heading)}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3d4757;">${intro}</p>
          ${callout}
          ${body}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid ${LINE};background:#fbfcfd;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">
            ${footer || 'Admission is free. We never ask for card details.'}
          </p>
        </td></tr>
      </table>
      <p style="max-width:560px;margin:16px auto 0;font-size:11px;color:${MUTED};text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Sent by ${esc(env.appName)}. If this was not you, no action is needed.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

const codeBlock = (code) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:18px 28px;text-align:center;">
     <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:0.32em;color:${NAVY};">${esc(code)}</span>
   </td></tr></table>`;

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="background:${ACCENT};border-radius:999px;">
     <a href="${esc(href)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(label)}</a>
   </td></tr></table>`;

const facts = (rows) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${LINE};border-radius:10px;">
     ${rows
       .map(
         ([term, value], i) =>
           `<tr><td style="padding:10px 16px;font-size:13px;color:${MUTED};width:40%;${i ? `border-top:1px solid ${LINE};` : ''}">${esc(term)}</td>
                <td style="padding:10px 16px;font-size:14px;font-weight:600;color:${INK};${i ? `border-top:1px solid ${LINE};` : ''}">${esc(value)}</td></tr>`,
       )
       .join('')}
   </table>`;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function sendVerificationCode({ to, name, code, minutes }) {
  const subject = `${env.appName}: your verification code is ${code}`;
  const text =
    `Hello ${name},\n\nYour ${env.appName} verification code is ${code}. ` +
    `It expires in ${minutes} minutes.\n\nEnter it on the website to confirm your contact details ` +
    `and finish setting up your seat booking.\n\nIf you did not request this, ignore this email.`;

  const html = layout({
    heading: 'Your verification code',
    intro: `Hello ${esc(name)}, enter this code on the website to confirm your details. It expires in <strong>${minutes} minutes</strong>.`,
    callout: codeBlock(code),
    body: `<p style="margin:0;font-size:14px;line-height:1.6;color:${MUTED};">The same code has been sent to your WhatsApp number. Either copy works — you only need to enter it once.</p>`,
    footer: 'If you did not ask to register, you can ignore this email and nothing will happen.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

async function sendRegistrationWelcome({ to, name, concert }) {
  const subject = `Welcome to ${env.appName}`;
  const text =
    `Hello ${name},\n\nYour ${env.appName} account is ready.` +
    (concert ? `\n\nNext up: ${concert.name} at ${concert.venue}.` : '') +
    `\n\nOnce your number is verified you can choose your seats. Admission is free — there is ` +
    `nothing to pay, and nobody will ever ask you for card details.\n\n${env.appUrl}`;

  const html = layout({
    heading: `Welcome, ${esc(name)}`,
    intro: 'Your account is ready. Verify your contact details and you can pick your seats.',
    callout: button(`${env.appUrl}/seats.html`, 'Choose your seats'),
    body: concert
      ? facts([
          ['Concert', concert.name],
          ['Venue', concert.venue],
          ['Admission', 'Free'],
        ])
      : '',
    footer: 'Admission is free. Nobody will ever ask you for card details on this site.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

async function sendPasswordReset({ to, name, link, minutes }) {
  const subject = `${env.appName}: reset your password`;
  const text =
    `Hello ${name},\n\nUse this link to set a new ${env.appName} password. ` +
    `It expires in ${minutes} minutes and can only be used once.\n\n${link}\n\n` +
    `If you did not ask to reset your password, ignore this email — your current password ` +
    `still works and nothing has changed.`;

  const html = layout({
    heading: 'Reset your password',
    intro: `Hello ${esc(name)}, use the button below to set a new password. The link expires in <strong>${minutes} minutes</strong> and works once.`,
    callout: button(link, 'Set a new password'),
    body: `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED};">If the button does not work, paste this into your browser:</p>
           <p style="margin:0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(link)}" style="color:${NAVY};">${esc(link)}</a></p>`,
    footer:
      'If you did not ask for this, ignore the email. Your current password still works and nothing has changed.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

/**
 * The ticket QR, as a PNG data URI.
 *
 * PNG rather than the SVG the printed ticket uses: Gmail and Outlook strip
 * inline SVG, and a remote <img> would be blocked by most clients' image
 * blocking on the way in. A data URI survives both, and costs about 2 KB.
 */
const qrBlock = (png, checkIn) =>
  png
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr>
         <td style="padding:16px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;text-align:center;">
           <img src="${png}" width="150" height="150" alt="QR code for booking ${esc(checkIn)}"
                style="display:block;width:150px;height:150px;image-rendering:pixelated;" />
           <p style="margin:10px 0 0;font-size:11px;color:${MUTED};">Show this at the door</p>
         </td></tr></table>`
    : '';

const seatWords = (seatNumber) => {
  const seats = Array.isArray(seatNumber) ? seatNumber : [seatNumber];
  return { seats, label: seats.length === 1 ? 'Seat' : `Seats (${seats.length})`, list: seats.join(', ') };
};

async function sendBookingConfirmation({ to, name, concert, seatNumber, bookingReference }) {
  const { label, list, seats } = seatWords(seatNumber);
  const subject = `${env.appName}: ${bookingReference} — your ${seats.length === 1 ? 'seat is' : 'seats are'} reserved`;
  const ticketUrl = `${env.appUrl}/api/bookings/mine/confirmation?reference=${encodeURIComponent(bookingReference)}`;

  const text =
    `Hello ${name},\n\nYour booking is confirmed.\n\n` +
    `Reference: ${bookingReference}\n${label}: ${list}\n` +
    (concert ? `Concert: ${concert.name}\nVenue: ${concert.venue}\n` : '') +
    `Booking fee: FREE\n\nShow the reference at the door and arrive 20 minutes early.\n\n` +
    `Your printable ticket, with a QR code: ${ticketUrl}`;

  const [png] = await Promise.all([qr.ticketPng(bookingReference, { width: 300 })]);

  const html = layout({
    heading: seats.length === 1 ? 'Your seat is reserved' : `Your ${seats.length} seats are reserved`,
    intro: `Hello ${esc(name)}, show this reference at the door. Everyone in your party comes in under it.`,
    callout: codeBlock(bookingReference) + qrBlock(png, bookingReference),
    body:
      facts(
        [
          concert ? ['Concert', concert.name] : null,
          concert ? ['Venue', concert.venue] : null,
          [label, list],
          ['Booking fee', 'FREE'],
        ].filter(Boolean),
      ) + button(`${ticketUrl}&print=1`, 'Download your ticket (PDF)'),
    footer: 'Arrive 20 minutes early so stewards can seat you without rushing.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

async function sendBookingCancellation({ to, name, concert, seatNumber, bookingReference }) {
  const { label, list } = seatWords(seatNumber);
  const subject = `${env.appName}: ${bookingReference} cancelled`;
  const text =
    `Hello ${name},\n\nYour booking ${bookingReference} has been cancelled and ${list} released.\n\n` +
    (concert ? `Concert: ${concert.name}\n` : '') +
    `\nIf this was not you, book again at ${env.appUrl}/seats.html while seats last.`;

  const html = layout({
    heading: 'Your booking has been cancelled',
    intro: `Hello ${esc(name)}, booking <strong>${esc(bookingReference)}</strong> has been cancelled and the ${label.toLowerCase()} released.`,
    body:
      facts([concert ? ['Concert', concert.name] : null, [label, list]].filter(Boolean)) +
      button(`${env.appUrl}/seats.html`, 'Book again'),
    footer: 'If you did not cancel this, book again while seats last.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

async function sendEventReminder({ to, name, concert, seatNumber, bookingReference }) {
  const { label, list } = seatWords(seatNumber);
  const subject = `${env.appName}: ${concert?.name || 'your concert'} is coming up`;
  const text =
    `Hello ${name},\n\n${concert?.name || 'Your concert'} is coming up.\n\n` +
    `Reference: ${bookingReference}\n${label}: ${list}\n` +
    (concert ? `Venue: ${concert.venue}\n` : '') +
    `\nArrive 20 minutes early and show your reference at the door.`;

  const png = await qr.ticketPng(bookingReference, { width: 300 });

  const html = layout({
    heading: `${esc(concert?.name || 'Your concert')} is coming up`,
    intro: `Hello ${esc(name)}, here is your reference again so you have it to hand.`,
    callout: codeBlock(bookingReference) + qrBlock(png, bookingReference),
    body: facts(
      [concert ? ['Venue', concert.venue] : null, [label, list], ['Admission', 'Free']].filter(Boolean),
    ),
    footer: 'Arrive 20 minutes early so stewards can seat you without rushing.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

async function sendSeatReassignment({ to, name, concert, oldSeat, newSeat, bookingReference }) {
  const subject = `${env.appName}: your seat has moved to ${newSeat}`;
  const text =
    `Hello ${name},\n\nYour seat for ${concert?.name || 'the concert'} has been moved from ` +
    `${oldSeat} to ${newSeat}. Your reference ${bookingReference} is unchanged.`;

  const html = layout({
    heading: 'Your seat has moved',
    intro: `Hello ${esc(name)}, we have had to move your seat. Your reference is unchanged.`,
    body: facts([
      concert ? ['Concert', concert.name] : null,
      ['Was', oldSeat],
      ['Now', newSeat],
      ['Reference', bookingReference],
    ].filter(Boolean)),
    footer: 'Sorry for the change — show the same reference at the door.',
  });

  const result = await sendRaw({ to, subject, text, html });
  return { ...result, body: text };
}

module.exports = {
  sendRaw,
  verifyConnection,
  sendVerificationCode,
  sendRegistrationWelcome,
  sendPasswordReset,
  sendBookingConfirmation,
  sendBookingCancellation,
  sendEventReminder,
  sendSeatReassignment,
};
