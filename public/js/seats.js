'use strict';

(async function initSeats() {
  const { api, $, el, notify, clearNotice, busy, renderSeatMap, mountHeader, requireSession } =
    window.CC;

  const session = await mountHeader('/seats.html');
  if (!requireSession(session, '/seats.html')) return;

  if (!session.user.whatsapp_verified) {
    window.location.href = '/verify.html';
    return;
  }

  const map = $('[data-seatmap]');
  const bar = $('[data-confirm-bar]');

  /** Seats chosen but not yet confirmed, keyed by id so order is stable. */
  const chosen = new Map();
  let concertId = Number(new URLSearchParams(window.location.search).get('concert_id')) || null;
  let availability = null;
  let concerts = [];

  $('[data-confirm-who]').textContent =
    `${session.user.full_name} · ${session.user.whatsapp_masked}`;

  // --- Concert switcher -----------------------------------------------------
  function renderSwitcher() {
    const box = $('[data-switcher]');
    // Only worth showing when there is a choice to make.
    if (concerts.length < 2) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.textContent = '';
    for (const concert of concerts) {
      box.append(
        el('button', {
          type: 'button',
          'aria-pressed': String(concert.id === concertId),
          text: `${concert.name} · ${concert.availability.remaining_capacity} left`,
          onclick: () => {
            if (concert.id === concertId) return;
            concertId = concert.id;
            chosen.clear();
            updateBar();
            // Keep the address bar in step so the page can be reloaded or shared.
            const url = new URL(window.location.href);
            url.searchParams.set('concert_id', String(concert.id));
            window.history.replaceState({}, '', url);
            load();
          },
        }),
      );
    }
  }

  // --- Figures --------------------------------------------------------------
  function showAvailability(data) {
    const box = $('[data-availability]');
    box.textContent = '';
    const figures = [
      ['Seats left', data.remaining_capacity, ''],
      ['Total capacity', data.max_capacity, ''],
      ['Already taken', data.booked_seats, 'figure--ruby'],
      ['Booking fee', 'Free', 'figure--verdigris'],
    ];
    for (const [label, value, variant] of figures) {
      box.append(
        el('div', { class: `figure ${variant}`.trim() }, [
          el('div', { class: 'figure__value', text: String(value) }),
          el('div', { class: 'figure__label', text: label }),
        ]),
      );
    }
  }

  // --- Selection ------------------------------------------------------------
  function updateBar() {
    const count = chosen.size;
    bar.hidden = count === 0;
    $('[data-selected-count]').textContent = String(count);
    $('[data-selected-word]').textContent = count === 1 ? 'seat chosen' : 'seats chosen';

    const list = $('[data-chosen]');
    list.textContent = '';
    for (const seat of chosen.values()) {
      list.append(
        el('span', { class: 'chosen__seat' }, [
          el('span', { text: seat.seat_number }),
          el('button', {
            type: 'button',
            text: '×',
            'aria-label': `Remove seat ${seat.seat_number}`,
            onclick: () => toggle(seat),
          }),
        ]),
      );
    }
  }

  function paintSelection() {
    for (const button of map.querySelectorAll('.seat[aria-pressed]')) {
      button.setAttribute('aria-pressed', String(chosen.has(Number(button.dataset.seatId))));
    }
  }

  function toggle(seat) {
    if (chosen.has(seat.id)) {
      chosen.delete(seat.id);
    } else {
      // Never let someone select more than is actually left: they would fill in
      // the form only to be turned away at the last step.
      const remaining = availability?.remaining_capacity ?? Infinity;
      if (chosen.size >= remaining) {
        notify(
          '[data-notice]',
          remaining === 1
            ? 'Only 1 seat is left for this concert.'
            : `Only ${remaining} seats are left for this concert.`,
          'warn',
        );
        return;
      }
      const limit = availability?.max_seats_per_booking || 0;
      if (limit > 0 && chosen.size >= limit) {
        notify(
          '[data-notice]',
          `This concert allows ${limit} seat${limit === 1 ? '' : 's'} per person.`,
          'warn',
        );
        return;
      }
      chosen.set(seat.id, seat);
    }
    updateBar();
    paintSelection();
  }

  function clearSelection() {
    chosen.clear();
    updateBar();
    paintSelection();
  }

  // --- Load -----------------------------------------------------------------
  async function load({ keepNotice = false } = {}) {
    if (!keepNotice) clearNotice('[data-notice]');

    let data;
    try {
      const query = concertId ? `?concert_id=${concertId}` : '';
      [data, concerts] = await Promise.all([
        api(`/api/seats${query}`),
        concerts.length ? Promise.resolve(concerts) : api('/api/concerts').then((r) => r.concerts),
      ]);
    } catch (error) {
      notify('[data-notice]', error.message, 'error');
      return;
    }

    concertId = data.concert.id;
    availability = data.availability;
    renderSwitcher();

    $('[data-concert-heading]').textContent = `Pick your seats · ${data.concert.name}`;
    showAvailability(data.availability);

    // Drop anything that has been taken since it was chosen.
    const stillFree = new Set(
      data.sections
        .flatMap((section) => section.seats)
        .filter((seat) => seat.status === 'AVAILABLE' && !seat.booking && !seat.is_mine)
        .map((seat) => seat.id),
    );
    for (const id of [...chosen.keys()]) if (!stillFree.has(id)) chosen.delete(id);

    renderSeatMap(map, data.sections, {
      selectedIds: new Set(chosen.keys()),
      onSelect: toggle,
    });
    updateBar();

    const held = data.my_seat_count;
    if (held > 0) {
      $('[data-seats-lede]').textContent =
        `You already hold ${held} seat${held === 1 ? '' : ''} at this concert, marked with a tick. Choose more if you need them, or see them on your dashboard.`;
    }

    if (data.availability.fully_booked) {
      clearSelection();
      map.querySelectorAll('.seat').forEach((button) => {
        button.disabled = true;
      });
      notify(
        '[data-notice]',
        'Fully booked. Every seat for this concert has been taken. Contact the church office to be added to the waiting list.',
        'warn',
      );
      $('[data-seats-lede]').textContent =
        'There are no seats left to choose. If someone cancels, seats reappear here.';
    }
  }

  // --- Confirm --------------------------------------------------------------
  $('[data-clear]').addEventListener('click', clearSelection);

  $('[data-confirm]').addEventListener('click', async (event) => {
    if (!chosen.size) return;
    clearNotice('[data-notice]');
    const button = event.currentTarget;
    busy(button, true, 'Confirming…');

    try {
      const result = await api('/api/bookings', {
        method: 'POST',
        body: { concert_id: concertId, seat_ids: [...chosen.keys()] },
      });

      sessionStorage.setItem(
        'cc_last_booking',
        JSON.stringify({
          reference: result.booking.booking_reference,
          seats: result.booking.seat_numbers,
          status: result.booking.status,
          concert: result.concert.name,
        }),
      );
      window.location.href = '/confirmed.html';
    } catch (error) {
      busy(button, false);
      notify('[data-notice]', error.message, 'error');

      // Someone else got there first, or the last places went: reload so the
      // plan matches reality before the next attempt.
      if (
        [
          'SEAT_TAKEN',
          'FULLY_BOOKED',
          'NOT_ENOUGH_CAPACITY',
          'SEAT_RESERVED',
          'SEAT_DISABLED',
          'PER_PERSON_LIMIT',
        ].includes(error.code)
      ) {
        await load({ keepNotice: true });
      }
      if (error.code === 'WHATSAPP_NOT_VERIFIED') {
        setTimeout(() => {
          window.location.href = '/verify.html';
        }, 1500);
      }
    }
  });

  await load();

  // Keep the plan reasonably fresh while somebody is deciding, but never pull
  // the rug out from under a selection in progress.
  setInterval(() => {
    if (!chosen.size) load({ keepNotice: true });
  }, 20000);
})();
