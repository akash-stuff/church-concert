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
 * It is laid out for A4 and for print rather than for a screen, because that is
 * where it ends up. Three consequences run through the whole file:
 *
 *   * Artwork is in <img> tags, never CSS backgrounds. Browsers do not print
 *     background images unless the person ticks "Background graphics", and a
 *     ticket that loses its branding on the way to the printer is no good.
 *   * Colour survives via print-color-adjust: exact. Without it the navy header
 *     prints as white and the gold rules vanish.
 *   * The QR is inline SVG, so it is resampled by the printer rather than
 *     scaled from screen pixels. A soft QR is a QR that will not scan.
 */

const env = require('../env');
const whatsapp = require('../services/whatsapp');
const qr = require('./qr');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const NAVY = '#16233d';
const NAVY_DEEP = '#0d1729';
const GOLD = '#b58328';
const GOLD_LIGHT = '#e0ac4c';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#d8dee8';

/**
 * One tear-off stub per seat, so a party arriving separately can split the
 * ticket up. Every stub carries the same reference — a reference covers the
 * whole party by design — but names its own seat, which is what a steward
 * actually needs to point at a chair.
 */
function stubs(party) {
  if (party.seats.length < 2) return '';

  return `
  <section class="stubs">
    <p class="stubs__lede">
      <strong>Arriving separately?</strong> Cut along the dotted line and take one strip each.
      Every strip carries the same reference, so any of them gets that person in.
    </p>
    <div class="stubs__row">
      ${party.seats
        .map(
          (seat) => `
        <div class="stub">
          <span class="stub__seat">${esc(seat.seat_number)}</span>
          <span class="stub__section">${esc(seat.section_name)}</span>
          <span class="stub__ref">${esc(party.booking_reference)}</span>
          <span class="stub__event">${esc(party.concert.name)}</span>
        </div>`,
        )
        .join('')}
    </div>
  </section>`;
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
  const seatList = party.seats
    .map(
      (seat) =>
        `<span class="seat"><b>${esc(seat.seat_number)}</b><i>${esc(seat.section_name)}</i></span>`,
    )
    .join('');

  const qrSvg = await qr.ticketSvg(party.booking_reference);
  const checkIn = qr.checkInUrl(party.booking_reference);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket ${esc(party.booking_reference)} — ${esc(party.concert.name)}</title>
<style>
  /* --- Page ------------------------------------------------------------- */
  @page { size: A4; margin: 12mm; }

  *, *::before, *::after { box-sizing: border-box; }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body {
    margin: 0;
    padding: 24px 16px 48px;
    background: #eef1f6;
    color: ${INK};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.55;
  }

  .sheet {
    max-width: 186mm;
    margin: 0 auto;
    background: #fff;
    border: 1px solid ${LINE};
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 20px 44px -28px rgba(15, 23, 42, .4);
  }

  /* --- Masthead over the church artwork --------------------------------- */
  .hero { position: relative; }
  .hero__art {
    display: block;
    width: 100%;
    height: 132px;
    object-fit: cover;
  }
  /* Dark enough on the left for the type to hold up, clear enough on the right
     that the church actually shows. A flat scrim hides the artwork entirely,
     which rather defeats having it. */
  .hero__veil {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, ${NAVY_DEEP} 0%, rgba(13,23,41,.86) 34%, rgba(13,23,41,.45) 62%, rgba(13,23,41,.12) 100%);
  }
  .hero__text {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 26px;
    color: #fff;
  }
  .hero__org {
    font-size: 10px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase;
    color: ${GOLD_LIGHT}; margin: 0 0 4px;
  }
  .hero__event { margin: 0; font-size: 25px; line-height: 1.18; letter-spacing: -.02em; }
  .hero__when { margin: 6px 0 0; font-size: 12px; color: rgba(255,255,255,.82); }

  /* --- The claim strip: reference and QR side by side ------------------- */
  .claim {
    display: flex; align-items: center; gap: 26px;
    padding: 24px 26px;
    border-bottom: 2px solid ${GOLD};
    background: linear-gradient(180deg, #fdf9f0 0%, #fff 100%);
  }
  .claim__left { flex: 1 1 auto; min-width: 0; }
  .claim__label {
    margin: 0 0 6px;
    font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
    color: ${MUTED};
  }
  .claim__ref {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 30px; font-weight: 700; letter-spacing: .05em; color: ${NAVY};
    word-break: break-all;
  }
  .claim__name { margin: 8px 0 0; font-size: 15px; font-weight: 600; }
  .claim__free {
    display: inline-block; margin-top: 10px;
    padding: 3px 10px; border-radius: 999px;
    background: ${GOLD}; color: #fff;
    font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  }

  .qr { flex: none; text-align: center; }
  /* 32mm is comfortably above the ~20mm most phone cameras need at arm's
     length, with the quiet zone supplied by the white padding rather than by
     the code's own margin. */
  .qr__frame {
    width: 32mm; height: 32mm;
    padding: 3mm;
    background: #fff;
    border: 1px solid ${LINE};
    border-radius: 8px;
  }
  .qr__frame svg { display: block; width: 100%; height: 100%; }
  .qr__hint {
    margin: 6px 0 0; width: 38mm;
    font-size: 8.5px; line-height: 1.35; color: ${MUTED};
  }

  /* --- Facts ------------------------------------------------------------ */
  .facts { padding: 22px 26px 6px; }
  .facts__grid {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 26px; margin: 0;
  }
  .fact { margin: 0; padding-bottom: 12px; border-bottom: 1px solid ${LINE}; }
  .fact--wide { grid-column: 1 / -1; }
  .fact dt {
    font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
    color: ${MUTED}; margin-bottom: 3px;
  }
  .fact dd { margin: 0; font-size: 14.5px; font-weight: 600; }

  .seats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
  .seat {
    display: inline-flex; flex-direction: column; align-items: center;
    min-width: 54px; padding: 6px 10px;
    border: 1.5px solid ${NAVY}; border-radius: 8px 8px 5px 5px;
    background: #f6f8fc;
  }
  .seat b {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px; color: ${NAVY}; letter-spacing: .02em;
  }
  .seat i { font-style: normal; font-size: 8.5px; color: ${MUTED}; }

  /* --- On the night ----------------------------------------------------- */
  .notes { display: flex; gap: 18px; align-items: flex-start; padding: 18px 26px 22px; }
  .notes__crest { flex: none; width: 54px; height: 54px; opacity: .9; }
  .notes__list { margin: 0; padding-left: 18px; font-size: 12px; color: #3d4757; }
  .notes__list li { margin-bottom: 4px; }

  .foot {
    padding: 14px 26px;
    border-top: 1px solid ${LINE};
    background: #fbfcfd;
    display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    font-size: 10px; color: ${MUTED};
  }
  .foot code { font-size: 9.5px; word-break: break-all; }

  /* --- Tear-off stubs --------------------------------------------------- */
  .stubs { padding: 0 26px 24px; }
  .stubs__lede {
    margin: 0 0 12px; padding-top: 16px;
    border-top: 2px dashed ${LINE};
    font-size: 11px; color: ${MUTED};
  }
  .stubs__row { display: flex; flex-wrap: wrap; gap: 10px; }
  .stub {
    display: flex; flex-direction: column; gap: 1px;
    padding: 10px 12px; min-width: 96px;
    border: 1.5px dashed ${NAVY}; border-radius: 8px;
    background: #fff;
    page-break-inside: avoid; break-inside: avoid;
  }
  .stub__seat {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 19px; font-weight: 700; color: ${NAVY}; line-height: 1.1;
  }
  .stub__section { font-size: 8.5px; color: ${MUTED}; }
  .stub__ref {
    margin-top: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 9.5px; color: ${GOLD};
  }
  .stub__event { font-size: 8px; color: ${MUTED}; }

  /* --- Controls (screen only) ------------------------------------------- */
  .actions {
    max-width: 186mm; margin: 18px auto 0;
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
  }
  .btn {
    font: inherit; font-size: 14px; font-weight: 700;
    padding: 11px 20px; border-radius: 999px; border: 1.5px solid transparent;
    cursor: pointer; text-decoration: none; display: inline-block;
  }
  .btn--primary { background: ${GOLD}; color: #1c1508; }
  .btn--ghost { background: #fff; color: ${NAVY}; border-color: ${LINE}; }
  .actions__hint { font-size: 12px; color: ${MUTED}; }

  @media (max-width: 620px) {
    .claim { flex-direction: column; align-items: flex-start; gap: 18px; }
    .facts__grid { grid-template-columns: minmax(0, 1fr); }
    .hero__event { font-size: 21px; }
  }

  /* --- Print ------------------------------------------------------------ */
  @media print {
    body { padding: 0; background: #fff; }
    .sheet { max-width: none; border: none; border-radius: 0; box-shadow: none; }
    .actions { display: none; }
    .stub, .claim, .notes { page-break-inside: avoid; break-inside: avoid; }
  }
</style>
</head><body>

<article class="sheet">
  <header class="hero">
    <img class="hero__art" src="/assets/ticket-banner.svg" alt="" width="1200" height="300" />
    <div class="hero__veil"></div>
    <div class="hero__text">
      <p class="hero__org">${esc(env.appName)} &middot; Seat confirmation</p>
      <h1 class="hero__event">${esc(party.concert.name)}</h1>
      <p class="hero__when">
        ${esc(whatsapp.formatDate(party.concert.event_date))}
        &middot; ${esc(whatsapp.formatTime(party.concert.start_time))}
        &middot; ${esc(party.concert.venue)}
      </p>
    </div>
  </header>

  <section class="claim">
    <div class="claim__left">
      <p class="claim__label">Booking reference</p>
      <p class="claim__ref">${esc(party.booking_reference)}</p>
      <p class="claim__name">${esc(holder.full_name)}
        &middot; ${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}</p>
      <span class="claim__free">Admission free</span>
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
          party.concert.end_time ? ` &ndash; ${esc(whatsapp.formatTime(party.concert.end_time))}` : ''
        }</dd>
      </div>
      <div class="fact fact--wide">
        <dt>Venue</dt>
        <dd>${esc(party.concert.venue)}${
          party.concert.address ? `<br><span style="font-weight:400;color:${MUTED}">${esc(party.concert.address)}</span>` : ''
        }</dd>
      </div>
      <div class="fact fact--wide">
        <dt>${seatCount === 1 ? 'Your seat' : `Your seats (${seatCount})`}</dt>
        <dd><span class="seats">${seatList}</span></dd>
      </div>
      <div class="fact">
        <dt>Booking fee</dt>
        <dd>FREE</dd>
      </div>
      <div class="fact">
        <dt>Status</dt>
        <dd>${esc(party.status)}</dd>
      </div>
    </dl>
  </section>

  <section class="notes">
    <img class="notes__crest" src="/assets/ticket-crest.svg" alt="" width="54" height="54" />
    <ul class="notes__list">
      <li>Arrive <strong>20 minutes early</strong> so stewards can seat you without rushing.</li>
      <li>Show this reference at the door &mdash; on paper or on your phone, either is fine.</li>
      <li>Admission is free. Nobody will ask you for payment or card details.</li>
      <li>If you can no longer come, release your seats from your dashboard so somebody else can have them.</li>
    </ul>
  </section>

  ${stubs(party)}

  <footer class="foot">
    <span>${esc(env.appName)} &middot; booked ${esc(whatsapp.formatDate(party.booked_at || party.concert.event_date))}</span>
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

module.exports = { renderTicket, esc };
