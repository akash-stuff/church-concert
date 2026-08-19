'use strict';

/**
 * The printable seat confirmation.
 *
 * Server-rendered so it works with JavaScript off, and shared by two routes
 * that reach it very differently: an attendee fetching their own
 * (/api/bookings/mine/confirmation) and staff fetching anyone's
 * (/api/admin/bookings/:reference/ticket). Only the authorisation differs, so
 * only the authorisation lives in the routes; the document lives here.
 */

const env = require('../env');
const whatsapp = require('../services/whatsapp');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * `party` is the shape bookingService.getUserBookings returns: a reference, a
 * concert, and the seats under it. `holder` is whose name goes on the ticket.
 */
function renderTicket(party, holder) {
  const seatList = party.seats
    .map((seat) => `${esc(seat.seat_number)} <span class="sec">${esc(seat.section_name)}</span>`)
    .join('<br>');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Booking ${esc(party.booking_reference)}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; color: #0f172a; margin: 0; padding: 32px; background: #f4f6f9; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border: 2px solid #16233d; padding: 28px 32px; }
  .eyebrow { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: #b58328; }
  h1 { font-size: 26px; margin: 6px 0 2px; }
  .ref { font-family: ui-monospace, monospace; font-size: 22px; letter-spacing: .06em; margin: 18px 0; padding: 12px 0; border-top: 2px solid #b58328; border-bottom: 2px solid #b58328; }
  dl { display: grid; grid-template-columns: 120px 1fr; gap: 10px 16px; margin: 18px 0 0; font-size: 14px; }
  dt { color: #64748b; }
  dd { margin: 0; font-weight: 600; }
  .seat { font-family: ui-monospace, monospace; font-size: 20px; line-height: 1.5; }
  .sec { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; font-weight: 400; color: #64748b; }
  .count { display: inline-block; margin-left: 8px; padding: 2px 8px; background: #b58328; color: #fff; font-size: 12px; font-weight: 700; border-radius: 999px; }
  .free { margin-top: 22px; padding: 10px 14px; background: #fdf7ea; border-left: 4px solid #b58328; font-size: 13px; }
  .print { margin: 24px auto 0; max-width: 560px; }
  button { font: inherit; padding: 10px 18px; border: 2px solid #16233d; background: #16233d; color: #e0ac4c; cursor: pointer; font-weight: 700; }
  @media print { .print { display: none; } body { padding: 0; background: #fff; } }
</style>
</head><body>
<div class="card">
  <p class="eyebrow">${esc(env.appName)} &mdash; seat confirmation</p>
  <h1>${esc(party.concert.name)}</h1>
  <div class="ref">${esc(party.booking_reference)}</div>
  <dl>
    <dt>Name</dt><dd>${esc(holder.full_name)}</dd>
    <dt>WhatsApp</dt><dd>${esc(holder.whatsapp_number)}</dd>
    <dt>${party.seats.length === 1 ? 'Seat' : 'Seats'}</dt>
    <dd class="seat">${seatList}${party.seats.length > 1 ? `<span class="count">${party.seats.length} seats</span>` : ''}</dd>
    <dt>Date</dt><dd>${esc(whatsapp.formatDate(party.concert.event_date))}</dd>
    <dt>Time</dt><dd>${esc(whatsapp.formatTime(party.concert.start_time))}</dd>
    <dt>Venue</dt><dd>${esc(party.concert.venue)}${party.concert.address ? `, ${esc(party.concert.address)}` : ''}</dd>
    <dt>Booking Fee</dt><dd>FREE</dd>
    <dt>Status</dt><dd>${esc(party.status)}</dd>
  </dl>
  <p class="free">Admission is free. Show this reference at the door and arrive 20 minutes early.${party.seats.length > 1 ? ' Everyone in your party can arrive together under this one reference.' : ''}</p>
</div>
<!-- The button's behaviour is in /js/print.js, not an onclick attribute: the
     CSP sets script-src 'self' with no 'unsafe-inline', so an inline handler
     would be dropped and the button would do nothing. -->
<div class="print"><button type="button" data-print>Print this page</button></div>
<script src="/js/print.js"></script>
</body></html>`;
}

module.exports = { renderTicket, esc };
