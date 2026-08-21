'use strict';

(async function initSeats() {
  const { api, $, el, notify, clearNotice, busy, renderSeatMap, mountHeader, requireSession, showFieldErrors } =
    window.CC;
  const UI = window.UI;

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

  // --- Who is sitting where -------------------------------------------------

  /**
   * One block of fields per chosen seat.
   *
   * A booking is one row per seat, and until now every one of those rows carried
   * the booker's name — so a family of four appeared on the door list as one
   * person four times over, and a steward had no way to tell who should be in
   * which chair. Each seat now names its own guest.
   *
   * The first seat is prefilled from the account, because the person booking is
   * almost always one of the people coming, and making them retype their own
   * details to book their own seat is the kind of friction that gets a booking
   * abandoned. Every field stays editable: sometimes you book for other people
   * and are not coming yourself.
   */
  function guestFields(seat, index, user) {
    const id = (name) => `guest_${seat.id}_${name}`;
    const mine = index === 0;

    const field = (name, label, type, value, { hint = null, required = true } = {}) =>
      el('div', { class: 'field' }, [
        el('label', { for: id(name), text: label }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('input', {
            id: id(name),
            name: `${seat.id}:${name}`,
            type,
            value: value || '',
            autocomplete: 'off',
            required: required ? true : null,
          }),
        ]),
        hint ? el('p', { class: 'field__hint', text: hint }) : null,
        el('span', { class: 'field__error', 'data-error-for': `${seat.id}:${name}` }),
      ]);

    return el('fieldset', { class: 'guest-card' }, [
      el('legend', { class: 'guest-card__legend' }, [
        el('b', { text: seat.seat_number }),
        el('span', { text: seat.section_name || '' }),
        mine ? el('i', { class: 'chip chip--accent', text: 'You' }) : null,
      ]),
      field('name', 'Full name', 'text', mine ? user.full_name : ''),
      field('email', 'Email', 'email', mine ? user.email : ''),
      field('phone', 'Phone', 'tel', mine ? user.whatsapp_number || user.mobile_number : '', {
        hint: 'With country code, for example +919876543210.',
      }),
      field('age', 'Age', 'number', '', {
        required: false,
        hint: 'Only needed if this guest is under 18.',
      }),
    ]);
  }

  /**
   * Collect guest details, then book. Resolves once the booking is made, or not
   * at all if the person closes the panel.
   *
   * The panel is where errors land too: a validation failure has to be shown
   * against the field that caused it, which means the form must still be on
   * screen when the server answers. So it stays open until the booking succeeds.
   */
  function collectGuests(user) {
    const seats = [...chosen.values()];
    const form = el('form', { class: 'guest-form' }, [
      el('p', { class: 'guest-form__lede' }, [
        el('span', {
          text:
            seats.length === 1
              ? 'Tell us who is coming, so stewards can greet them by name at the door.'
              : `Tell us who is sitting in each of the ${seats.length} seats. Each guest gets their own wristband at the door.`,
        }),
      ]),
      ...seats.map((seat, index) => guestFields(seat, index, user)),
    ]);

    /** DOM field names are "<seatId>:<field>", so they regroup by seat. */
    const readGuests = () => {
      const bySeat = new Map(seats.map((seat) => [seat.id, { seat_id: seat.id }]));
      for (const input of form.querySelectorAll('input[name]')) {
        const [rawSeat, key] = input.name.split(':');
        const guest = bySeat.get(Number(rawSeat));
        if (guest) guest[key] = input.value.trim();
      }
      return [...bySeat.values()];
    };

    return new Promise((resolve) => {
      let settled = false;

      UI.drawer({
        title: seats.length === 1 ? 'Who is coming?' : 'Who is coming?',
        subtitle:
          seats.length === 1
            ? 'One seat'
            : `${seats.length} seats · ${seats.map((s) => s.seat_number).join(', ')}`,
        render: (body) => body.append(form),
        onClose: () => {
          if (!settled) resolve(null);
        },
        actions: [
          { label: 'Back to the map', onClick: ({ close }) => close() },
          {
            label: 'Confirm booking',
            variant: 'primary',
            onClick: async ({ close, button }) => {
              showFieldErrors(form, {});
              busy(button, true, 'Confirming…');
              try {
                const result = await api('/api/bookings', {
                  method: 'POST',
                  body: { concert_id: concertId, guests: readGuests() },
                });
                settled = true;
                close();
                resolve(result);
              } catch (error) {
                busy(button, false);
                paintGuestErrors(form, error, seats);
                UI.toastError('Could not confirm the booking', error.message);

                // Somebody else got there first: the panel is useless now, so
                // close it and let the map reload underneath.
                if (
                  ['SEAT_TAKEN', 'FULLY_BOOKED', 'NOT_ENOUGH_CAPACITY', 'SEAT_RESERVED', 'SEAT_DISABLED'].includes(
                    error.code,
                  )
                ) {
                  settled = true;
                  close();
                  resolve({ failed: error });
                }
              }
            },
          },
        ],
      });
    });
  }

  /**
   * Map server field errors onto the form.
   *
   * The server reports them as `guests.0.email`, indexed by position in the
   * array that was sent, whereas the inputs are keyed by seat id. This walks
   * that back through the same ordering used to build the request.
   */
  function paintGuestErrors(form, error, seats) {
    if (!error.details) return;
    const details = {};
    for (const [key, message] of Object.entries(error.details)) {
      const match = /^guests\.(\d+)\.(\w+)$/.exec(key);
      if (match) {
        const seat = seats[Number(match[1])];
        if (seat) details[`${seat.id}:${match[2]}`] = message;
      } else {
        details[key] = message;
      }
    }
    showFieldErrors(form, details);

    const first = form.querySelector('[data-error-for]:not(:empty)');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // --- Confirm --------------------------------------------------------------
  $('[data-clear]').addEventListener('click', clearSelection);

  $('[data-confirm]').addEventListener('click', async (event) => {
    if (!chosen.size) return;
    clearNotice('[data-notice]');
    const button = event.currentTarget;
    busy(button, true, 'Just a moment…');

    let result;
    try {
      result = await collectGuests(session.user);
    } finally {
      busy(button, false);
    }

    // Panel closed without booking.
    if (!result) return;

    // Booked, but the seats went first — reload the map and let them try again.
    if (result.failed) {
      notify('[data-notice]', result.failed.message, 'error');
      await load({ keepNotice: true });
      return;
    }

    try {

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
      // Only a failure to stash the summary and navigate can land here; the
      // booking itself already succeeded, so send them on regardless rather
      // than leaving them on a map that no longer reflects their seats.
      window.location.href = '/confirmed.html';
    }
  });

  await load();

  // Keep the plan reasonably fresh while somebody is deciding, but never pull
  // the rug out from under a selection in progress.
  setInterval(() => {
    if (!chosen.size) load({ keepNotice: true });
  }, 20000);
})();
