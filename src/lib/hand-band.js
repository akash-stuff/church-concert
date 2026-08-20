'use strict';

/**
 * Hand bands — the printable wristband a steward puts on a guest at the door.
 *
 * This replaces the earlier "hand tags", and the difference is not cosmetic. A
 * tag was a card the attendee printed at home, which is the wrong model: the
 * band is proof that somebody has *been checked in*, so it can only be issued
 * by a steward at the door, after the ticket has been verified. Printing your
 * own admission band at home defeats the point of scanning anything. So this
 * lives behind the admin check-in screen and nowhere else.
 *
 * Shape: a long strip, because that is what goes round a wrist. 220mm x 30mm —
 * long enough for an adult wrist (16–19cm) plus an overlap to stick down. That
 * does not fit across portrait A4, which has 186mm of printable width, so the
 * document prints landscape: 281mm to play with, and six bands to a sheet.
 *
 * The important detail is the *repeat*. Everything that matters — QR, reference,
 * name — appears at both ends of the strip, mirrored around the centre. Once the
 * band is round a wrist, roughly half of it faces away from you, and a steward
 * re-checking somebody should not have to turn their arm over to find the code.
 *
 * Colour is chosen by the steward, violet by default. Bands are the usual way to
 * distinguish groups at a door — guests from crew, one session from the next —
 * so the palette is small and named rather than a free-form colour picker,
 * because "the purple ones" is what somebody will actually say out loud.
 */

const env = require('../env');
const whatsapp = require('../services/whatsapp');
const qr = require('./qr');
const { esc, head } = require('./ticket');

/**
 * The band colours, as ink/paper pairs.
 *
 * Each is dark enough that white type on it clears WCAG AA at this size, which
 * matters more than usual: these get read in a porch, in the dark, at arm's
 * length. `qrDark` is deliberately near-black rather than the band colour — a
 * QR printed in mid-violet on violet has nothing like the contrast a phone
 * camera needs, and a band whose code will not scan is a band that has failed.
 */
const COLOURS = {
  violet: { label: 'Violet', ink: '#5b21b6', edge: '#7c3aed', qrDark: '#1e1b4b' },
  purple: { label: 'Purple', ink: '#6b21a8', edge: '#9333ea', qrDark: '#2e1065' },
  indigo: { label: 'Indigo', ink: '#3730a3', edge: '#4f46e5', qrDark: '#1e1b4b' },
  navy: { label: 'Navy', ink: '#16233d', edge: '#2c4a7c', qrDark: '#0d1729' },
  teal: { label: 'Teal', ink: '#115e59', edge: '#0d9488', qrDark: '#042f2e' },
  green: { label: 'Green', ink: '#166534', edge: '#16a34a', qrDark: '#052e16' },
  amber: { label: 'Amber', ink: '#92400e', edge: '#d97706', qrDark: '#451a03' },
  rose: { label: 'Rose', ink: '#9f1239', edge: '#e11d48', qrDark: '#4c0519' },
};

const DEFAULT_COLOUR = 'violet';

/** The palette, for the check-in screen's colour picker. */
const colourOptions = () =>
  Object.entries(COLOURS).map(([value, colour]) => ({
    value,
    label: colour.label,
    swatch: colour.ink,
  }));

/**
 * One end-block of a band: QR, reference, name. Rendered twice per strip,
 * mirrored, so the details are readable whichever way the wrist is turned.
 */
function endBlock(qrSvg, party, guestName, { flip = false } = {}) {
  return `
      <div class="band__end${flip ? ' band__end--flip' : ''}">
        <div class="band__qr">${qrSvg}</div>
        <div class="band__who">
          <span class="band__ref">${esc(party.booking_reference)}</span>
          <span class="band__name">${esc(guestName)}</span>
        </div>
      </div>`;
}

/**
 * `party` is the shape bookingService.getUserBookings returns. `guests` is one
 * entry per band to print: `{ name, seat_number, section_name }`.
 *
 * A band per guest rather than per booking, because a band goes on one wrist.
 */
async function renderHandBands(party, guests, { autoPrint = false, colour = DEFAULT_COLOUR } = {}) {
  const theme = COLOURS[colour] || COLOURS[DEFAULT_COLOUR];
  const key = COLOURS[colour] ? colour : DEFAULT_COLOUR;

  // The QR is generated in the band's own dark ink so it prints at full
  // contrast against the strip rather than in the site's navy.
  const qrSvg = (await qr.ticketSvg(party.booking_reference, { dark: theme.qrDark })) || '';
  const checkIn = qr.checkInUrl(party.booking_reference);

  const when = `${whatsapp.formatDate(party.concert.event_date)} · ${whatsapp.formatTime(
    party.concert.start_time,
  )}`;

  const bands = guests
    .map(
      (guest) => `
    <div class="band">
      ${endBlock(qrSvg, party, guest.name)}
      <div class="band__middle">
        <span class="band__brand">${esc(env.appName)}</span>
        <span class="band__event">${esc(party.concert.name)}</span>
        <span class="band__meta">${esc(when)}${
          guest.seat_number
            ? ` &middot; Seat ${esc(guest.seat_number)}${
                guest.section_name ? ` (${esc(guest.section_name)})` : ''
              }`
            : ''
        }</span>
      </div>
      ${endBlock(qrSvg, party, guest.name, { flip: true })}
    </div>`,
    )
    .join('');

  const count = guests.length;

  return `<!doctype html>
<html lang="en" data-band="${esc(key)}">
<head>
${head(`Hand band ${party.booking_reference} — ${party.concert.name}`)}
<!-- Second, and that order matters: band.css re-declares @page as landscape,
     overriding the portrait rule in ticket.css by later-wins. -->
<link rel="stylesheet" href="/css/band.css">
</head>
<body class="bands-body">

<div class="bands-page">
  <header class="bands-head no-print">
    <h1>${count === 1 ? 'Hand band' : `Hand bands — ${count}`}</h1>
    <p>
      <strong>${esc(party.concert.name)}</strong> &middot; ${esc(when)} &middot;
      ${esc(party.concert.venue)}
    </p>
    <p>
      Booking <strong>${esc(party.booking_reference)}</strong>. Cut along the dashed lines, wrap
      round the wrist and stick the overlap down. Each band repeats its details at both ends, so
      it can be re-checked without turning the arm over.
    </p>
  </header>

  <div class="bands-grid">${bands}</div>
</div>

<div class="actions no-print">
  <button class="btn btn--primary" type="button" data-print>Print bands</button>
  <a class="btn btn--ghost" href="${esc(env.appUrl)}/checkin.html">Back to check-in</a>
  <span class="actions__hint">
    Print at 100% scale on A4 &mdash; &ldquo;fit to page&rdquo; will shrink the strips below
    wrist length. Check-in URL: <code>${esc(checkIn)}</code>
  </span>
</div>

<script src="/js/print.js"${autoPrint ? ' data-auto-print' : ''}></script>
</body></html>`;
}

module.exports = { renderHandBands, colourOptions, COLOURS, DEFAULT_COLOUR };
