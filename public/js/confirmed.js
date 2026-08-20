'use strict';

(async function initConfirmed() {
  const { api, $, el, notify, formatDate, formatTime, mountHeader, requireSession } = window.CC;

  const session = await mountHeader('/confirmed.html');
  if (!requireSession(session, '/dashboard.html')) return;

  // The seat page stashes the reference it just created, so the right party is
  // shown even when the account holds several.
  let stashed = null;
  try {
    stashed = JSON.parse(sessionStorage.getItem('cc_last_booking') || 'null');
  } catch {
    stashed = null;
  }

  let party = null;
  try {
    const { bookings } = await api('/api/bookings/mine');
    party = stashed
      ? bookings.find((item) => item.booking_reference === stashed.reference)
      : bookings[0];
    if (!party) party = bookings[0] ?? null;
  } catch {
    party = null;
  }

  if (!party) {
    notify(
      '[data-notice]',
      'We could not find a booking on your account. If you were part-way through, choose your seats again.',
      'warn',
    );
    $('[data-reference]').textContent = 'No booking found';
    return;
  }

  const seatCount = party.seats.length;
  $('[data-headline]').textContent =
    seatCount === 1 ? 'Your seat is reserved' : `Your ${seatCount} seats are reserved`;
  $('[data-reference]').textContent = party.booking_reference;
  const ticketUrl = `/api/bookings/mine/confirmation?reference=${encodeURIComponent(party.booking_reference)}`;
  // print=1 opens the print dialog on load, which is how "Download PDF" works
  // without shipping a PDF writer; the plain URL is the readable preview.
  $('[data-print-link]').href = `${ticketUrl}&print=1`;
  const viewLink = $('[data-view-link]');
  if (viewLink) viewLink.href = ticketUrl;

  const detail = $('[data-booking-detail]');
  detail.textContent = '';

  const seatTags = el('div', { class: 'seat-tags' });
  for (const seat of party.seats) {
    seatTags.append(
      el('span', { class: 'seat-tag', text: `${seat.seat_number} · ${seat.section_name}` }),
    );
  }

  const rows = [
    ['Name', el('span', { text: session.user.full_name })],
    ['WhatsApp', el('span', { text: session.user.whatsapp_masked || '' })],
    [seatCount === 1 ? 'Seat' : `Seats (${seatCount})`, seatTags],
    ['Concert', el('span', { text: party.concert.name })],
    ['Date', el('span', { text: formatDate(party.concert.event_date) })],
    ['Time', el('span', { text: formatTime(party.concert.start_time) })],
    ['Venue', el('span', { text: party.concert.venue })],
    ['Status', el('span', { text: party.status })],
    ['Booking fee', el('strong', { text: 'FREE' })],
  ];
  for (const [label, node] of rows) {
    detail.append(el('dt', { text: label }), el('dd', {}, node));
  }

  sessionStorage.removeItem('cc_last_booking');
})();
