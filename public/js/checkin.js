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

  const form = $('#checkin-form');
  const input = $('#reference');
  const verdictBox = $('[data-verdict]');

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
          ]),
        );
      }
      verdictBox.append(strip);
    }

    verdictBox.append(
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
    );

    verdictBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
