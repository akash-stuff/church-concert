'use strict';

(async function initConcertPage() {
  const { api, $, el, notify, formatDate, formatTime, renderSeatMap, mountHeader } = window.CC;

  const session = await mountHeader('/concert.html');

  let data;
  try {
    data = await api('/api/seats');
  } catch (error) {
    notify('[data-notice]', error.message, 'error');
    return;
  }

  const { concert, sections, availability, my_booking: mine } = data;

  document.title = `${concert.name} — details`;
  $('[data-concert-name]').textContent = concert.name;

  // The concert's own poster if it has one, otherwise one of the bundled
  // illustrations picked from its id — so a given concert always shows the same
  // artwork rather than shuffling between reloads.
  const POSTERS = [
    '/assets/posters/choir-night.svg',
    '/assets/posters/carols.svg',
    '/assets/posters/strings.svg',
    '/assets/posters/organ-recital.svg',
    '/assets/posters/gospel-evening.svg',
  ];
  const poster = $('[data-concert-poster]');
  if (poster) {
    poster.src = concert.poster_path || POSTERS[(Number(concert.id) || 0) % POSTERS.length];
    poster.alt = `Artwork for ${concert.name}`;
  }
  $('[data-concert-description]').textContent =
    concert.description || 'Details for this concert are being finalised.';

  const detail = $('[data-concert-detail]');
  const rows = [
    ['Date', formatDate(concert.event_date)],
    [
      'Time',
      `${formatTime(concert.start_time)}${concert.end_time ? ` – ${formatTime(concert.end_time)}` : ''}`,
    ],
    ['Venue', concert.venue],
    ['Address', concert.address || '—'],
    ['Admission', 'Free'],
  ];
  for (const [label, value] of rows) {
    detail.append(el('dt', { text: label }), el('dd', { text: value }));
  }

  const availabilityList = $('[data-availability]');
  for (const [label, value] of [
    ['Total capacity', String(availability.max_capacity)],
    ['Seats taken', String(availability.booked_seats)],
    ['Seats left', availability.fully_booked ? 'Fully booked' : String(availability.remaining_capacity)],
  ]) {
    availabilityList.append(el('dt', { text: label }), el('dd', { text: value }));
  }

  renderSeatMap($('[data-seatmap]'), sections, { mySeatNumber: mine?.seat_number });

  const cta = $('[data-cta]');
  if (session?.user) {
    cta.href = mine ? '/dashboard.html' : '/seats.html';
    cta.textContent = mine ? `Your seat: ${mine.seat_number}` : 'Choose your seat';
  } else if (availability.fully_booked) {
    cta.textContent = 'Register anyway';
  }

  if (availability.fully_booked) {
    notify('[data-notice]', 'Every seat has been taken for this concert.', 'warn');
  }
})();
