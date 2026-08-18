'use strict';

(async function initAdmin() {
  const {
    api,
    $,
    $$,
    el,
    notify,
    clearNotice,
    showFieldErrors,
    formValues,
    busy,
    formatDate,
    formatShortDate,
    pillFor,
    renderSeatMap,
  } = window.CC;

  // --- Session --------------------------------------------------------------
  let admin;
  try {
    admin = (await api('/api/admin/me')).admin;
  } catch {
    window.location.href = '/admin/login.html';
    return;
  }
  $('[data-admin-name]').textContent = `${admin.full_name} · ${admin.role.replace('_', ' ').toLowerCase()}`;

  $('[data-signout]').addEventListener('click', async (event) => {
    event.preventDefault();
    await api('/api/auth/admin/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/admin/login.html';
  });

  const fail = (error) => notify('[data-notice]', error.message, 'error');
  const done = (message) => notify('[data-notice]', message, 'success');

  // --- Concert scope --------------------------------------------------------
  // Several concerts can run at once, so every panel below is read against the
  // one chosen here rather than against an assumed single event.
  let concerts = [];
  let concertId = null;

  /** `?concert_id=` for the current scope, or '' when scoped to all concerts. */
  const scope = (leading = '?') => (concertId ? `${leading}concert_id=${concertId}` : '');

  const currentConcert = () => concerts.find((item) => item.id === concertId) || null;

  async function loadConcertPicker({ keepSelection = true } = {}) {
    const data = await api('/api/admin/concerts');
    concerts = data.concerts;

    if (!keepSelection || !concerts.some((item) => item.id === concertId)) {
      // Default to the next concert that has not happened yet.
      const today = new Date().toISOString().slice(0, 10);
      concertId =
        (concerts.find((item) => String(item.event_date).slice(0, 10) >= today) || concerts[0])?.id ??
        null;
    }

    const picker = $('[data-concert-picker]');
    picker.textContent = '';
    for (const item of concerts) {
      picker.append(
        el('option', {
          value: String(item.id),
          text: `${item.name} · ${String(item.event_date).slice(0, 10)}${item.is_active ? '' : ' (off)'}`,
        }),
      );
    }
    picker.append(el('option', { value: '', text: 'All concerts (export only)' }));
    picker.value = concertId === null ? '' : String(concertId);
  }

  $('[data-concert-picker]').addEventListener('change', (event) => {
    concertId = event.currentTarget.value ? Number(event.currentTarget.value) : null;
    const active = $$('[data-tab]').find((b) => b.getAttribute('aria-selected') === 'true');
    showTab(active?.dataset.tab || 'overview');
  });

  // --- Tabs -----------------------------------------------------------------
  const loaders = {
    overview: loadOverview,
    users: loadUsers,
    bookings: loadBookings,
    seats: loadSeats,
    concert: loadConcert,
    export: loadExport,
    notifications: loadNotifications,
    settings: loadSettings,
  };

  function showTab(name) {
    $$('[data-tab]').forEach((button) =>
      button.setAttribute('aria-selected', String(button.dataset.tab === name)),
    );
    $$('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    window.location.hash = name;
    clearNotice('[data-notice]');
    loaders[name]?.().catch(fail);
  }

  $$('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => showTab(button.dataset.tab)),
  );

  const emptyRow = (columns, message) =>
    el('tr', {}, el('td', { colspan: columns, class: 'table-empty', text: message }));

  function paginate(container, pagination, reload) {
    container.textContent = '';
    const { page, per_page: perPage, total } = pagination;
    const pages = Math.max(1, Math.ceil(total / perPage));
    container.append(el('span', { text: `${total} total · page ${page} of ${pages}` }));
    const buttons = el('div', { class: 'btn-row' });
    buttons.append(
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Previous',
        disabled: page <= 1,
        onclick: () => reload(page - 1),
      }),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        text: 'Next',
        disabled: page >= pages,
        onclick: () => reload(page + 1),
      }),
    );
    container.append(buttons);
  }

  // ==========================================================================
  // Overview
  // ==========================================================================
  async function loadOverview() {
    const data = await api(`/api/admin/overview${scope()}`);
    const { stats, concert } = data;

    $('[data-concert-title]').textContent = concert.name;
    $('[data-concert-line]').textContent =
      `${formatDate(concert.event_date)} · ${concert.venue}`;

    const figures = [
      ['Total capacity', stats.max_capacity, ''],
      ['Registered users', stats.registered_users, ''],
      ['WhatsApp verified', stats.whatsapp_verified_users, 'figure--verdigris'],
      ['Booked seats', stats.booked_seats, 'figure--ruby'],
      ['Available seats', stats.available_seats, ''],
      ['Remaining capacity', stats.remaining_capacity, ''],
      ['Held seats', stats.reserved_seats, 'figure--ruby'],
      ['Total seats', stats.total_seats, ''],
    ];
    const box = $('[data-figures]');
    box.textContent = '';
    for (const [label, value, variant] of figures) {
      box.append(
        el('div', { class: `figure ${variant}`.trim() }, [
          el('div', { class: 'figure__value', text: String(value) }),
          el('div', { class: 'figure__label', text: label }),
        ]),
      );
    }

    if (stats.fully_booked) {
      notify(
        '[data-notice]',
        'Fully booked: no more seats can be taken. Raise the capacity or release a seat to reopen booking.',
        'warn',
      );
    } else if (data.failed_notifications > 0) {
      notify(
        '[data-notice]',
        `${data.failed_notifications} WhatsApp messages failed to send. Open Notifications to see why.`,
        'warn',
      );
    }

    const body = $('[data-recent-bookings]');
    body.textContent = '';
    if (!data.recent_bookings.length) {
      body.append(emptyRow(5, 'No bookings yet.'));
    } else {
      for (const booking of data.recent_bookings) {
        body.append(
          el('tr', {}, [
            el('td', { class: 'num', text: booking.booking_reference }),
            el('td', { text: booking.full_name }),
            el('td', { class: 'num', text: booking.seat_number }),
            el('td', {}, pillFor(booking.status)),
            el('td', { text: formatShortDate(booking.created_at) }),
          ]),
        );
      }
    }
  }

  $('[data-refresh-overview]').addEventListener('click', () => loadOverview().catch(fail));

  // ==========================================================================
  // Users
  // ==========================================================================
  async function loadUsers(page = 1) {
    const params = new URLSearchParams({ page: String(page) });
    const search = $('[data-user-search]').value.trim();
    if (search) params.set('search', search);
    for (const [key, selector] of [
      ['status', '[data-user-status]'],
      ['verified', '[data-user-verified]'],
      ['booked', '[data-user-booked]'],
    ]) {
      const value = $(selector).value;
      if (value) params.set(key, value);
    }

    const data = await api(`/api/admin/users?${params}`);
    const body = $('[data-users]');
    body.textContent = '';

    if (!data.users.length) {
      body.append(emptyRow(7, 'No users match that search.'));
    }

    for (const user of data.users) {
      body.append(
        el('tr', {}, [
          el('td', {}, [
            el('strong', { text: user.full_name }),
            el('div', { class: 'muted', style: 'font-size:0.75rem', text: user.email }),
          ]),
          el('td', { class: 'num' }, [
            el('div', { text: user.mobile_number }),
            el('div', { class: 'muted', style: 'font-size:0.75rem', text: user.whatsapp_number }),
          ]),
          el('td', { class: 'num', text: String(user.age) }),
          el('td', {}, pillFor(user.whatsapp_verified ? 'Verified' : 'Not verified')),
          el('td', { class: 'num', text: user.seat_number || '—' }),
          el('td', {}, pillFor(user.is_active ? 'Active' : 'Disabled')),
          el('td', {}, [
            el('div', { class: 'btn-row' }, [
              el('button', {
                class: 'btn btn--ghost btn--small',
                type: 'button',
                text: 'View',
                onclick: () => showUser(user.id),
              }),
              el('button', {
                class: user.is_active ? 'btn btn--danger btn--small' : 'btn btn--ghost btn--small',
                type: 'button',
                text: user.is_active ? 'Disable' : 'Enable',
                onclick: () => toggleUser(user, page),
              }),
            ]),
          ]),
        ]),
      );
    }

    // The pill helper defaults to neutral for words it does not know; recolour
    // the status pills so they read at a glance.
    $$('[data-users] .pill').forEach((pill) => {
      if (pill.textContent === 'Verified' || pill.textContent === 'Active') {
        pill.className = 'pill pill--ok';
      } else if (pill.textContent === 'Not verified') {
        pill.className = 'pill pill--wait';
      } else if (pill.textContent === 'Disabled') {
        pill.className = 'pill pill--off';
      }
    });

    paginate($('[data-users-pagination]'), data.pagination, (p) => loadUsers(p).catch(fail));
  }

  async function toggleUser(user, page) {
    const disabling = Boolean(user.is_active);
    let reason = null;
    if (disabling) {
      reason = window.prompt(
        `Disable ${user.full_name}? They will be signed out and cannot book. Reason (optional):`,
        '',
      );
      if (reason === null) return;
    }
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: { is_active: !disabling, disabled_reason: reason || null },
      });
      done(`${user.full_name} is now ${disabling ? 'disabled' : 'active'}.`);
      await loadUsers(page);
    } catch (error) {
      fail(error);
    }
  }

  async function showUser(id) {
    const panel = $('[data-user-detail]');
    panel.hidden = false;
    panel.textContent = 'Loading…';

    const data = await api(`/api/admin/users/${id}`);
    const user = data.user;
    panel.textContent = '';

    panel.append(
      el('div', { class: 'card__head', style: 'padding:0 0 1rem;margin-bottom:1rem' }, [
        el('h2', { text: user.full_name, style: 'margin:0' }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Close',
          onclick: () => {
            panel.hidden = true;
          },
        }),
      ]),
    );

    const list = el('dl', { class: 'detail' });
    for (const [label, value] of [
      ['Email', user.email],
      ['Mobile', user.mobile_number],
      ['WhatsApp', user.whatsapp_number],
      ['WhatsApp verified', user.whatsapp_verified ? formatShortDate(user.whatsapp_verified_at) : 'No'],
      ['Date of birth', formatDate(user.date_of_birth)],
      ['Age', String(user.age)],
      ['Gender', String(user.gender).replace(/_/g, ' ').toLowerCase()],
      ['Address', user.address],
      ['Emergency contact', user.emergency_contact],
      ['Terms accepted', formatShortDate(user.terms_accepted_at)],
      ['Account', user.is_active ? 'Active' : `Disabled — ${user.disabled_reason || 'no reason given'}`],
      ['Registered', formatShortDate(user.created_at)],
      ['Last sign-in', user.last_login_at ? formatShortDate(user.last_login_at) : 'Never'],
    ]) {
      list.append(el('dt', { text: label }), el('dd', { text: value || '—' }));
    }
    panel.append(list);

    panel.append(el('h3', { text: 'Bookings', style: 'margin-top:1.5rem' }));
    if (!data.bookings.length) {
      panel.append(el('p', { class: 'muted', text: 'No bookings on this account.' }));
    } else {
      const table = el('table');
      table.append(
        el(
          'thead',
          {},
          el('tr', {}, [
            el('th', { text: 'Reference' }),
            el('th', { text: 'Seat' }),
            el('th', { text: 'Status' }),
            el('th', { text: 'Created' }),
          ]),
        ),
      );
      const tbody = el('tbody');
      for (const booking of data.bookings) {
        tbody.append(
          el('tr', {}, [
            el('td', { class: 'num', text: booking.booking_reference }),
            el('td', { class: 'num', text: booking.seat_number }),
            el('td', {}, pillFor(booking.status)),
            el('td', { text: formatShortDate(booking.created_at) }),
          ]),
        );
      }
      table.append(tbody);
      panel.append(el('div', { class: 'table-scroll' }, table));
    }

    panel.append(el('h3', { text: 'Recent messages', style: 'margin-top:1.5rem' }));
    if (!data.notifications.length) {
      panel.append(el('p', { class: 'muted', text: 'Nothing sent yet.' }));
    } else {
      const list2 = el('div', { class: 'table-scroll' });
      const table = el('table');
      const tbody = el('tbody');
      for (const message of data.notifications) {
        tbody.append(
          el('tr', {}, [
            el('td', { text: message.type.replace(/_/g, ' ').toLowerCase() }),
            el('td', {}, pillFor(message.status)),
            el('td', { text: message.failure_reason || formatShortDate(message.created_at) }),
          ]),
        );
      }
      table.append(tbody);
      list2.append(table);
      panel.append(list2);
    }

    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('[data-user-search-go]').addEventListener('click', () => loadUsers(1).catch(fail));
  $('[data-user-search]').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadUsers(1).catch(fail);
  });

  // ==========================================================================
  // Bookings
  // ==========================================================================
  async function loadBookings(page = 1) {
    const params = new URLSearchParams({ page: String(page) });
    if (concertId) params.set('concert_id', String(concertId));
    const search = $('[data-booking-search]').value.trim();
    if (search) params.set('search', search);
    const status = $('[data-booking-status]').value;
    if (status) params.set('status', status);

    const data = await api(`/api/admin/bookings?${params}`);
    const body = $('[data-bookings]');
    body.textContent = '';

    if (!data.bookings.length) body.append(emptyRow(7, 'No bookings match that search.'));

    for (const booking of data.bookings) {
      const isActive = ['PENDING', 'CONFIRMED'].includes(booking.status);
      body.append(
        el('tr', {}, [
          el('td', { class: 'num', text: booking.booking_reference }),
          el('td', {}, [
            el('strong', { text: booking.full_name }),
            el('div', {
              class: 'muted',
              style: 'font-size:0.75rem',
              text: `${booking.whatsapp_number}${booking.whatsapp_verified ? '' : ' (unverified)'}`,
            }),
          ]),
          el('td', { class: 'num', text: `${booking.seat_number}` }),
          el('td', {}, pillFor(booking.status)),
          el('td', { text: booking.source.toLowerCase() }),
          el('td', { text: formatShortDate(booking.created_at) }),
          el('td', {}, [
            isActive
              ? el('div', { class: 'btn-row' }, [
                  el('button', {
                    class: 'btn btn--ghost btn--small',
                    type: 'button',
                    text: 'Move seat',
                    onclick: () => reassign(booking, page),
                  }),
                  el('button', {
                    class: 'btn btn--danger btn--small',
                    type: 'button',
                    text: 'Cancel',
                    onclick: () => cancel(booking, page),
                  }),
                ])
              : el('span', {
                  class: 'muted',
                  style: 'font-size:0.75rem',
                  text: booking.cancel_reason || '—',
                }),
          ]),
        ]),
      );
    }

    paginate($('[data-bookings-pagination]'), data.pagination, (p) => loadBookings(p).catch(fail));
  }

  async function cancel(booking, page) {
    const reason = window.prompt(
      `Cancel ${booking.booking_reference} and release seat ${booking.seat_number}? Reason (optional):`,
      '',
    );
    if (reason === null) return;
    try {
      const result = await api(`/api/admin/bookings/${booking.id}`, {
        method: 'DELETE',
        body: { reason: reason || null },
      });
      done(result.message);
      await loadBookings(page);
    } catch (error) {
      fail(error);
    }
  }

  async function reassign(booking, page) {
    const { sections } = await api(`/api/admin/seats${scope()}`);
    const options = sections
      .flatMap((section) => section.seats)
      .filter((seat) => seat.status !== 'DISABLED' && !seat.booking)
      .map((seat) => seat.seat_number);

    if (!options.length) {
      notify('[data-notice]', 'There is no free seat to move this booking to.', 'warn');
      return;
    }

    const answer = window.prompt(
      `Move ${booking.booking_reference} from ${booking.seat_number}.\nFree seats: ${options.join(', ')}\n\nNew seat number:`,
      options[0],
    );
    if (!answer) return;

    const target = sections
      .flatMap((section) => section.seats)
      .find((seat) => seat.seat_number.toUpperCase() === answer.trim().toUpperCase());

    if (!target) {
      notify('[data-notice]', `There is no seat called ${answer.trim()}.`, 'error');
      return;
    }

    try {
      const result = await api(`/api/admin/bookings/${booking.id}`, {
        method: 'PATCH',
        body: { seat_id: target.id },
      });
      done(result.message);
      await loadBookings(page);
    } catch (error) {
      fail(error);
    }
  }

  $('[data-booking-search-go]').addEventListener('click', () => loadBookings(1).catch(fail));
  $('[data-booking-search]').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadBookings(1).catch(fail);
  });

  // --- Manual booking ---
  const manualPanel = $('[data-manual-form]');
  $('[data-manual-booking]').addEventListener('click', async () => {
    manualPanel.hidden = false;
    try {
      const [{ users }, { sections }] = await Promise.all([
        api('/api/admin/users?per_page=100&booked=no&status=active'),
        api(`/api/admin/seats${scope()}`),
      ]);

      const userSelect = $('#manual_user');
      userSelect.textContent = '';
      if (!users.length) {
        userSelect.append(el('option', { value: '', text: 'Every active user already has a seat' }));
      }
      for (const user of users) {
        userSelect.append(
          el('option', {
            value: String(user.id),
            text: `${user.full_name} — ${user.email}${user.whatsapp_verified ? '' : ' (WhatsApp unverified)'}`,
          }),
        );
      }

      const seatSelect = $('#manual_seat');
      seatSelect.textContent = '';
      for (const section of sections) {
        for (const seat of section.seats) {
          if (seat.booking || seat.status === 'DISABLED') continue;
          seatSelect.append(
            el('option', {
              value: String(seat.id),
              text: `${seat.seat_number} — ${section.name}${seat.status === 'RESERVED' ? ' (held)' : ''}`,
            }),
          );
        }
      }
      manualPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      fail(error);
    }
  });

  $('[data-manual-cancel]').addEventListener('click', () => {
    manualPanel.hidden = true;
  });

  $('#manual-booking-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Creating…');
    try {
      const result = await api('/api/admin/bookings', {
        method: 'POST',
        body: { ...formValues(form), concert_id: concertId },
      });
      done(`Created ${result.booking.booking_reference} on seat ${result.booking.seat_number}.`);
      manualPanel.hidden = true;
      form.reset();
      await loadBookings(1);
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  // ==========================================================================
  // Seats
  // ==========================================================================
  async function loadSeats() {
    const data = await api(`/api/admin/seats${scope()}`);

    const bulkSection = $('#bulk_section');
    const current = bulkSection.value;
    bulkSection.textContent = '';
    for (const section of data.sections) {
      bulkSection.append(el('option', { value: String(section.id), text: section.name }));
    }
    if (current) bulkSection.value = current;

    const tools = $('[data-section-tools]');
    tools.textContent = '';
    for (const section of data.sections) {
      tools.append(
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: `Delete ${section.name}`,
          onclick: () => deleteSection(section),
        }),
      );
    }

    renderSeatMap($('[data-admin-seatmap]'), data.sections, {
      renderActions: (seat) => {
        const actions = el('div', { class: 'seat-actions' });
        if (seat.booking) {
          actions.append(
            el('button', {
              type: 'button',
              text: 'release',
              title: `Booked by ${seat.booking.occupant_name}. Releasing cancels that booking.`,
              onclick: () => seatAction(seat, 'release'),
            }),
          );
        } else if (seat.status === 'RESERVED') {
          actions.append(
            el('button', { type: 'button', text: 'free', onclick: () => seatAction(seat, 'release') }),
          );
        } else if (seat.status === 'DISABLED') {
          actions.append(
            el('button', { type: 'button', text: 'enable', onclick: () => setSeatStatus(seat, 'AVAILABLE') }),
          );
        } else {
          actions.append(
            el('button', { type: 'button', text: 'hold', onclick: () => seatAction(seat, 'reserve') }),
            el('button', { type: 'button', text: 'off', onclick: () => setSeatStatus(seat, 'DISABLED') }),
            el('button', { type: 'button', text: 'delete', onclick: () => deleteSeat(seat) }),
          );
        }
        return actions;
      },
    });

    // Name the occupant on booked seats so stewards can check the plan.
    for (const section of data.sections) {
      for (const seat of section.seats) {
        if (!seat.booking) continue;
        const node = $(`[data-seat-id="${seat.id}"]`, $('[data-admin-seatmap]'));
        if (node) {
          node.title = `${seat.seat_number} — ${seat.booking.occupant_name} (${seat.booking.reference})`;
        }
      }
    }
  }

  async function seatAction(seat, action) {
    if (action === 'release' && seat.booking) {
      const ok = window.confirm(
        `Seat ${seat.seat_number} is booked by ${seat.booking.occupant_name}. Releasing it cancels ${seat.booking.reference} and messages them. Continue?`,
      );
      if (!ok) return;
    }
    try {
      const result = await api(`/api/admin/seats/${seat.id}/${action}`, { method: 'POST', body: {} });
      done(result.message);
      await loadSeats();
    } catch (error) {
      fail(error);
    }
  }

  async function setSeatStatus(seat, status) {
    try {
      await api(`/api/admin/seats/${seat.id}`, { method: 'PATCH', body: { status } });
      done(`Seat ${seat.seat_number} is now ${status.toLowerCase()}.`);
      await loadSeats();
    } catch (error) {
      fail(error);
    }
  }

  async function deleteSeat(seat) {
    if (!window.confirm(`Delete seat ${seat.seat_number}?`)) return;
    try {
      const result = await api(`/api/admin/seats/${seat.id}`, { method: 'DELETE' });
      done(result.message || `Seat ${seat.seat_number} deleted.`);
      await loadSeats();
    } catch (error) {
      fail(error);
    }
  }

  async function deleteSection(section) {
    if (!window.confirm(`Delete ${section.name} and all of its seats?`)) return;
    try {
      await api(`/api/admin/sections/${section.id}`, { method: 'DELETE' });
      done(`${section.name} deleted.`);
      await loadSeats();
    } catch (error) {
      fail(error);
    }
  }

  $('#section-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Adding…');
    try {
      await api('/api/admin/sections', {
        method: 'POST',
        body: { ...formValues(form), concert_id: concertId },
      });
      done('Section added.');
      form.reset();
      await loadSeats();
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  $('#bulk-seat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Adding…');
    try {
      const result = await api('/api/admin/seats/bulk', {
        method: 'POST',
        body: { ...formValues(form), concert_id: concertId },
      });
      done(result.message);
      await loadSeats();
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  // ==========================================================================
  // Concert
  // ==========================================================================
  const toLocalInput = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  async function loadConcert() {
    await loadConcertTable();
    if (!concertId) {
      notify('[data-notice]', 'Choose a single concert above to edit its settings.', 'warn');
      return;
    }
    const { concert, stats } = await api(`/api/admin/concert${scope()}`);
    const form = $('#concert-form');

    form.elements.name.value = concert.name ?? '';
    form.elements.description.value = concert.description ?? '';
    form.elements.event_date.value = String(concert.event_date ?? '').slice(0, 10);
    form.elements.start_time.value = String(concert.start_time ?? '').slice(0, 5);
    form.elements.end_time.value = String(concert.end_time ?? '').slice(0, 5);
    form.elements.venue.value = concert.venue ?? '';
    form.elements.address.value = concert.address ?? '';
    form.elements.max_capacity.value = concert.max_capacity ?? 10;
    form.elements.booking_ref_prefix.value = concert.booking_ref_prefix ?? 'CHC';
    form.elements.max_seats_per_booking.value = concert.max_seats_per_booking ?? 0;
    form.elements.registration_opens_at.value = toLocalInput(concert.registration_opens_at);
    form.elements.registration_closes_at.value = toLocalInput(concert.registration_closes_at);
    form.elements.booking_opens_at.value = toLocalInput(concert.booking_opens_at);
    form.elements.booking_closes_at.value = toLocalInput(concert.booking_closes_at);

    form.elements.max_capacity.min = String(Math.max(1, stats.booked_seats));
    $('[data-error-for="max_capacity"]').textContent = '';
    if (stats.booked_seats > 0) {
      $('#c_capacity').nextElementSibling.textContent =
        `The hard limit on confirmed bookings. ${stats.booked_seats} seats are already taken, so it cannot go below that.`;
    }
  }

  $('#concert-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Saving…');
    try {
      const result = await api(`/api/admin/concerts/${concertId}`, {
        method: 'PATCH',
        body: formValues(form),
      });
      done(result.message);
      await loadConcert();
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  // --- Concert list ---------------------------------------------------------
  async function loadConcertTable() {
    await loadConcertPicker();
    const body = $('[data-concerts-table]');
    body.textContent = '';

    for (const item of concerts) {
      const availability = item.availability || {};
      const isCurrent = item.id === concertId;

      const row = el('tr', { style: isCurrent ? 'background:rgba(242,163,29,0.08)' : null }, [
        el('td', {}, [
          el('strong', { text: item.name }),
          el('div', {
            class: 'muted',
            style: 'font-size:0.75rem',
            text: `${item.venue} · references ${item.booking_ref_prefix}-…`,
          }),
        ]),
        el('td', { class: 'num', text: String(item.event_date).slice(0, 10) }),
        el('td', { class: 'num', text: String(availability.max_capacity ?? '—') }),
        el('td', { class: 'num', text: String(availability.booked_seats ?? 0) }),
        el('td', { class: 'num', text: String(availability.total_seats ?? 0) }),
        el('td', {}, [
          !item.is_active
            ? el('span', { class: 'pill pill--off', text: 'Off' })
            : availability.fully_booked
              ? el('span', { class: 'pill pill--wait', text: 'Full' })
              : el('span', { class: 'pill pill--ok', text: 'Open' }),
        ]),
        el('td', {}, [
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'btn btn--ghost btn--small',
              type: 'button',
              text: isCurrent ? 'Editing' : 'Edit',
              disabled: isCurrent,
              onclick: () => {
                concertId = item.id;
                $('[data-concert-picker]').value = String(item.id);
                showTab('concert');
              },
            }),
            el('button', {
              class: 'btn btn--danger btn--small',
              type: 'button',
              text: 'Delete',
              onclick: () => deleteConcert(item),
            }),
          ]),
        ]),
      ]);
      body.append(row);
    }

    const editing = currentConcert();
    $('[data-concert-editing]').textContent = editing
      ? `Edit "${editing.name}"`
      : 'Choose a concert above to edit it';
  }

  async function deleteConcert(item) {
    if (
      !window.confirm(
        `Delete "${item.name}"? Its sections and seats go with it. Bookings must be cancelled first.`,
      )
    ) {
      return;
    }
    try {
      const result = await api(`/api/admin/concerts/${item.id}`, { method: 'DELETE' });
      done(result.message);
      if (concertId === item.id) concertId = null;
      await loadConcertPicker({ keepSelection: false });
      await loadConcert();
    } catch (error) {
      fail(error);
    }
  }

  const newConcertPanel = $('[data-new-concert-form]');
  $('[data-new-concert]').addEventListener('click', () => {
    newConcertPanel.hidden = false;
    newConcertPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('[data-cancel-new-concert]').addEventListener('click', () => {
    newConcertPanel.hidden = true;
  });

  $('#new-concert-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');
    busy(submit, true, 'Creating…');
    try {
      const result = await api('/api/admin/concerts', { method: 'POST', body: formValues(form) });
      done(result.message);
      form.reset();
      newConcertPanel.hidden = true;
      concertId = result.concert.id;
      await loadConcert();
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  $('[data-duplicate-concert]').addEventListener('click', async () => {
    const source = currentConcert();
    if (!source) {
      notify('[data-notice]', 'Choose a concert to copy first.', 'warn');
      return;
    }
    const date = window.prompt(
      `Copy the seat layout of "${source.name}" onto a new date.\nSeats come across as free; bookings do not.\n\nDate for the new concert (YYYY-MM-DD):`,
      String(source.event_date).slice(0, 10),
    );
    if (!date) return;
    const name = window.prompt('Name for the new concert:', `${source.name} (copy)`);
    if (!name) return;

    try {
      const result = await api(`/api/admin/concerts/${source.id}/duplicate`, {
        method: 'POST',
        body: { name, event_date: date },
      });
      done(result.message);
      concertId = result.concert.id;
      await loadConcert();
    } catch (error) {
      fail(error);
    }
  });

  // ==========================================================================
  // Export
  // ==========================================================================
  async function loadExport() {
    await loadConcertPicker();
    const concert = currentConcert();
    const label = concert ? `"${concert.name}"` : 'every concert';

    // Links are plain hrefs so the browser downloads them itself, with the
    // session cookie attached. Nothing is held in memory.
    $('[data-export-users]').href = `/api/admin/export/users.csv${scope()}`;
    $('[data-export-users-note]').textContent = concert
      ? `Seat columns count only seats held for ${label}.`
      : 'Seat columns count seats held across all concerts.';

    updateBookingExportLink();
    $('[data-export-bookings-note]').textContent = `Covers ${label}.`;
  }

  function updateBookingExportLink() {
    const status = $('[data-export-status]').value;
    const params = new URLSearchParams({ status });
    if (concertId) params.set('concert_id', String(concertId));
    $('[data-export-bookings]').href = `/api/admin/export/bookings.csv?${params}`;
  }

  $('[data-export-status]').addEventListener('change', updateBookingExportLink);

  // ==========================================================================
  // Notifications
  // ==========================================================================
  async function loadNotifications(page = 1) {
    const params = new URLSearchParams({ page: String(page) });
    const search = $('[data-notif-search]').value.trim();
    if (search) params.set('search', search);
    for (const [key, selector] of [
      ['status', '[data-notif-status]'],
      ['type', '[data-notif-type]'],
    ]) {
      const value = $(selector).value;
      if (value) params.set(key, value);
    }

    const data = await api(`/api/admin/notifications?${params}`);
    const body = $('[data-notifications]');
    body.textContent = '';

    if (!data.notifications.length) body.append(emptyRow(5, 'Nothing has been sent yet.'));

    for (const message of data.notifications) {
      body.append(
        el('tr', {}, [
          el('td', { text: message.type.replace(/_/g, ' ').toLowerCase() }),
          el('td', {}, [
            el('div', { class: 'mono', style: 'font-size:0.75rem', text: message.recipient }),
            message.full_name
              ? el('div', { class: 'muted', style: 'font-size:0.75rem', text: message.full_name })
              : null,
          ]),
          el('td', {}, pillFor(message.status)),
          el('td', { text: message.sent_at ? formatShortDate(message.sent_at) : '—' }),
          el('td', {
            class: 'muted',
            style: 'font-size:0.75rem;max-width:22rem',
            text: message.failure_reason || '—',
          }),
        ]),
      );
    }

    paginate($('[data-notifications-pagination]'), data.pagination, (p) =>
      loadNotifications(p).catch(fail),
    );
  }

  $('[data-notif-search-go]').addEventListener('click', () => loadNotifications(1).catch(fail));
  $('[data-send-reminders]').addEventListener('click', async (event) => {
    if (!window.confirm('Send the event reminder to everyone holding a seat?')) return;
    busy(event.currentTarget, true, 'Sending…');
    try {
      const result = await api('/api/admin/notifications/remind', {
        method: 'POST',
        body: { concert_id: concertId },
      });
      done(result.message);
      await loadNotifications(1);
    } catch (error) {
      fail(error);
    } finally {
      busy(event.currentTarget, false);
    }
  });

  // ==========================================================================
  // Settings
  // ==========================================================================
  async function loadSettings() {
    const { settings } = await api('/api/admin/settings');
    $('#s_min_age').value = settings.minimum_age;
    $('#s_require_wa').checked = Boolean(settings.require_whatsapp_verification);
    $('#s_self_cancel').checked = Boolean(settings.allow_user_self_cancel);
    for (const box of $$('[data-dup]')) {
      box.checked = (settings.duplicate_check_fields || []).includes(box.dataset.dup);
    }
    await loadAudit();
  }

  async function loadAudit() {
    const data = await api('/api/admin/audit-logs?per_page=20');
    const body = $('[data-audit]');
    body.textContent = '';
    if (!data.logs.length) {
      body.append(emptyRow(4, 'No activity recorded yet.'));
      return;
    }
    for (const log of data.logs) {
      body.append(
        el('tr', {}, [
          el('td', { style: 'white-space:nowrap', text: formatShortDate(log.created_at) }),
          el('td', { text: log.actor_label || log.actor_type.toLowerCase() }),
          el('td', { class: 'mono', style: 'font-size:0.6875rem', text: log.action }),
          el('td', {
            text: log.entity_type ? `${log.entity_type.toLowerCase()} ${log.entity_id ?? ''}`.trim() : '—',
          }),
        ]),
      );
    }
  }

  $('[data-refresh-audit]').addEventListener('click', () => loadAudit().catch(fail));

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    const duplicateFields = $$('[data-dup]')
      .filter((box) => box.checked)
      .map((box) => box.dataset.dup);

    if (!duplicateFields.length) {
      notify('[data-notice]', 'Keep at least one field unique per account.', 'error');
      return;
    }

    busy(submit, true, 'Saving…');
    try {
      const result = await api('/api/admin/settings', {
        method: 'PATCH',
        body: {
          minimum_age: Number($('#s_min_age').value),
          require_whatsapp_verification: $('#s_require_wa').checked,
          allow_user_self_cancel: $('#s_self_cancel').checked,
          duplicate_check_fields: duplicateFields,
        },
      });
      done(result.message);
    } catch (error) {
      fail(error);
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });

  // --- Start ----------------------------------------------------------------
  try {
    await loadConcertPicker({ keepSelection: false });
  } catch (error) {
    fail(error);
  }

  const initial = window.location.hash.replace('#', '');
  showTab(loaders[initial] ? initial : 'overview');
})();
