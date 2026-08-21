'use strict';

/**
 * The printable seat confirmation — the thing people bring to the door.
 *
 * Server-rendered so it works with JavaScript off, and shared by two routes
 * that reach it very differently: an attendee fetching their own
 * (/api/bookings/mine/confirmation) and staff fetching anyone's
 * (/api/admin/bookings/:reference/ticket). Only the authorisation differs, so
 * only the authorisation lives in the routes; the document lives here.
 *
 * The layout and print rules are in /css/ticket.css, deliberately a served file
 * rather than a <style> block. The CSP is style-src 'self' with no
 * 'unsafe-inline' (src/app.js), so an embedded block is dropped by the browser
 * and the ticket arrives with no styling at all — which is exactly what used to
 * happen. Anything visual this page needs has to be reachable as a file.
 *
 * The QR is inline SVG so the printer resamples it rather than scaling screen
 * pixels. A soft QR is a QR that will not scan.
 */

const env = require('../env');
const whatsapp = require('../services/whatsapp');
const qr = require('./qr');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** The document head every printable page shares. */
function head(title) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/ticket.css">`;
}

/**
 * `party` is the shape bookingService.getUserBookings returns: a reference, a
 * concert, and the seats under it. `holder` is whose name goes on the ticket.
 *
 * Async because the QR is generated here rather than fetched from an image
 * service — nothing about this document requires a network round trip.
 */
async function renderTicket(party, holder, { autoPrint = false } = {}) {
  const seatCount = party.seats.length;
  /* The guest's name goes on the chip when it is somebody other than the
     booker. On a single-seat booking that is the booker themselves and repeating
     their name under their own seat is just noise, so it is left off. */
  const namedGuests = party.seats.some(
    (seat) => seat.guest_name && seat.guest_name !== holder.full_name,
  );

  const seatList = party.seats
    .map(
      (seat) =>
        `<span class="seat"><b>${esc(seat.seat_number)}</b><i>${esc(seat.section_name)}</i>${
          namedGuests && seat.guest_name ? `<u>${esc(seat.guest_name)}</u>` : ''
        }</span>`,
    )
    .join('');

  const qrSvg = await qr.ticketSvg(party.booking_reference);
  const checkIn = qr.checkInUrl(party.booking_reference);

  return `<!doctype html>
<html lang="en">
<head>
${head(`Ticket ${party.booking_reference} — ${party.concert.name}`)}
</head>
<body>

<article class="sheet">
  <header class="hero">
    <img class="hero__art" src="/assets/ticket-banner.svg" alt="" width="1200" height="300" />
    <div class="hero__veil"></div>
    <p class="hero__org">${esc(env.appName)} &middot; Seat confirmation</p>
    <h1 class="hero__event">${esc(party.concert.name)}</h1>
    <p class="hero__when">
      ${esc(whatsapp.formatDate(party.concert.event_date))}
      &middot; ${esc(whatsapp.formatTime(party.concert.start_time))}
      &middot; ${esc(party.concert.venue)}
    </p>
  </header>

  <section class="claim">
    <div class="claim__left">
      <p class="claim__label">Booking reference</p>
      <p class="claim__ref">${esc(party.booking_reference)}</p>
      <p class="claim__name">${esc(holder.full_name)}</p>
      <div class="claim__badges">
        <span class="badge badge--accent">Admission free</span>
        <span class="badge badge--quiet">${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}</span>
        <span class="badge badge--quiet">${esc(party.status)}</span>
      </div>
    </div>
    <div class="qr">
      <div class="qr__frame">${qrSvg || ''}</div>
      <p class="qr__hint">Stewards scan this at the door</p>
    </div>
  </section>

  <section class="facts">
    <dl class="facts__grid">
      <div class="fact">
        <dt>Date</dt>
        <dd>${esc(whatsapp.formatDate(party.concert.event_date))}</dd>
      </div>
      <div class="fact">
        <dt>Doors / start</dt>
        <dd>${esc(whatsapp.formatTime(party.concert.start_time))}${
          party.concert.end_time
            ? ` &ndash; ${esc(whatsapp.formatTime(party.concert.end_time))}`
            : ''
        }</dd>
      </div>
      <div class="fact">
        <dt>Booking fee</dt>
        <dd>FREE</dd>
      </div>
      <div class="fact fact--wide">
        <dt>Venue</dt>
        <dd>${esc(party.concert.venue)}${
          party.concert.address
            ? `<span class="sub">${esc(party.concert.address)}</span>`
            : ''
        }</dd>
      </div>
      <div class="fact fact--wide">
        <dt>${seatCount === 1 ? 'Your seat' : `Your seats (${seatCount})`}</dt>
        <dd><span class="seats">${seatList}</span></dd>
      </div>
    </dl>
  </section>

  <section class="notes">
    <img class="notes__crest" src="/assets/ticket-crest.svg" alt="" width="54" height="54" />
    <ul class="notes__list">
      <li>Arrive <strong>20 minutes early</strong> so stewards can seat you without rushing.</li>
      <li>Show this reference at the door &mdash; on paper or on your phone, either is fine.</li>
      <li>Admission is free. Nobody will ask you for payment or card details.</li>
      ${
        seatCount > 1
          ? `<li>Everybody in the party is named on this ticket. Whoever arrives first can be checked in; stewards issue a wristband to each guest at the door.</li>`
          : ''
      }
      <li>If you can no longer come, release your seats from your dashboard so somebody else can have them.</li>
    </ul>
  </section>

  <footer class="foot">
    <span>${esc(env.appName)} &middot; booked ${esc(
      whatsapp.formatDate(party.booked_at || party.concert.event_date),
    )}</span>
    <span>Check in: <code>${esc(checkIn)}</code></span>
  </footer>
</article>

<div class="actions">
  <button class="btn btn--primary" type="button" data-print>Download as PDF</button>
  <a class="btn btn--ghost" href="${esc(env.appUrl)}/dashboard.html">My bookings</a>
  <span class="actions__hint">Choose &ldquo;Save as PDF&rdquo; as the destination in the print dialog.</span>
</div>

<!-- The button's behaviour is in /js/print.js, not an onclick attribute: the
     CSP sets script-src 'self' with no 'unsafe-inline', so an inline handler
     would be dropped and the button would do nothing. -->
<script src="/js/print.js"${autoPrint ? ' data-auto-print' : ''}></script>
</body></html>`;
}

module.exports = { renderTicket, esc, head };
