'use strict';

(async function initDashboard() {
  const UI = window.UI;
  const {
    api,
    $,
    el,
    notify,
    clearNotice,
    showFieldErrors,
    formValues,
    busy,
    formatDate,
    formatShortDate,
    formatTime,
    pillFor,
    mountHeader,
    requireSession,
  } = window.CC;

  let session = await mountHeader('/dashboard.html');
  if (!requireSession(session, '/dashboard.html')) return;

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0];
  }

  function renderProfile() {
    const user = session.user;
    $('[data-greeting]').textContent = `Welcome back, ${firstName(user.full_name)}`;

    const list = $('[data-profile]');
    list.textContent = '';
    const rows = [
      ['Name', user.full_name],
      ['Email', user.email],
      ['Mobile', user.mobile_number],
      ['WhatsApp', user.whatsapp_number],
      ['Date of birth', formatDate(user.date_of_birth)],
      ['Age', `${user.age}`],
      ['Address', user.address],
      ['Emergency contact', user.emergency_contact],
    ];
    for (const [label, value] of rows) {
      list.append(el('dt', { text: label }), el('dd', { text: value || '—' }));
    }

    const form = $('#profile-form');
    form.elements.full_name.value = user.full_name;
    form.elements.mobile_number.value = user.mobile_number;
    form.elements.whatsapp_number.value = user.whatsapp_number;
    form.elements.address.value = user.address;
    form.elements.emergency_contact.value = user.emergency_contact;
  }

  function renderWhatsapp() {
    const verified = session.user.whatsapp_verified;
    $('[data-whatsapp-pill]').replaceChildren(
      pillFor(verified ? 'Verified' : 'Not verified'),
    );
    $('[data-whatsapp-pill]').firstChild.className = `pill pill--${verified ? 'ok' : 'wait'}`;

    const body = $('[data-whatsapp-body]');
    body.textContent = '';

    if (verified) {
      body.append(
        el('p', {
          class: 'muted',
          text: `${session.user.whatsapp_number} was verified on ${formatShortDate(session.user.whatsapp_verified_at)}. Booking messages go to this number.`,
        }),
      );
      return;
    }

    body.append(
      el('p', {
        class: 'muted',
        text: 'Your number is not verified yet, so you cannot book a seat. Verification takes a moment.',
      }),
      el(
        'div',
        { class: 'btn-row' },
        el('a', { class: 'btn btn--primary btn--small', href: '/verify.html', text: 'Verify now' }),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Past bookings
  //
  // Concerts that have been and gone, plus anything cancelled or expired. A
  // separate request from /api/me: it is not needed to render the page, so it
  // must not hold the page up, and most visits will never look at it.
  // --------------------------------------------------------------------------
  const PAST_LABELS = {
    CANCELLED: { text: 'Cancelled', className: 'pill pill--off' },
    EXPIRED: { text: 'Expired', className: 'pill pill--neutral' },
  };
  const ATTENDED = { text: 'Attended', className: 'pill pill--ok' };

  async function renderHistory() {
    const card = $('[data-history-card]');
    const body = $('[data-history-body]');
    const pill = $('[data-history-pill]');

    let parties = [];
    try {
      const result = await api('/api/bookings/mine/history');
      parties = result.bookings || [];
    } catch {
      // History is a nicety. If it fails the rest of the dashboard is still
      // fine, and a broken empty card says less than no card at all.
      return;
    }

    if (!parties.length) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    body.textContent = '';
    pill.textContent = '';
    pill.append(
      el('span', {
        class: 'pill pill--neutral',
        text: `${parties.length} booking${parties.length === 1 ? '' : 's'}`,
      }),
    );

    for (const party of parties) {
      const label = PAST_LABELS[party.status] || ATTENDED;
      const row = el('div', { class: 'booking-row booking-row--past' });

      const left = el('div', {}, [
        el('div', { class: 'booking-row__ref', text: party.booking_reference }),
        el('strong', { text: party.concert.name, style: 'display:block' }),
        el('div', {
          class: 'booking-row__when',
          text: `${formatDate(party.concert.event_date)} · ${party.concert.venue}`,
        }),
      ]);

      const tags = el('div', { class: 'seat-tags', style: 'margin-top:0.5rem' });
      for (const seat of party.seats) {
        tags.append(
          el('span', { class: 'seat-tag' }, [
            el('span', { text: `${seat.seat_number} · ${seat.section_name}` }),
          ]),
        );
      }
      left.append(tags);

      const footnote =
        party.status === 'CANCELLED' && party.cancelled_at
          ? `Cancelled ${formatShortDate(party.cancelled_at)}${
              party.cancel_reason ? ` · ${party.cancel_reason}` : ''
            }`
          : `Booked ${formatShortDate(party.booked_at)}`;
      left.append(
        el('div', { class: 'booking-row__when', style: 'margin-top:0.4rem', text: footnote }),
      );

      const actions = el('div', { class: 'btn-row' }, [
        el('span', { class: label.className, text: label.text }),
      ]);
      // A cancelled booking has no ticket to show: the confirmation endpoint
      // only resolves references that are still live.
      if (party.status === 'PENDING' || party.status === 'CONFIRMED') {
        const reference = encodeURIComponent(party.booking_reference);
        actions.append(
          el('a', {
            class: 'btn btn--ghost btn--small',
            href: `/api/bookings/mine/confirmation?reference=${reference}`,
            target: '_blank',
            rel: 'noopener',
            text: 'View ticket',
          }),
        );
      }

      row.append(left, actions);
      body.append(row);
    }
  }

  function renderBooking() {
    const pill = $('[data-booking-pill]');
    const body = $('[data-booking-body]');
    body.textContent = '';
    pill.textContent = '';

    const parties = session.bookings || [];
    const seatTotal = parties.reduce((total, party) => total + party.seats.length, 0);

    if (!parties.length) {
      pill.append(pillFor('No seats yet'));
      pill.firstChild.className = 'pill pill--wait';
      body.append(
        el('p', {
          class: 'muted',
          text: session.user.whatsapp_verified
            ? 'You have not chosen any seats yet. Seats are free, and you can take as many as you need while they last.'
            : 'Verify your WhatsApp number first, then choose your seats.',
        }),
        el(
          'div',
          { class: 'btn-row' },
          el('a', {
            class: 'btn btn--primary',
            href: session.user.whatsapp_verified ? '/seats.html' : '/verify.html',
            text: session.user.whatsapp_verified ? 'Choose my seats' : 'Verify WhatsApp',
          }),
        ),
      );
      return;
    }

    pill.append(pillFor(`${seatTotal} seat${seatTotal === 1 ? '' : 's'}`));
    pill.firstChild.className = 'pill pill--ok';

    // One block per reference, grouped by concert, because a person may hold
    // seats at several concerts at once.
    for (const party of parties) {
      const row = el('div', { class: 'booking-row' });

      const left = el('div', {}, [
        el('div', { class: 'booking-row__ref', text: party.booking_reference }),
        el('strong', { text: party.concert.name, style: 'display:block' }),
        el('div', {
          class: 'booking-row__when',
          text: `${formatDate(party.concert.event_date)} · ${formatTime(party.concert.start_time)} · ${party.concert.venue}`,
        }),
      ]);

      const tags = el('div', { class: 'seat-tags', style: 'margin-top:0.5rem' });
      for (const seat of party.seats) {
        const tag = el('span', { class: 'seat-tag' }, [
          el('span', { text: `${seat.seat_number} · ${seat.section_name}` }),
        ]);
        // Releasing one seat out of several is a common ask when plans change,
        // so each seat can go without losing the whole party.
        if (session.allow_self_cancel && party.seats.length > 1) {
          tag.append(
            el('button', {
              type: 'button',
              text: '×',
              title: `Release seat ${seat.seat_number}`,
              'aria-label': `Release seat ${seat.seat_number}`,
              onclick: (event) => releaseSeat(event, party, seat),
            }),
          );
        }
        tags.append(tag);
      }
      left.append(tags);
      left.append(
        el('div', {
          class: 'booking-row__when',
          style: 'margin-top:0.4rem',
          text: `Booked ${formatShortDate(party.booked_at)} · Booking fee: FREE`,
        }),
      );

      const reference = encodeURIComponent(party.booking_reference);
      const ticketUrl = `/api/bookings/mine/confirmation?reference=${reference}`;
      const actions = el('div', { class: 'btn-row' }, [
        el('a', {
          class: 'btn btn--primary btn--small',
          href: `${ticketUrl}&print=1`,
          target: '_blank',
          rel: 'noopener',
          text: 'Download ticket',
        }),
        el('a', {
          class: 'btn btn--ghost btn--small',
          href: ticketUrl,
          target: '_blank',
          rel: 'noopener',
          text: 'View',
        }),
      ]);

      if (session.allow_self_cancel) {
        actions.append(
          el('button', {
            class: 'btn btn--danger btn--small',
            type: 'button',
            text: party.seats.length === 1 ? 'Release seat' : 'Release all',
            onclick: (event) => cancelParty(event, party),
          }),
        );
      }

      row.append(left, actions);
      body.append(row);
    }

    body.append(
      el('div', { class: 'btn-row', style: 'margin-top:1.25rem' }, [
        el('a', { class: 'btn btn--primary', href: '/seats.html', text: 'Book more seats' }),
      ]),
    );
  }

  async function cancelParty(event, party) {
    const seats = party.seats.map((seat) => seat.seat_number).join(', ');
    // Captured before the await: once the dialog has been awaited the event has
    // finished dispatching and currentTarget is null.
    const button = event.currentTarget;

    // An in-app dialog rather than window.confirm: the browser's own box cannot
    // be branded, is suppressed outright in some embedded webviews, and freezes
    // the page while it is open.
    const confirmed = await UI.confirm({
      title: party.seats.length === 1 ? 'Release this seat?' : 'Release all these seats?',
      message:
        party.seats.length === 1
          ? `Seat ${seats} goes back into the pool straight away. Somebody else may take it, and there is no guarantee you can get it back.`
          : `All ${party.seats.length} seats (${seats}) for ${party.concert.name} go back into the pool straight away. Somebody else may take them.`,
      confirmLabel: party.seats.length === 1 ? 'Release seat' : 'Release all seats',
      danger: true,
      cancelLabel: 'Keep them',
      danger: true,
    });
    if (!confirmed) return;

    clearNotice('[data-notice]');
    busy(button, true, 'Releasing…');
    try {
      const result = await api(
        `/api/bookings/mine/${encodeURIComponent(party.booking_reference)}`,
        { method: 'DELETE' },
      );
      UI.toastSuccess('Seats released', result.message);
      await refresh();
    } catch (error) {
      UI.toastError('Could not release the seats', error.message);
      notify('[data-notice]', error.message, 'error');
      busy(button, false);
    }
  }

  async function releaseSeat(event, party, seat) {
    const button = event.currentTarget;
    const confirmed = await UI.confirm({
      title: `Release seat ${seat.seat_number}?`,
      message: `The rest of your party keeps theirs. Seat ${seat.seat_number} goes back into the pool straight away.`,
      confirmLabel: 'Release this seat',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!confirmed) return;

    clearNotice('[data-notice]');
    busy(button, true, 'Releasing…');
    try {
      const result = await api(
        `/api/bookings/mine/${encodeURIComponent(party.booking_reference)}?seat_id=${seat.seat_id}`,
        { method: 'DELETE' },
      );
      UI.toastSuccess('Seat released', result.message);
      await refresh();
    } catch (error) {
      UI.toastError('Could not release the seat', error.message);
      notify('[data-notice]', error.message, 'error');
      busy(button, false);
    }
  }

  async function refresh() {
    session = await api('/api/me');
    if (!session.user) {
      window.location.href = '/login.html';
      return;
    }
    renderProfile();
    renderWhatsapp();
    renderBooking();
    renderHistory();
  }

  // --- Profile editing ---
  const profileForm = $('#profile-form');
  $('[data-toggle-profile]').addEventListener('click', (event) => {
    const hidden = profileForm.hidden;
    profileForm.hidden = !hidden;
    event.currentTarget.textContent = hidden ? 'Cancel' : 'Update my details';
    if (hidden) profileForm.elements.full_name.focus();
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(profileForm, {});
    const submit = profileForm.querySelector('button[type="submit"]');

    busy(submit, true, 'Saving…');
    try {
      const result = await api('/api/me', { method: 'PATCH', body: formValues(profileForm) });
      await refresh();
      profileForm.hidden = true;
      $('[data-toggle-profile]').textContent = 'Update my details';
      notify(
        '[data-notice]',
        result.verification
          ? result.verification.message
          : 'Your details are saved.',
        result.verification ? 'warn' : 'success',
      );
      if (result.verification) setTimeout(() => (window.location.href = '/verify.html'), 1800);
    } catch (error) {
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(profileForm, error.details);
    } finally {
      busy(submit, false);
    }
  });

  // --- Password ---
  const passwordForm = $('#password-form');
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(passwordForm, {});
    const submit = passwordForm.querySelector('button[type="submit"]');

    busy(submit, true, 'Changing…');
    try {
      const result = await api('/api/me/change-password', {
        method: 'POST',
        body: {
          current_password: passwordForm.elements.current_password.value,
          new_password: passwordForm.elements.new_password.value,
        },
      });
      passwordForm.reset();
      notify('[data-notice]', result.message, 'success');
    } catch (error) {
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(passwordForm, error.details);
    } finally {
      busy(submit, false);
    }
  });

  $('[data-signout]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });

  renderProfile();
  renderWhatsapp();
  renderBooking();
  renderHistory();
})();
