/* The door. A steward scans a ticket QR, lands here with ?ref=, and gets one
   large answer: admit, or do not.

   Everything is scoped to a signed-in administrator — the endpoint requires it
   — so a stranger scanning a ticket they found gets the staff sign-in page.
   That is the whole reason the QR points at a URL rather than carrying the
   attendee's details in the code itself. */
'use strict';

(function initCheckin() {
  const { api, $, el, notify, clearNotice, busy, formatDate, formatTime, formatShortDate } =
    window.CC;
  const UI = window.UI;

  const form = $('#checkin-form');
  const input = $('#reference');
  const verdictBox = $('[data-verdict]');

  /* The band colour the steward last chose, kept for the rest of the shift.
     Sessions are per-door and per-evening, which is exactly the scope wanted:
     bands are used to tell one group from another, so a steward who picked teal
     for tonight should not have to pick it again for every guest. */
  const COLOUR_KEY = 'cc_band_colour';
  let palette = [];
  let bandColour = sessionStorage.getItem(COLOUR_KEY) || 'violet';

  /** Copy per verdict. Tone, heading and what the steward should do. */
  const VERDICTS = {
    ADMIT: { tone: 'ok', mark: '✓', heading: 'Admit' },
    CANCELLED: { tone: 'off', mark: '✕', heading: 'Cancelled' },
    FUTURE: { tone: 'wait', mark: '!', heading: 'Not for today' },
    PAST: { tone: 'wait', mark: '!', heading: 'Past concert' },
    UNKNOWN: { tone: 'off', mark: '?', heading: 'Not found' },
  };

  async function check(reference) {
    clearNotice('[data-notice]');
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Checking…');
    verdictBox.hidden = true;

    try {
      const result = await api(`/api/admin/checkin?reference=${encodeURIComponent(reference)}`);
      render(result);
    } catch (error) {
      if (error.status === 401) {
        // Send them to sign in, and come back to this exact ticket afterwards.
        window.location.href = `/admin/login.html?next=${encodeURIComponent(window.location.href)}`;
        return;
      }
      notify('[data-notice]', error.message, 'error');
      UI.toastError('Could not check that ticket', error.message);
    } finally {
      busy(submit, false);
    }
  }

  function render(result) {
    const shape = VERDICTS[result.verdict] || VERDICTS.UNKNOWN;
    verdictBox.textContent = '';
    verdictBox.dataset.tone = shape.tone;
    verdictBox.hidden = false;

    verdictBox.append(
      el('div', { class: 'verdict__mark', 'aria-hidden': 'true', text: shape.mark }),
      el('h1', { class: 'verdict__heading', text: shape.heading }),
      el('p', { class: 'verdict__message', text: result.message }),
    );

    if (!result.found) {
      verdictBox.append(el('p', { class: 'verdict__ref', text: result.reference }));
      return;
    }

    verdictBox.append(
      el('p', { class: 'verdict__ref', text: result.reference }),
      el('dl', { class: 'verdict__facts' }, [
        fact('Name', result.holder),
        fact('Concert', result.concert.name),
        fact('When', `${formatDate(result.concert.event_date)} · ${formatTime(result.concert.start_time)}`),
        fact('Venue', result.concert.venue),
        fact(
          result.live_seats === 1 ? 'Seat' : 'Seats',
          result.seats
            .filter((s) => s.status === 'PENDING' || s.status === 'CONFIRMED')
            .map((s) => `${s.seat_number} (${s.section_name})`)
            .join(', ') || 'None held',
        ),
        result.cancelled_at
          ? fact('Cancelled', `${formatShortDate(result.cancelled_at)}${result.cancel_reason ? ` — ${result.cancel_reason}` : ''}`)
          : null,
      ]),
    );

    // Seats are big and monospaced because that is what gets read out loud.
    if (result.live_seats > 0) {
      const strip = el('div', { class: 'verdict__seats' });
      for (const seat of result.seats.filter((s) => s.status === 'PENDING' || s.status === 'CONFIRMED')) {
        strip.append(
          el('span', { class: 'verdict__seat' }, [
            el('b', { text: seat.seat_number }),
            el('i', { text: seat.section_name }),
            // Who is in this seat, when the party names more than one person.
            // A steward calling out "B7 — Anna" is faster than reading a list.
            seat.guest_name && seat.guest_name !== result.holder
              ? el('u', { text: seat.guest_name })
              : null,
            seat.is_minor ? el('em', { text: `Age ${seat.guest_age}` }) : null,
          ]),
        );
      }
      verdictBox.append(strip);
    }

    // Bands are only issued to somebody who is actually being admitted. A
    // cancelled or wrong-night ticket must not be able to produce one, which is
    // the whole reason this lives here rather than on an attendee's dashboard.
    if (result.verdict === 'ADMIT') {
      verdictBox.append(bandPanel(result));
    }

    verdictBox.append(
      el('div', { class: 'verdict__actions' }, [
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--small',
          text: 'Check another',
          onClick: () => {
            verdictBox.hidden = true;
            input.value = '';
            input.focus();
          },
        }),
      ]),
    );

    verdictBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /**
   * Issue hand bands for a ticket that has just been admitted.
   *
   * One band per live seat, or one for a single named guest — a party of five
   * that arrives in two groups gets bands as each group turns up, rather than
   * five bands handed to whoever walked in first.
   */
  function bandPanel(result) {
    const live = result.seats.filter((s) => s.status === 'PENDING' || s.status === 'CONFIRMED');

    const swatches = el('div', { class: 'band-picker', role: 'radiogroup', 'aria-label': 'Band colour' });
    const paint = () => {
      for (const node of swatches.querySelectorAll('button')) {
        node.setAttribute('aria-checked', String(node.dataset.colour === bandColour));
      }
    };

    for (const colour of palette) {
      const swatch = el('button', {
        type: 'button',
        role: 'radio',
        class: 'band-picker__swatch',
        'data-colour': colour.value,
        'aria-checked': String(colour.value === bandColour),
        title: colour.label,
        'aria-label': `${colour.label} band`,
        onClick: () => {
          bandColour = colour.value;
          sessionStorage.setItem(COLOUR_KEY, bandColour);
          paint();
        },
      });
      // A custom property rather than a style attribute: the CSP blocks inline
      // style attributes, and the CSSOM is how every other swatch here is set.
      swatch.style.setProperty('--swatch', colour.swatch);
      swatches.append(swatch);
    }

    const open = (seatNumber) => {
      const params = new URLSearchParams({ colour: bandColour });
      if (seatNumber) params.set('seat', seatNumber);
      window.open(
        `/api/admin/bookings/${encodeURIComponent(result.reference)}/band?${params}`,
        '_blank',
        'noopener',
      );
    };

    const printAll = el('button', {
      type: 'button',
      class: 'btn btn--primary btn--small',
      text: live.length === 1 ? 'Print hand band' : `Print ${live.length} hand bands`,
      onClick: () => open(null),
    });

    const perGuest = el('div', { class: 'band-guests' });
    if (live.length > 1) {
      for (const seat of live) {
        perGuest.append(
          el('button', {
            type: 'button',
            class: 'band-guests__one',
            onClick: () => open(seat.seat_number),
          }, [
            el('b', { text: seat.seat_number }),
            el('span', { text: seat.guest_name || result.holder }),
            seat.is_minor ? el('i', { class: 'chip chip--wait', text: `Age ${seat.guest_age}` }) : null,
          ]),
        );
      }
    }

    return el('div', { class: 'band-issue' }, [
      el('h2', { class: 'band-issue__title', text: 'Issue hand bands' }),
      el('p', {
        class: 'band-issue__lede',
        text: palette.length
          ? 'Pick a colour, print, then wrap one round each guest’s wrist.'
          : 'Print, then wrap one round each guest’s wrist.',
      }),
      palette.length ? swatches : null,
      el('div', { class: 'band-issue__actions' }, [printAll]),
      live.length > 1
        ? el('p', { class: 'band-issue__hint', text: 'Or print one band at a time:' })
        : null,
      live.length > 1 ? perGuest : null,
    ]);
  }

  const fact = (term, value) =>
    value ? el('div', {}, [el('dt', { text: term }), el('dd', { text: value })]) : null;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const reference = input.value.trim().toUpperCase();
    if (reference) check(reference);
  });

  (async function boot() {
    try {
      const { admin } = await api('/api/admin/me');
      $('[data-admin-chip]').textContent = admin.full_name;
      $('[data-admin-chip]').className = 'chip chip--ok';
    } catch {
      window.location.href = `/admin/login.html?next=${encodeURIComponent(window.location.href)}`;
      return;
    }

    /* The palette comes from the server so the colours the picker offers and the
       colours the band renderer knows cannot drift apart. A failure here is not
       fatal: the picker is simply left out and bands print in the default. */
    try {
      const { colours, default: fallback } = await api('/api/admin/band-colours');
      palette = colours;
      if (!colours.some((c) => c.value === bandColour)) bandColour = fallback;
    } catch {
      palette = [];
    }

    // Arriving from a scan: the reference is already in the URL, so check it
    // straight away rather than making the steward press a button.
    const fromScan = new URLSearchParams(window.location.search).get('ref');
    if (fromScan) {
      input.value = fromScan.toUpperCase();
      check(input.value);
    } else {
      input.focus();
    }
  })();
})();
