/* The staff console.
 *
 * One page, eight panels, no router — the sidebar swaps which panel is visible
 * and the hash keeps that survivable across a reload. Each panel loads its own
 * data the first time it is opened and caches it until something invalidates it,
 * so switching back and forth does not re-query the server.
 */
'use strict';

(function initConsole() {
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
    formatTime,
    enhanceFields,
  } = window.CC;

  const UI = window.UI;

  // ==========================================================================
  // State
  // ==========================================================================

  const state = {
    admin: null,
    concerts: [],
    concertId: null,
    tab: 'overview',
    settings: {},
    loaded: {},
    seat: { map: null, zoom: 1, zone: 'all', selected: null, search: '' },
    bookings: { page: 1, search: '', status: '', concert: '', whatsapp: '' },
    users: { page: 1, search: '', status: '', verified: '', booked: '' },
    notif: { page: 1, category: 'ALL' },
    reports: { days: 90, concertId: '' },
    chartDays: 30,
    concertView: 'cards',
  };

  const PANELS = {
    overview: { title: 'Overview', crumb: 'Overview' },
    concerts: { title: 'Concerts', crumb: 'Concerts' },
    seats: { title: 'Seat Management', crumb: 'Seat Management' },
    bookings: { title: 'Bookings', crumb: 'Bookings' },
    attendees: { title: 'Attendees', crumb: 'Attendees' },
    notifications: { title: 'Notifications', crumb: 'Notifications' },
    reports: { title: 'Reports & Export', crumb: 'Reports & Export' },
    settings: { title: 'Settings', crumb: 'Settings' },
  };

  // The bundled posters, used when a concert has none of its own. Chosen by id
  // rather than at random so a concert keeps the same picture between reloads.
  const POSTERS = [
    '/assets/posters/choir-night.svg',
    '/assets/posters/carols.svg',
    '/assets/posters/strings.svg',
    '/assets/posters/organ-recital.svg',
    '/assets/posters/gospel-evening.svg',
  ];
  const posterFor = (concert) =>
    concert.poster_path || POSTERS[(Number(concert.id) || 0) % POSTERS.length];

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  /** Point a masked icon element at its SVG. Via CSSOM, which the CSP allows. */
  function paintIcon(node, name, property) {
    node.style.setProperty(property, `url('/assets/icons/${name}.svg')`);
  }

  function paintAllIcons(scope = document) {
    $$('[data-nav-icon]', scope).forEach((n) => paintIcon(n, n.dataset.navIcon, '--nav-icon'));
    $$('[data-btn-icon]', scope).forEach((n) => paintIcon(n, n.dataset.btnIcon, '--btn-icon'));
    $$('[data-kpi-icon]', scope).forEach((n) => paintIcon(n, n.dataset.kpiIcon, '--kpi-icon'));
    $$('[data-meta-icon]', scope).forEach((n) => paintIcon(n, n.dataset.metaIcon, '--meta-icon'));
    $$('[data-notif-icon]', scope).forEach((n) => paintIcon(n, n.dataset.notifIcon, '--notif-icon'));
    $$('[data-export-icon]', scope).forEach((n) => paintIcon(n, n.dataset.exportIcon, '--export-icon'));
    $$('[data-icon-var]', scope).forEach((n) => {
      const target = n.querySelector('.export-card__icon');
      if (target) paintIcon(target, n.dataset.iconVar, '--export-icon');
    });
  }

  const initials = (name) =>
    String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?';

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  /** "3 minutes ago", falling back to a date once it stops being useful. */
  function relativeTime(value) {
    const then = new Date(value);
    if (Number.isNaN(then.getTime())) return '—';
    const seconds = Math.round((Date.now() - then.getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return formatShortDate(value);
  }

  const statusChip = (status) => {
    const tone = {
      CONFIRMED: 'ok',
      PENDING: 'wait',
      CANCELLED: 'off',
      EXPIRED: 'neutral',
      AVAILABLE: 'ok',
      BOOKED: 'neutral',
      RESERVED: 'wait',
      DISABLED: 'off',
      SENT: 'ok',
      DELIVERED: 'ok',
      READ: 'ok',
      QUEUED: 'wait',
      FAILED: 'off',
    }[status];
    const label = { DISABLED: 'BLOCKED' }[status] || status || '—';
    return el('span', { class: `chip chip--${tone || 'neutral'}`, text: label });
  };

  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

  function occupancyTone(percent) {
    if (percent >= 100) return 'occupancy--full';
    if (percent >= 80) return 'occupancy--high';
    return '';
  }

  /** The server's real complaint, when it gave one. */
  function causeOf(error) {
    if (!error?.serverStack) return null;
    return String(error.serverStack).split('\n')[0].trim();
  }

  /** Report a failed request once, in the way that suits where it happened. */
  function fail(error, context) {
    if (error?.status === 401) {
      window.location.href = '/admin/login.html';
      return;
    }
    console.error(`[console] ${context}:`, error);
    // A 500 says "something went wrong on our side" and nothing else, which is
    // right for an attendee and useless for staff. The stack's first line names
    // the actual fault and is only present outside production.
    const cause = causeOf(error);
    UI.toastError(context, cause || error?.message || 'Something went wrong.');
  }

  /**
   * Paint a panel's own failure state, so a load that did not work stops
   * looking like a load that has not finished. Left as skeletons, the console
   * appears to be hanging forever.
   */
  function failPanel(tab, error) {
    const target = PANEL_BODY[tab] && $(PANEL_BODY[tab]);
    if (!target) return;
    UI.failure(target, {
      title: `Could not load ${PANELS[tab].title}`,
      message:
        error?.status >= 500
          ? 'The server could not answer. Nothing has been changed.'
          : error?.message || 'The request did not go through.',
      detail: error?.serverStack || null,
      onRetry: () => load(tab, { force: true }),
    });
  }

  /** Where a panel's failure state goes when its data will not load. */
  const PANEL_BODY = {
    overview: '[data-kpis]',
    concerts: '[data-concerts-view]',
    seats: '[data-viewport]',
    bookings: '[data-bookings-table]',
    attendees: '[data-users-table]',
    notifications: '[data-notif-list]',
    reports: '[data-report-kpis]',
    settings: '[data-settings-body]',
  };

  const setWidth = (node, percent) => {
    node.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  };

  // ==========================================================================
  // Shell: navigation, sidebar, search, bell
  // ==========================================================================

  function setTab(tab, { push = true } = {}) {
    if (!PANELS[tab]) tab = 'overview';
    state.tab = tab;

    $$('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
    // Scoped to [data-tab]: the sidebar also holds a plain link (Door check-in)
    // that leaves the console entirely, and it is not a tab.
    $$('.sidebar__link[data-tab]').forEach((link) => {
      const active = link.dataset.tab === tab;
      link.setAttribute('aria-selected', String(active));
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    $('[data-topbar-title]').textContent = PANELS[tab].title;
    const crumb = $('[data-breadcrumb]');
    crumb.textContent = '';
    crumb.append(
      el('li', {}, [el('a', { href: '#overview', text: 'Console' })]),
      el('li', { 'aria-current': 'page', text: PANELS[tab].crumb }),
    );

    if (push && window.location.hash !== `#${tab}`) window.location.hash = tab;
    $('[data-console]').removeAttribute('data-mobile-nav');
    $('[data-mobile-toggle]').setAttribute('aria-expanded', 'false');

    load(tab);
  }

  function mountShell() {
    paintAllIcons();

    $$('.sidebar__link[data-tab]').forEach((link) => {
      link.addEventListener('click', () => setTab(link.dataset.tab));
    });
    $$('[data-goto]').forEach((node) => {
      node.addEventListener('click', () => setTab(node.dataset.goto));
    });

    // Collapse is remembered: a staff member who wants the narrow rail wants it
    // every time, not once per session.
    const console_ = $('[data-console]');
    const stored = localStorage.getItem('cc:sidebar');
    if (stored === 'collapsed') {
      console_.dataset.sidebar = 'collapsed';
      $('[data-collapse]').setAttribute('aria-expanded', 'false');
    }
    $('[data-collapse]').addEventListener('click', () => {
      const collapsed = console_.dataset.sidebar === 'collapsed';
      console_.dataset.sidebar = collapsed ? 'expanded' : 'collapsed';
      $('[data-collapse]').setAttribute('aria-expanded', String(collapsed));
      localStorage.setItem('cc:sidebar', collapsed ? 'expanded' : 'collapsed');
    });

    $('[data-mobile-toggle]').addEventListener('click', () => {
      const open = console_.dataset.mobileNav === 'open';
      if (open) console_.removeAttribute('data-mobile-nav');
      else console_.dataset.mobileNav = 'open';
      $('[data-mobile-toggle]').setAttribute('aria-expanded', String(!open));
    });

    $('[data-bell]').addEventListener('click', () => setTab('notifications'));
    $('[data-account]').addEventListener('click', accountMenu);

    // Global search hands off to whichever panel can answer it.
    const search = $('[data-global-search]');
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const term = search.value.trim();
      if (!term) return;
      state.bookings = { ...state.bookings, search: term, page: 1 };
      $('[data-booking-search]').value = term;
      state.loaded.bookings = false;
      setTab('bookings');
    });

    window.addEventListener('hashchange', () => {
      const tab = window.location.hash.replace('#', '');
      if (tab && tab !== state.tab) setTab(tab, { push: false });
    });
  }

  async function accountMenu() {
    const ok = await UI.confirm({
      title: 'Sign out?',
      message: `You are signed in as ${state.admin?.full_name || 'an administrator'}. Signing out ends this session on this device.`,
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    await api('/api/auth/admin/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/admin/login.html';
  }

  async function refreshUnread() {
    try {
      const { unread } = await api('/api/admin/console-notifications/unread-count');
      for (const node of [$('[data-bell-count]'), $('[data-nav-unread]')]) {
        node.dataset.count = String(unread);
        node.textContent = unread > 99 ? '99+' : String(unread);
      }
    } catch {
      /* the badge is not worth a toast */
    }
  }

  // ==========================================================================
  // Panel loading
  // ==========================================================================

  const LOADERS = {
    overview: loadOverview,
    concerts: loadConcerts,
    seats: loadSeats,
    bookings: loadBookings,
    attendees: loadUsers,
    notifications: loadNotifications,
    reports: loadReports,
    settings: loadSettings,
  };

  function load(tab, { force = false } = {}) {
    if (!force && state.loaded[tab]) return;
    state.loaded[tab] = true;
    LOADERS[tab]?.().catch((error) => {
      state.loaded[tab] = false;
      fail(error, `Could not load ${PANELS[tab].title}`);
      failPanel(tab, error);
    });
  }

  /**
   * Bind once, however many times a panel reloads.
   *
   * Loaders re-run whenever something invalidates their panel, and a listener
   * added inside a loader would stack up: after three reloads a single keypress
   * in a search box would fire three renders. This keeps a record of what has
   * already been wired.
   */
  const bound = new Set();
  function once(key, bind) {
    if (bound.has(key)) return;
    bound.add(key);
    bind();
  }

  const invalidate = (...tabs) => {
    for (const tab of tabs) state.loaded[tab] = false;
  };

  // ==========================================================================
  // Overview
  // ==========================================================================

  function kpiCard({ label, value, icon, meta, delta, rail, feature }) {
    const card = el('article', { class: `kpi${feature ? ' kpi--feature' : ''}` }, [
      el('div', { class: 'kpi__top' }, [
        el('p', { class: 'kpi__label', text: label }),
        el('span', { class: 'kpi__icon', 'data-kpi-icon': icon, 'aria-hidden': 'true' }),
      ]),
      el('p', { class: 'kpi__value', text: String(value) }),
    ]);

    if (meta || delta) {
      const row = el('div', { class: 'kpi__meta' });
      if (delta) {
        row.append(
          el('span', {
            class: `kpi__delta kpi__delta--${delta.direction}`,
            text: delta.label,
          }),
        );
      }
      if (meta) row.append(el('span', { text: meta }));
      card.append(row);
    }

    if (rail !== undefined) {
      const fill = el('i');
      const rails = el('div', { class: 'kpi__rail' }, [fill]);
      card.append(rails);
      requestAnimationFrame(() => setWidth(fill, rail));
    }

    paintAllIcons(card);
    return card;
  }

  async function loadOverview() {
    $('[data-greeting]').textContent = `${greeting()}${state.admin ? `, ${state.admin.full_name.split(' ')[0]}` : ''}`;

    const kpis = $('[data-kpis]');
    UI.skeleton(kpis, { kind: 'kpi', count: 5 });

    const [analytics, upcoming] = await Promise.all([
      api('/api/admin/analytics/concerts'),
      api('/api/admin/analytics/summary?days=30'),
    ]);

    const concerts = analytics.concerts;
    const live = concerts.filter((c) => c.is_active);
    const totals = concerts.reduce(
      (acc, c) => ({
        capacity: acc.capacity + Number(c.max_capacity || 0),
        booked: acc.booked + c.booked_seats,
        available: acc.available + c.available_seats,
        parties: acc.parties + c.parties,
        seats: acc.seats + c.total_seats,
        reserved: acc.reserved + c.reserved_seats,
        blocked: acc.blocked + c.blocked_seats,
      }),
      { capacity: 0, booked: 0, available: 0, parties: 0, seats: 0, reserved: 0, blocked: 0 },
    );

    const occupancy = pct(totals.booked, totals.capacity);

    kpis.textContent = '';
    kpis.append(
      kpiCard({
        label: 'Total concerts',
        value: concerts.length,
        icon: 'music',
        meta: `${live.length} active`,
      }),
      kpiCard({
        label: 'Total bookings',
        value: totals.parties,
        icon: 'ticket',
        meta: 'parties holding seats',
        delta: {
          direction: upcoming.bookings.parties > 0 ? 'up' : 'flat',
          label: `${upcoming.bookings.parties} in 30d`,
        },
      }),
      kpiCard({
        label: 'Seats reserved',
        value: totals.booked,
        icon: 'seat',
        meta: `of ${totals.capacity} capacity`,
        rail: occupancy,
      }),
      kpiCard({
        label: 'Available seats',
        value: totals.available,
        icon: 'check',
        meta: `${totals.blocked} blocked · ${totals.reserved} held`,
      }),
      kpiCard({
        label: 'Occupancy',
        value: `${occupancy}%`,
        icon: 'gauge',
        feature: true,
        meta: 'across every concert',
        rail: occupancy,
        delta: {
          direction: occupancy >= 80 ? 'up' : occupancy >= 40 ? 'flat' : 'down',
          label: occupancy >= 80 ? 'Filling up' : occupancy >= 40 ? 'Steady' : 'Room to fill',
        },
      }),
    );

    $('[data-overview-lede]').textContent =
      concerts.length === 0
        ? 'No concerts yet. Create one to start taking seat reservations.'
        : `${live.length} active ${live.length === 1 ? 'concert' : 'concerts'}, ${totals.booked} of ${totals.capacity} seats reserved.`;

    await Promise.all([
      drawBookingChart(),
      drawOccupancy($('[data-occupancy-chart]'), totals),
      drawUpcoming(concerts),
      drawRecentBookings(),
    ]);

    once('overview:range', () => {
      $$('[data-range]').forEach((button) => {
        button.addEventListener('click', () => {
          state.chartDays = Number(button.dataset.range);
          $$('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
          drawBookingChart().catch((error) => fail(error, 'Could not redraw the chart'));
        });
      });
    });
  }

  async function drawBookingChart() {
    const box = $('[data-bookings-chart]');
    UI.skeleton(box, { kind: 'chart', count: 1 });
    const { series } = await api(`/api/admin/analytics/bookings?days=${state.chartDays}`);
    UI.lineChart(box, series, [
      { key: 'seats', label: 'Seats' },
      { key: 'bookings', label: 'Bookings', accent: true },
    ]);
  }

  function drawOccupancy(box, totals) {
    UI.stackChart(box, [
      { label: 'Booked', value: totals.booked, tone: 'booked' },
      { label: 'Available', value: totals.available, tone: 'available' },
      { label: 'Held', value: totals.reserved, tone: 'reserved' },
      { label: 'Blocked', value: totals.blocked, tone: 'blocked' },
    ]);
  }

  function concertTile(concert) {
    const occupancy = concert.occupancy ?? pct(concert.booked_seats, concert.max_capacity);
    const status = !concert.is_active
      ? { label: 'Archived', tone: 'neutral' }
      : occupancy >= 100
        ? { label: 'Fully booked', tone: 'off' }
        : new Date(concert.event_date) < new Date()
          ? { label: 'Past', tone: 'neutral' }
          : { label: 'On sale', tone: 'ok' };

    const fill = el('i');
    const tile = el('article', { class: 'concert-tile' }, [
      el('div', { class: 'concert-tile__poster' }, [
        el('img', {
          src: posterFor(concert),
          alt: '',
          loading: 'lazy',
          width: 800,
          height: 450,
        }),
        el('span', { class: `chip chip--${status.tone} concert-tile__badge`, text: status.label }),
        el('span', { class: 'concert-tile__date' }, [
          el('strong', { text: formatDate(concert.event_date) }),
          el('span', { text: formatTime(concert.start_time) }),
        ]),
      ]),
      el('div', { class: 'concert-tile__body' }, [
        el('h3', { class: 'concert-tile__title', text: concert.name }),
        el('ul', { class: 'concert-tile__meta' }, [
          el('li', {}, [
            el('i', { 'data-meta-icon': 'pin', 'aria-hidden': 'true' }),
            concert.venue || 'Venue to be confirmed',
          ]),
          el('li', {}, [
            el('i', { 'data-meta-icon': 'seat', 'aria-hidden': 'true' }),
            `${concert.total_seats} seats laid out · capacity ${concert.max_capacity}`,
          ]),
        ]),
        el('div', { class: `occupancy ${occupancyTone(occupancy)}` }, [
          el('div', { class: 'occupancy__top' }, [
            el('span', { text: 'Occupancy' }),
            el('span', { class: 'occupancy__value', text: `${occupancy}%` }),
          ]),
          el('div', { class: 'occupancy__rail' }, [fill]),
          el('div', { class: 'occupancy__split' }, [
            el('span', {}, [el('strong', { text: String(concert.booked_seats) }), 'Booked']),
            el('span', {}, [el('strong', { text: String(concert.available_seats) }), 'Available']),
            el('span', {}, [el('strong', { text: String(concert.parties) }), 'Parties']),
          ]),
        ]),
      ]),
      el('div', { class: 'concert-tile__actions' }, [
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'View',
          onClick: () => showConcert(concert),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Edit',
          onClick: () => editConcert(concert),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Seats',
          onClick: () => {
            state.concertId = concert.id;
            state.seat.map = null;
            invalidate('seats');
            setTab('seats');
          },
        }),
      ]),
    ]);

    requestAnimationFrame(() => setWidth(fill, occupancy));
    paintAllIcons(tile);
    return tile;
  }

  function drawUpcoming(concerts) {
    const box = $('[data-upcoming]');
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = concerts
      .filter((c) => c.is_active && String(c.event_date).slice(0, 10) >= today)
      .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)))
      .slice(0, 3);

    box.textContent = '';
    if (!upcoming.length) {
      UI.empty(box, {
        title: 'No concerts coming up',
        message: 'Create a concert to open seat reservations.',
        icon: 'music',
        action: { label: 'Create concert', onClick: () => createConcert() },
      });
      return;
    }
    for (const concert of upcoming) box.append(concertTile(concert));
  }

  async function drawRecentBookings() {
    const box = $('[data-recent-bookings]');
    UI.skeleton(box, { kind: 'row', count: 5 });
    const { bookings } = await api('/api/admin/bookings?per_page=8');

    if (!bookings.length) {
      UI.empty(box, {
        title: 'No bookings yet',
        message: 'Reservations will appear here as they come in.',
        icon: 'ticket',
      });
      return;
    }

    box.textContent = '';
    box.append(
      bookingsTable(bookings, {
        columns: ['ref', 'customer', 'concert', 'seats', 'status', 'date'],
      }),
    );
  }

  // ==========================================================================
  // Concerts
  // ==========================================================================

  async function loadConcerts() {
    const box = $('[data-concerts-view]');
    UI.skeleton(box, { kind: 'tile', count: 2 });

    const { concerts } = await api('/api/admin/analytics/concerts');
    state.concerts = concerts;
    fillConcertPickers(concerts);
    renderConcerts();

    once('concerts:filters', () => {
      const rerender = () => renderConcerts();
      $('[data-concert-search]').addEventListener('input', rerender);
      $('[data-concert-when]').addEventListener('change', rerender);
      $('[data-concert-status]').addEventListener('change', rerender);
      $$('[data-view]').forEach((button) => {
        button.addEventListener('click', () => {
          state.concertView = button.dataset.view;
          $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
          renderConcerts();
        });
      });
    });
  }

  function filteredConcerts() {
    const term = ($('[data-concert-search]')?.value || '').trim().toLowerCase();
    const when = $('[data-concert-when]')?.value || 'all';
    const status = $('[data-concert-status]')?.value || 'all';
    const today = new Date().toISOString().slice(0, 10);

    return state.concerts.filter((concert) => {
      if (term && !`${concert.name} ${concert.venue}`.toLowerCase().includes(term)) return false;
      const date = String(concert.event_date).slice(0, 10);
      if (when === 'upcoming' && date < today) return false;
      if (when === 'past' && date >= today) return false;
      if (status === 'active' && !concert.is_active) return false;
      if (status === 'archived' && concert.is_active) return false;
      if (status === 'full' && concert.occupancy < 100) return false;
      return true;
    });
  }

  function renderConcerts() {
    const box = $('[data-concerts-view]');
    const list = filteredConcerts();
    box.textContent = '';

    if (!list.length) {
      UI.empty(box, {
        title: 'No concerts match',
        message: 'Try a different search or clear the filters.',
        icon: 'music',
        action: { label: 'Create concert', onClick: () => createConcert() },
      });
      return;
    }

    if (state.concertView === 'cards') {
      const grid = el('div', { class: 'concert-grid' });
      for (const concert of list) grid.append(concertTile(concert));
      box.append(grid);
      return;
    }

    const body = el('tbody');
    for (const concert of list) {
      const fill = el('i');
      body.append(
        el('tr', {}, [
          el('td', {}, [
            el('span', { class: 'data-table__strong', text: concert.name }),
            el('span', { class: 'data-table__sub', text: concert.venue || '—' }),
          ]),
          el('td', {}, [
            formatDate(concert.event_date),
            el('span', { class: 'data-table__sub', text: formatTime(concert.start_time) }),
          ]),
          el('td', { class: 'u-tabular', text: String(concert.max_capacity) }),
          el('td', { class: 'u-tabular', text: String(concert.booked_seats) }),
          el('td', { class: 'u-tabular', text: String(concert.available_seats) }),
          el('td', {}, [
            el('div', { class: `occupancy ${occupancyTone(concert.occupancy)}` }, [
              el('div', { class: 'occupancy__top' }, [
                el('span', { class: 'occupancy__value', text: `${concert.occupancy}%` }),
              ]),
              el('div', { class: 'occupancy__rail' }, [fill]),
            ]),
          ]),
          el('td', {}, [statusChip(concert.is_active ? 'CONFIRMED' : 'EXPIRED')]),
          el('td', {}, [
            el('div', { class: 'data-table__actions' }, [
              iconButton('eye-view', 'View concert', () => showConcert(concert)),
              iconButton('edit', 'Edit concert', () => editConcert(concert)),
              iconButton('copy', 'Duplicate concert', () => duplicateConcert(concert)),
              iconButton('archive', concert.is_active ? 'Archive concert' : 'Restore concert', () =>
                archiveConcert(concert),
              ),
            ]),
          ]),
        ]),
      );
      requestAnimationFrame(() => setWidth(fill, concert.occupancy));
    }

    box.append(
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Concert' }),
              el('th', { text: 'Date' }),
              el('th', { text: 'Capacity' }),
              el('th', { text: 'Booked' }),
              el('th', { text: 'Available' }),
              el('th', { text: 'Occupancy' }),
              el('th', { text: 'Status' }),
              el('th', { text: '' }),
            ]),
          ]),
          body,
        ]),
      ]),
    );
  }

  function iconButton(icon, label, onClick) {
    const button = el('button', {
      class: 'btn btn--quiet btn--icon',
      type: 'button',
      'aria-label': label,
      title: label,
      onClick,
    });
    const glyph = el('span', { class: 'btn__icon', 'data-btn-icon': icon, 'aria-hidden': 'true' });
    button.append(glyph);
    paintIcon(glyph, icon, '--btn-icon');
    return button;
  }

  function showConcert(concert) {
    UI.drawer({
      title: concert.name,
      subtitle: `${formatDate(concert.event_date)} · ${formatTime(concert.start_time)}`,
      render(body) {
        const fill = el('i');
        body.append(
          el('img', {
            src: posterFor(concert),
            alt: '',
            width: 800,
            height: 450,
            class: 'poster',
          }),
          el('dl', { class: 'facts', style: null }, [
            fact('Venue', concert.venue || '—'),
            fact('Capacity', String(concert.max_capacity)),
            fact('Seats laid out', String(concert.total_seats)),
            fact('Booked', `${concert.booked_seats} across ${concert.parties} parties`),
            fact('Available', String(concert.available_seats)),
            fact('Held', String(concert.reserved_seats)),
            fact('Blocked', String(concert.blocked_seats)),
            fact('Cancellations', String(concert.cancellations)),
          ]),
          el('div', { class: `occupancy ${occupancyTone(concert.occupancy)}` }, [
            el('div', { class: 'occupancy__top' }, [
              el('span', { text: 'Occupancy' }),
              el('span', { class: 'occupancy__value', text: `${concert.occupancy}%` }),
            ]),
            el('div', { class: 'occupancy__rail' }, [fill]),
          ]),
        );
        requestAnimationFrame(() => setWidth(fill, concert.occupancy));
      },
      actions: [
        {
          label: 'Manage seats',
          variant: 'primary',
          onClick: ({ close }) => {
            close();
            state.concertId = concert.id;
            state.seat.map = null;
            invalidate('seats');
            setTab('seats');
          },
        },
        { label: 'Edit', onClick: ({ close }) => (close(), editConcert(concert)) },
      ],
    });
  }

  const fact = (term, value) => el('div', {}, [el('dt', { text: term }), el('dd', { text: value })]);

  // --- Concert create / edit ------------------------------------------------

  function concertForm(concert = {}) {
    const form = el('form', { class: 'stack' });
    const field = (id, label, input, hint) =>
      el('div', { class: 'field' }, [
        el('label', { for: id, text: label }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': inputIcon(id), 'aria-hidden': 'true' }),
          input,
          input.tagName === 'SELECT'
            ? el('span', { class: 'field__chevron', 'aria-hidden': 'true' })
            : null,
        ]),
        hint ? el('p', { class: 'field__hint', text: hint }) : null,
        el('span', { class: 'field__error', 'data-error-for': input.name }),
      ]);

    const text = (name, value, attrs = {}) =>
      el('input', { id: `cf_${name}`, name, value: value ?? '', ...attrs });

    form.append(
      field('cf_name', 'Concert name', text('name', concert.name, { type: 'text', required: true })),
      field(
        'cf_venue',
        'Venue',
        text('venue', concert.venue, { type: 'text', required: true }),
      ),
      el('div', { class: 'grid-3' }, [
        field(
          'cf_event_date',
          'Date',
          text('event_date', String(concert.event_date || '').slice(0, 10), {
            type: 'date',
            required: true,
          }),
        ),
        field(
          'cf_start_time',
          'Start time',
          text('start_time', String(concert.start_time || '').slice(0, 5), {
            type: 'time',
            required: true,
          }),
        ),
        field(
          'cf_max_capacity',
          'Capacity',
          text('max_capacity', concert.max_capacity ?? 100, { type: 'number', min: '1' }),
        ),
      ]),
      field(
        'cf_booking_ref_prefix',
        'Reference prefix',
        text('booking_ref_prefix', concert.booking_ref_prefix || 'CHC', {
          type: 'text',
          maxlength: '12',
        }),
        'Two to twelve uppercase letters or digits, used to number this concert’s bookings.',
      ),
    );
    return form;
  }

  const inputIcon = (id) => {
    if (id.includes('date')) return 'calendar';
    if (id.includes('time')) return 'clock';
    if (id.includes('venue')) return 'pin';
    if (id.includes('capacity')) return 'users';
    if (id.includes('prefix')) return 'ticket';
    return 'music';
  };

  function createConcert() {
    const form = concertForm();
    UI.drawer({
      title: 'Create concert',
      subtitle: 'Seats are added afterwards, from Seat Management.',
      render: (body) => {
        body.append(form);
        enhanceFields(body);
      },
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        {
          label: 'Create concert',
          variant: 'primary',
          onClick: async ({ close }) => {
            try {
              const values = formValues(form);
              const { concert } = await api('/api/admin/concerts', {
                method: 'POST',
                body: values,
              });
              close();
              UI.toastSuccess('Concert created', `${concert.name} is ready for seats.`);
              invalidate('overview', 'concerts', 'seats', 'reports');
              load(state.tab, { force: true });
            } catch (error) {
              if (error.details) showFieldErrors(form, error.details);
              UI.toastError('Could not create the concert', error.message);
            }
          },
        },
      ],
    });
  }

  function editConcert(concert) {
    const form = concertForm(concert);
    UI.drawer({
      title: 'Edit concert',
      subtitle: concert.name,
      render: (body) => {
        body.append(form, posterPicker(concert));
        enhanceFields(body);
      },
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        {
          label: 'Save changes',
          variant: 'primary',
          onClick: async ({ close }) => {
            try {
              await api(`/api/admin/concerts/${concert.id}`, {
                method: 'PATCH',
                body: formValues(form),
              });
              close();
              UI.toastSuccess('Concert updated', concert.name);
              invalidate('overview', 'concerts', 'reports');
              load(state.tab, { force: true });
            } catch (error) {
              if (error.details) showFieldErrors(form, error.details);
              UI.toastError('Could not save the concert', error.message);
            }
          },
        },
      ],
    });
  }

  /**
   * Poster chooser: one of the bundled illustrations, or a photograph uploaded
   * from disk. The upload is read here and posted as a data URI — the server
   * decodes it, checks the type and size, and writes the file.
   */
  function posterPicker(concert) {
    const preview = el('img', {
      src: posterFor(concert),
      alt: '',
      width: 800,
      height: 450,
      class: 'poster',
    });

    const choose = async (path) => {
      try {
        await api(`/api/admin/concerts/${concert.id}`, {
          method: 'PATCH',
          body: { poster_path: path },
        });
        concert.poster_path = path;
        preview.src = posterFor(concert);
        UI.toastSuccess('Poster updated');
        invalidate('overview', 'concerts');
      } catch (error) {
        UI.toastError('Could not set the poster', error.message);
      }
    };

    const file = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      id: 'poster-file',
      class: 'visually-hidden',
    });
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.size > 2 * 1024 * 1024) {
        UI.toastError('That image is too large', 'Posters must be 2 MB or smaller.');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const { poster_path: path } = await api(`/api/admin/concerts/${concert.id}/poster`, {
            method: 'POST',
            body: { image: reader.result },
          });
          concert.poster_path = path;
          preview.src = path;
          UI.toastSuccess('Poster uploaded');
          invalidate('overview', 'concerts');
        } catch (error) {
          UI.toastError('Could not upload the poster', error.message);
        }
      };
      reader.readAsDataURL(chosen);
    });

    const thumbs = el('div', { class: 'grid-3' });
    for (const path of POSTERS) {
      const button = el('button', {
        type: 'button',
        class: 'poster-choice',
        'aria-label': `Use the ${path.split('/').pop().replace('.svg', '').replace('-', ' ')} artwork`,
        onClick: () => choose(path),
      });
      button.append(el('img', { src: path, alt: '', width: 800, height: 450 }));
      thumbs.append(button);
    }

    return el('div', { class: 'stack' }, [
      el('h3', { text: 'Poster' }),
      preview,
      el('div', { class: 'u-flex' }, [
        el('label', { class: 'btn btn--ghost btn--small', for: 'poster-file', text: 'Upload a photo' }),
        file,
        el('button', {
          type: 'button',
          class: 'btn btn--quiet btn--small',
          text: 'Use bundled artwork',
          onClick: () => choose(POSTERS[(Number(concert.id) || 0) % POSTERS.length]),
        }),
      ]),
      el('p', { class: 'field__hint', text: 'PNG, JPEG or WebP, up to 2 MB. Or pick one of these:' }),
      thumbs,
    ]);
  }

  async function duplicateConcert(concert) {
    const ok = await UI.confirm({
      title: 'Duplicate this concert?',
      message: `A copy of "${concert.name}" will be created with its sections and seats, but no bookings.`,
      confirmLabel: 'Duplicate',
    });
    if (!ok) return;
    try {
      await api(`/api/admin/concerts/${concert.id}/duplicate`, { method: 'POST', body: {} });
      UI.toastSuccess('Concert duplicated');
      invalidate('overview', 'concerts', 'reports');
      load(state.tab, { force: true });
    } catch (error) {
      UI.toastError('Could not duplicate the concert', error.message);
    }
  }

  async function archiveConcert(concert) {
    const archiving = concert.is_active;
    const ok = await UI.confirm({
      title: archiving ? 'Archive this concert?' : 'Restore this concert?',
      message: archiving
        ? `"${concert.name}" will stop accepting new bookings and disappear from the public site. Existing bookings are untouched.`
        : `"${concert.name}" will be listed publicly again.`,
      confirmLabel: archiving ? 'Archive' : 'Restore',
      danger: archiving,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/concerts/${concert.id}`, {
        method: 'PATCH',
        body: { is_active: !archiving },
      });
      UI.toastSuccess(archiving ? 'Concert archived' : 'Concert restored', concert.name);
      invalidate('overview', 'concerts', 'reports');
      load(state.tab, { force: true });
    } catch (error) {
      UI.toastError('Could not update the concert', error.message);
    }
  }

  // ==========================================================================
  // Seat management
  // ==========================================================================

  function fillConcertPickers(concerts) {
    if (!state.concertId && concerts.length) {
      const today = new Date().toISOString().slice(0, 10);
      const next = concerts.find((c) => c.is_active && String(c.event_date).slice(0, 10) >= today);
      state.concertId = (next || concerts[0]).id;
    }

    const seatPicker = $('[data-seat-concert]');
    if (seatPicker) {
      seatPicker.textContent = '';
      for (const concert of concerts) {
        seatPicker.append(
          el('option', {
            value: concert.id,
            text: `${concert.name} — ${formatDate(concert.event_date)}`,
            selected: concert.id === state.concertId,
          }),
        );
      }
    }

    for (const selector of ['[data-booking-concert]', '[data-report-concert]']) {
      const picker = $(selector);
      if (!picker) continue;
      const current = picker.value;
      picker.textContent = '';
      picker.append(el('option', { value: '', text: 'All concerts' }));
      for (const concert of concerts) {
        picker.append(el('option', { value: concert.id, text: concert.name }));
      }
      picker.value = current;
    }
  }

  async function loadSeats() {
    if (!state.concerts.length) {
      const { concerts } = await api('/api/admin/analytics/concerts');
      state.concerts = concerts;
      fillConcertPickers(concerts);
    }
    if (!state.concertId) {
      UI.empty($('[data-viewport]'), {
        title: 'No concert to lay out',
        message: 'Create a concert first, then add sections and seats to it.',
        icon: 'music',
        action: { label: 'Create concert', onClick: () => createConcert() },
      });
      return;
    }

    await refreshSeatMap();

    once('seats:controls', () => {
    $('[data-seat-concert]').addEventListener('change', (event) => {
      state.concertId = Number(event.target.value);
      state.seat.selected = null;
      refreshSeatMap().catch((error) => fail(error, 'Could not load the seat map'));
    });
    $('[data-seat-zone]').addEventListener('change', (event) => {
      state.seat.zone = event.target.value;
      renderSeatMap();
    });
    $('[data-seat-search]').addEventListener('input', (event) => {
      state.seat.search = event.target.value.trim().toUpperCase();
      renderSeatMap();
    });
    $$('[data-zoom]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.zoom;
        if (mode === 'reset') state.seat.zoom = 1;
        if (mode === 'in') state.seat.zoom = Math.min(1.8, state.seat.zoom + 0.15);
        if (mode === 'out') state.seat.zoom = Math.max(0.55, state.seat.zoom - 0.15);
        applyZoom();
      });
    });
    $('[data-action="refresh-seats"]').addEventListener('click', () => {
      refreshSeatMap().then(() => UI.toast('Seat map refreshed')).catch((e) => fail(e, 'Refresh failed'));
    });
    $('[data-action="add-section"]').addEventListener('click', addSection);
    $('[data-action="add-seats"]').addEventListener('click', addSeats);
    });
  }

  function applyZoom() {
    $('[data-viewport]').style.transform = `scale(${state.seat.zoom})`;
    $('[data-zoom-level]').textContent = `${Math.round(state.seat.zoom * 100)}%`;
  }

  async function refreshSeatMap() {
    const viewport = $('[data-viewport]');
    UI.skeleton(viewport, { kind: 'chart', count: 1 });
    const data = await api(`/api/admin/seats?concert_id=${state.concertId}`);
    state.seat.map = data;

    const zone = $('[data-seat-zone]');
    const current = zone.value;
    zone.textContent = '';
    zone.append(el('option', { value: 'all', text: 'All sections' }));
    for (const section of data.sections) {
      zone.append(el('option', { value: String(section.id), text: section.name }));
    }
    zone.value = current && [...zone.options].some((o) => o.value === current) ? current : 'all';
    state.seat.zone = zone.value;

    renderSeatStats();
    renderSeatMap();
    renderSeatLegend();
    renderInspector();
  }

  function allSeats() {
    return (state.seat.map?.sections || []).flatMap((section) =>
      section.seats.map((seat) => ({ ...seat, section_name: section.name, section_id: section.id })),
    );
  }

  function renderSeatStats() {
    const seats = allSeats();
    const count = (status) => seats.filter((s) => s.status === status).length;
    const stats = [
      { label: 'Total seats', value: seats.length, tone: 'accent' },
      { label: 'Available', value: count('AVAILABLE'), tone: 'available' },
      { label: 'Reserved', value: count('RESERVED'), tone: 'reserved' },
      { label: 'Booked', value: count('BOOKED'), tone: 'booked' },
      { label: 'Blocked', value: count('DISABLED'), tone: 'blocked' },
    ];

    const box = $('[data-seat-stats]');
    box.textContent = '';
    for (const stat of stats) {
      const card = el('div', { class: 'seat-stat' }, [
        el('div', { class: 'seat-stat__value', text: String(stat.value) }),
        el('div', { class: 'seat-stat__label', text: stat.label }),
      ]);
      card.style.setProperty('--seat-swatch', `var(--${toneVar(stat.tone)})`);
      box.append(card);
    }
  }

  const toneVar = (tone) =>
    ({ available: 'ok', reserved: 'warn', booked: 'brand', blocked: 'line-strong', accent: 'accent' })[
      tone
    ] || 'line-strong';

  /**
   * The auditorium. Seats are grouped into rows by their row_label where one
   * exists, falling back to the letters at the front of the seat number, so a
   * layout created with plain "A01…A20" numbering still draws as rows.
   */
  function renderSeatMap() {
    const viewport = $('[data-viewport]');
    viewport.textContent = '';
    const map = state.seat.map;
    if (!map) return;

    viewport.append(el('div', { class: 'auditorium__stage', text: 'Stage' }));

    const sections = map.sections.filter(
      (section) => state.seat.zone === 'all' || String(section.id) === state.seat.zone,
    );

    if (!sections.length || !sections.some((s) => s.seats.length)) {
      UI.empty(viewport, {
        title: 'No seats laid out yet',
        message: 'Add a section, then add a run of seats to it.',
        icon: 'seat',
        action: { label: 'Add section', onClick: addSection },
      });
      return;
    }

    for (const section of sections) {
      const zone = el('div', { class: `zone ${zoneModifier(section.name)}` }, [
        el('div', { class: 'zone__head' }, [
          el('span', { class: 'zone__name', text: section.name }),
          el('span', { class: 'zone__rule' }),
          el('span', {
            class: 'zone__count',
            text: `${section.seats.filter((s) => s.status === 'AVAILABLE').length} of ${section.seats.length} free`,
          }),
        ]),
      ]);

      const rows = new Map();
      for (const seat of section.seats) {
        const key = seat.row_label || String(seat.seat_number).replace(/[0-9].*$/, '') || '—';
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(seat);
      }

      for (const [label, seats] of rows) {
        const strip = el('div', { class: 'seat-row__seats' });
        for (const seat of seats) {
          strip.append(seatButton(seat, section));
        }
        zone.append(
          el('div', { class: 'seat-row' }, [
            el('span', { class: 'seat-row__label', text: label }),
            strip,
          ]),
        );
      }

      viewport.append(zone);
    }
    applyZoom();
  }

  const zoneModifier = (name) => (/vip|premium/i.test(name) ? 'zone--vip' : '');

  function seatButton(seat, section) {
    const matches =
      state.seat.search && String(seat.seat_number).toUpperCase().includes(state.seat.search);
    const vip = /vip|premium/i.test(section.name);

    const button = el('button', {
      type: 'button',
      class: `pseat${vip ? ' pseat--vip' : ''}`,
      'data-status': seat.status,
      'data-seat-id': seat.id,
      'aria-pressed': String(state.seat.selected?.id === seat.id),
      'aria-label': `Seat ${seat.seat_number}, ${section.name}, ${seat.status === 'DISABLED' ? 'blocked' : seat.status.toLowerCase()}`,
      title: seat.note || `Seat ${seat.seat_number}`,
      text: seat.seat_number,
      onClick: () => selectSeat({ ...seat, section_name: section.name, section_id: section.id }),
    });

    // A search match is outlined rather than recoloured, so it does not collide
    // with the status colours already in play.
    if (matches) button.style.outline = '2px solid var(--accent)';
    return button;
  }

  function selectSeat(seat) {
    state.seat.selected = seat;
    $$('.pseat').forEach((node) =>
      node.setAttribute('aria-pressed', String(Number(node.dataset.seatId) === seat.id)),
    );
    renderInspector();
  }

  function renderSeatLegend() {
    const box = $('[data-seat-legend]');
    box.textContent = '';
    const keys = [
      ['AVAILABLE', 'Available'],
      ['BOOKED', 'Booked'],
      ['RESERVED', 'Reserved'],
      ['DISABLED', 'Blocked'],
    ];
    for (const [status, label] of keys) {
      box.append(
        el('span', { class: 'seat-legend__key' }, [
          el('span', { class: 'pseat', 'data-status': status, 'aria-hidden': 'true' }),
          label,
        ]),
      );
    }
    box.append(
      el('span', { class: 'seat-legend__key' }, [
        el('span', { class: 'pseat', 'aria-pressed': 'true', 'aria-hidden': 'true' }),
        'Selected',
      ]),
    );
  }

  function renderInspector() {
    const box = $('[data-inspector-body]');
    const seat = state.seat.selected;
    box.textContent = '';

    if (!seat) {
      UI.empty(box, {
        title: 'No seat selected',
        message: 'Click any seat on the plan to see who holds it and what you can do.',
        icon: 'seat',
      });
      return;
    }

    const booking = seat.booking || null;
    box.append(
      el('dl', { class: 'facts facts--stacked' }, [
        fact('Seat', seat.seat_number),
        fact('Section', seat.section_name),
        fact('Admission', 'Free'),
      ]),
      el('div', { class: 'u-flex' }, [statusChip(seat.status)]),
    );

    if (booking) {
      box.append(
        el('h3', { text: 'Held by' }),
        el('dl', { class: 'facts facts--stacked' }, [
          fact('Attendee', booking.full_name || '—'),
          fact('Email', booking.email || '—'),
          fact('Reference', booking.booking_reference || '—'),
          fact('Booked', booking.created_at ? formatShortDate(booking.created_at) : '—'),
        ]),
      );
    } else if (seat.note) {
      box.append(el('p', { class: 'muted', text: seat.note }));
    }

    const actions = el('div', { class: 'u-flex' });
    if (booking) {
      actions.append(
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Open booking',
          onClick: () => {
            state.bookings = { ...state.bookings, search: booking.booking_reference, page: 1 };
            $('[data-booking-search]').value = booking.booking_reference;
            invalidate('bookings');
            setTab('bookings');
          },
        }),
        el('button', {
          class: 'btn btn--danger btn--small',
          type: 'button',
          text: 'Release seat',
          onClick: () => releaseSeat(seat, booking),
        }),
      );
    } else {
      actions.append(
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: seat.status === 'DISABLED' ? 'Unblock seat' : 'Block seat',
          onClick: () => toggleBlocked(seat),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: seat.status === 'RESERVED' ? 'Release hold' : 'Hold seat',
          onClick: () => toggleHold(seat),
        }),
      );
    }
    box.append(actions);
  }

  async function toggleBlocked(seat) {
    const blocking = seat.status !== 'DISABLED';
    try {
      await api(`/api/admin/seats/${seat.id}`, {
        method: 'PATCH',
        body: { status: blocking ? 'DISABLED' : 'AVAILABLE' },
      });
      UI.toastSuccess(blocking ? `Seat ${seat.seat_number} blocked` : `Seat ${seat.seat_number} unblocked`);
      invalidate('overview', 'concerts', 'reports');
      await refreshSeatMap();
    } catch (error) {
      UI.toastError('Could not update the seat', error.message);
    }
  }

  async function toggleHold(seat) {
    const holding = seat.status !== 'RESERVED';
    try {
      await api(`/api/admin/seats/${seat.id}/${holding ? 'reserve' : 'release'}`, {
        method: 'POST',
        body: {},
      });
      UI.toastSuccess(holding ? `Seat ${seat.seat_number} held` : `Hold on ${seat.seat_number} released`);
      invalidate('overview', 'concerts', 'reports');
      await refreshSeatMap();
    } catch (error) {
      UI.toastError('Could not update the seat', error.message);
    }
  }

  async function releaseSeat(seat, booking) {
    const ok = await UI.confirm({
      title: `Release seat ${seat.seat_number}?`,
      message: `${booking.full_name || 'The attendee'} loses this seat and is sent a cancellation on WhatsApp. The rest of their party keeps their seats.`,
      confirmLabel: 'Release seat',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/bookings/${booking.booking_id || booking.id}`, {
        method: 'DELETE',
        body: { reason: 'Released by staff from the seat map' },
      });
      UI.toastSuccess(`Seat ${seat.seat_number} released`);
      invalidate('overview', 'bookings', 'concerts', 'reports');
      state.seat.selected = null;
      await refreshSeatMap();
    } catch (error) {
      UI.toastError('Could not release the seat', error.message);
    }
  }

  function addSection() {
    const form = el('form', {}, [
      el('div', { class: 'field' }, [
        el('label', { for: 'sec_name', text: 'Section name' }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': 'seat', 'aria-hidden': 'true' }),
          el('input', { id: 'sec_name', name: 'name', type: 'text', required: true, placeholder: 'VIP, Premium, General…' }),
        ]),
        el('p', { class: 'field__hint', text: 'A section named VIP or Premium is drawn with rounded seats on the plan.' }),
        el('span', { class: 'field__error', 'data-error-for': 'name' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'sec_order', text: 'Display order' }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': 'note', 'aria-hidden': 'true' }),
          el('input', { id: 'sec_order', name: 'display_order', type: 'number', min: '0', value: '0' }),
        ]),
      ]),
    ]);

    UI.drawer({
      title: 'Add a section',
      subtitle: 'Sections are drawn front to back in display order.',
      render: (body) => body.append(form),
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        {
          label: 'Add section',
          variant: 'primary',
          onClick: async ({ close }) => {
            try {
              await api(`/api/admin/sections?concert_id=${state.concertId}`, {
                method: 'POST',
                body: { ...formValues(form), concert_id: state.concertId },
              });
              close();
              UI.toastSuccess('Section added');
              await refreshSeatMap();
            } catch (error) {
              if (error.details) showFieldErrors(form, error.details);
              UI.toastError('Could not add the section', error.message);
            }
          },
        },
      ],
    });
  }

  function addSeats() {
    const sections = state.seat.map?.sections || [];
    if (!sections.length) {
      UI.toastError('Add a section first', 'Seats belong to a section.');
      return;
    }

    const picker = el('select', { id: 'bulk_section', name: 'section_id', required: true });
    for (const section of sections) {
      picker.append(el('option', { value: section.id, text: section.name }));
    }

    const form = el('form', {}, [
      el('div', { class: 'field' }, [
        el('label', { for: 'bulk_section', text: 'Section' }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': 'seat', 'aria-hidden': 'true' }),
          picker,
          el('span', { class: 'field__chevron', 'aria-hidden': 'true' }),
        ]),
      ]),
      el('div', { class: 'grid-3' }, [
        numberField('bulk_prefix', 'prefix', 'Prefix', 'text', 'A'),
        numberField('bulk_from', 'from', 'From', 'number', '1'),
        numberField('bulk_to', 'to', 'To', 'number', '20'),
      ]),
      el('p', { class: 'field__hint', text: 'Prefix A, 1 to 20 creates A01 through A20.' }),
    ]);

    UI.drawer({
      title: 'Add a run of seats',
      subtitle: 'Numbers are zero-padded to two digits.',
      render: (body) => body.append(form),
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        {
          label: 'Add seats',
          variant: 'primary',
          onClick: async ({ close }) => {
            try {
              const result = await api(`/api/admin/seats/bulk?concert_id=${state.concertId}`, {
                method: 'POST',
                body: { ...formValues(form), concert_id: state.concertId },
              });
              close();
              UI.toastSuccess('Seats added', result.message || '');
              invalidate('overview', 'concerts', 'reports');
              await refreshSeatMap();
            } catch (error) {
              if (error.details) showFieldErrors(form, error.details);
              UI.toastError('Could not add the seats', error.message);
            }
          },
        },
      ],
    });
  }

  const numberField = (id, name, label, type, value) =>
    el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      el('span', { class: 'field__control field__control--inline' }, [
        el('span', { class: 'field__icon', 'data-icon': 'ticket', 'aria-hidden': 'true' }),
        el('input', { id, name, type, value, required: true }),
      ]),
      el('span', { class: 'field__error', 'data-error-for': name }),
    ]);

  // ==========================================================================
  // Bookings
  // ==========================================================================

  function bookingsTable(rows, { columns, onOpen } = {}) {
    const show = new Set(columns || ['ref', 'customer', 'concert', 'seats', 'status', 'date', 'actions']);
    const head = el('tr');
    const headings = {
      ref: 'Booking ID',
      customer: 'Customer',
      concert: 'Concert',
      seats: 'Seats',
      status: 'Status',
      whatsapp: 'Ticket',
      date: 'Booked',
      actions: '',
    };
    for (const key of show) head.append(el('th', { text: headings[key] }));

    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr', onOpen ? { 'data-clickable': 'true' } : {});
      if (onOpen) {
        tr.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          onOpen(row);
        });
      }

      const cells = {
        ref: () => el('td', {}, [el('span', { class: 'data-table__ref', text: row.booking_reference })]),
        customer: () =>
          el('td', {}, [
            el('div', { class: 'cell-person' }, [
              el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(row.full_name) }),
              el('div', {}, [
                el('span', { class: 'data-table__strong', text: row.full_name || '—' }),
                el('span', { class: 'data-table__sub', text: row.email || '—' }),
              ]),
            ]),
          ]),
        concert: () => el('td', { text: row.concert_name || currentConcertName(row) }),
        seats: () =>
          el('td', {}, [
            el('span', { class: 'data-table__strong', text: row.seat_number || '—' }),
            el('span', { class: 'data-table__sub', text: row.section_name || '' }),
          ]),
        status: () => el('td', {}, [statusChip(row.status)]),
        whatsapp: () =>
          el('td', {}, [
            row.whatsapp_verified
              ? el('span', { class: 'chip chip--ok', text: 'WhatsApp' })
              : el('span', { class: 'chip chip--neutral', text: 'Unverified' }),
          ]),
        date: () => el('td', { class: 'u-nowrap', text: formatShortDate(row.created_at) }),
        actions: () =>
          el('td', {}, [
            el('div', { class: 'data-table__actions' }, [
              iconButton('eye-view', 'View booking', () => showBooking(row)),
              iconButton('download', 'Download ticket', () => downloadTicket(row)),
              iconButton('send', 'Resend confirmation', () => resendConfirmation(row)),
              row.status === 'CONFIRMED' || row.status === 'PENDING'
                ? iconButton('trash', 'Cancel booking', () => cancelBooking(row))
                : null,
            ]),
          ]),
      };

      for (const key of show) tr.append(cells[key]());
      body.append(tr);
    }

    return el('table', { class: 'data-table' }, [el('thead', {}, [head]), body]);
  }

  const currentConcertName = (row) =>
    row.concert_name || state.concerts.find((c) => c.id === row.concert_id)?.name || '—';

  async function loadBookings() {
    await renderBookings();

    once('bookings:filters', () => {
      const rerun = () => {
        state.bookings.page = 1;
        renderBookings().catch((error) => fail(error, 'Could not load bookings'));
      };
      $('[data-booking-search]').addEventListener('input', debounce(rerun, 300));
      $('[data-booking-status]').addEventListener('change', rerun);
      $('[data-booking-concert]').addEventListener('change', rerun);
      $('[data-booking-whatsapp]').addEventListener('change', rerun);
      $('[data-action="export-bookings"]').addEventListener('click', () => {
        window.open('/api/admin/export/bookings.csv', '_blank', 'noopener');
      });
      $('[data-action="manual-booking"]').addEventListener('click', manualBooking);
    });
  }

  async function renderBookings() {
    const box = $('[data-bookings-table]');
    UI.skeleton(box, { kind: 'row', count: 8 });

    // Every filter goes to the server. Filtering here instead would drop rows
    // out of an already-paginated page, so the count under the table would stop
    // matching the rows above it.
    const params = new URLSearchParams({ page: String(state.bookings.page), per_page: '25' });
    const search = $('[data-booking-search]')?.value.trim();
    const status = $('[data-booking-status]')?.value;
    const concertFilter = $('[data-booking-concert]')?.value;
    const whatsappFilter = $('[data-booking-whatsapp]')?.value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (concertFilter) params.set('concert_id', concertFilter);
    if (whatsappFilter === 'verified') params.set('verified', 'true');
    if (whatsappFilter === 'unverified') params.set('verified', 'false');

    const { bookings: rows, pagination } = await api(`/api/admin/bookings?${params}`);

    box.textContent = '';
    if (!rows.length) {
      UI.empty(box, {
        title: 'No bookings match',
        message: 'Try a different search, or clear the filters.',
        icon: 'ticket',
      });
    } else {
      box.append(
        bookingsTable(rows, {
          columns: ['ref', 'customer', 'concert', 'seats', 'status', 'whatsapp', 'date', 'actions'],
          onOpen: showBooking,
        }),
      );
    }

    renderPager($('[data-bookings-pager]'), pagination, rows.length, (page) => {
      state.bookings.page = page;
      renderBookings().catch((error) => fail(error, 'Could not load bookings'));
    });
  }

  function renderPager(box, pagination, shown, onPage) {
    box.textContent = '';
    const pages = Math.max(1, Math.ceil(pagination.total / pagination.per_page));
    box.append(
      el('span', {
        text: `Showing ${shown} of ${pagination.total} · page ${pagination.page} of ${pages}`,
      }),
      el('div', { class: 'pager__controls' }, [
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Previous',
          disabled: pagination.page <= 1,
          onClick: () => onPage(pagination.page - 1),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Next',
          disabled: pagination.page >= pages,
          onClick: () => onPage(pagination.page + 1),
        }),
      ]),
    );
  }

  function showBooking(row) {
    UI.drawer({
      title: row.booking_reference,
      subtitle: `${row.full_name || 'Attendee'} · ${row.status.toLowerCase()}`,
      render(body) {
        body.append(
          el('div', { class: 'u-flex' }, [statusChip(row.status), el('span', { class: 'chip chip--gold', text: 'Admission free' })]),

          el('h3', { text: 'Customer' }),
          el('dl', { class: 'facts' }, [
            fact('Name', row.full_name || '—'),
            fact('Email', row.email || '—'),
            fact('WhatsApp', row.whatsapp_number || '—'),
            fact('Verified', row.whatsapp_verified ? 'Yes' : 'Not yet'),
          ]),

          el('h3', { text: 'Concert' }),
          el('dl', { class: 'facts' }, [
            fact('Concert', currentConcertName(row)),
            fact('Seat', row.seat_number || '—'),
            fact('Section', row.section_name || '—'),
          ]),

          el('h3', { text: 'Ticket' }),
          el('dl', { class: 'facts' }, [
            fact('Reference', row.booking_reference),
            fact('Created by', row.source === 'ADMIN' ? 'Staff' : 'The attendee'),
            fact('Delivery', row.whatsapp_verified ? 'WhatsApp confirmation sent' : 'Awaiting WhatsApp verification'),
          ]),

          el('h3', { text: 'Timeline' }),
          bookingTimeline(row),
        );
      },
      actions: [
        { label: 'Download ticket', onClick: () => downloadTicket(row) },
        { label: 'Resend confirmation', onClick: () => resendConfirmation(row) },
        ...(row.status === 'CONFIRMED' || row.status === 'PENDING'
          ? [
              {
                label: 'Cancel booking',
                variant: 'danger',
                onClick: ({ close }) => {
                  close();
                  cancelBooking(row);
                },
              },
            ]
          : []),
      ],
    });
  }

  function bookingTimeline(row) {
    const items = [
      { label: 'Booking created', at: row.created_at, state: 'done' },
      row.confirmed_at ? { label: 'Confirmed', at: row.confirmed_at, state: 'done' } : null,
      row.whatsapp_verified
        ? { label: 'WhatsApp confirmation sent', at: row.confirmed_at || row.created_at, state: 'done' }
        : { label: 'Waiting on WhatsApp verification', at: null, state: 'current' },
      row.cancelled_at
        ? { label: `Cancelled${row.cancel_reason ? ` — ${row.cancel_reason}` : ''}`, at: row.cancelled_at, state: 'cancelled' }
        : null,
    ].filter(Boolean);

    return el(
      'ul',
      { class: 'timeline' },
      items.map((item) =>
        el('li', { 'data-state': item.state }, [
          el('strong', { text: item.label }),
          el('span', { text: item.at ? formatShortDate(item.at) : 'Pending' }),
        ]),
      ),
    );
  }

  function downloadTicket(row) {
    // The staff route, not /bookings/mine/confirmation — that one is scoped to
    // the signed-in attendee and an admin session would not satisfy it.
    window.open(
      `/api/admin/bookings/${encodeURIComponent(row.booking_reference)}/ticket?print=1`,
      '_blank',
      'noopener',
    );
  }

  async function resendConfirmation(row) {
    if (!row.whatsapp_verified) {
      UI.toastError(
        'No verified WhatsApp number',
        `${row.full_name || 'This attendee'} has not verified their number, so nothing can be delivered yet.`,
      );
      return;
    }
    try {
      const result = await api(`/api/admin/notifications/remind?concert_id=${row.concert_id || state.concertId}`, {
        method: 'POST',
        body: {},
      });
      UI.toastSuccess('Reminder queued', result.message || 'The confirmation has been re-sent.');
      invalidate('notifications');
      refreshUnread();
    } catch (error) {
      UI.toastError('Could not resend the confirmation', error.message);
    }
  }

  async function cancelBooking(row) {
    const ok = await UI.confirm({
      title: `Cancel ${row.booking_reference}?`,
      message: `Seat ${row.seat_number} is released back to the pool and ${row.full_name || 'the attendee'} is sent a cancellation on WhatsApp.`,
      confirmLabel: 'Cancel booking',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/bookings/${row.id}`, {
        method: 'DELETE',
        body: { reason: 'Cancelled by staff' },
      });
      UI.toastSuccess('Booking cancelled', row.booking_reference);
      invalidate('overview', 'concerts', 'reports', 'notifications');
      await renderBookings();
      refreshUnread();
    } catch (error) {
      UI.toastError('Could not cancel the booking', error.message);
    }
  }

  async function manualBooking() {
    const [{ users }, seatMap] = await Promise.all([
      api('/api/admin/users?per_page=100'),
      api(`/api/admin/seats?concert_id=${state.concertId}`),
    ]);

    const person = el('select', { id: 'mb_user', name: 'user_id', required: true });
    for (const user of users) {
      person.append(el('option', { value: user.id, text: `${user.full_name} — ${user.email}` }));
    }

    const seat = el('select', { id: 'mb_seat', name: 'seat_ids', required: true });
    for (const section of seatMap.sections) {
      for (const s of section.seats.filter((x) => x.status === 'AVAILABLE')) {
        seat.append(el('option', { value: s.id, text: `${s.seat_number} — ${section.name}` }));
      }
    }
    if (!seat.options.length) {
      UI.toastError('No free seats', 'Every seat in this concert is taken, held or blocked.');
      return;
    }

    const form = el('form', {}, [
      selectField('mb_user', 'Attendee', person, 'user'),
      selectField('mb_seat', 'Seat', seat, 'seat'),
      el('div', { class: 'field' }, [
        el('label', { for: 'mb_note', text: 'Note (optional)' }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': 'note', 'aria-hidden': 'true' }),
          el('input', { id: 'mb_note', name: 'note', type: 'text', placeholder: 'Booked at the church office' }),
        ]),
      ]),
    ]);

    UI.drawer({
      title: 'Book a seat for someone',
      subtitle: 'For people who cannot register themselves. They still need an account.',
      render: (body) => body.append(form),
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        {
          label: 'Create booking',
          variant: 'primary',
          onClick: async ({ close }) => {
            try {
              const values = formValues(form);
              const result = await api('/api/admin/bookings', {
                method: 'POST',
                body: {
                  user_id: Number(values.user_id),
                  seat_ids: [Number(values.seat_ids)],
                  note: values.note || undefined,
                  concert_id: state.concertId,
                },
              });
              close();
              UI.toastSuccess('Booking created', result.message || '');
              invalidate('overview', 'seats', 'concerts', 'reports', 'notifications');
              await renderBookings();
              refreshUnread();
            } catch (error) {
              if (error.details) showFieldErrors(form, error.details);
              UI.toastError('Could not create the booking', error.message);
            }
          },
        },
      ],
    });
  }

  const selectField = (id, label, select, icon) =>
    el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      el('span', { class: 'field__control field__control--inline' }, [
        el('span', { class: 'field__icon', 'data-icon': icon, 'aria-hidden': 'true' }),
        select,
        el('span', { class: 'field__chevron', 'aria-hidden': 'true' }),
      ]),
      el('span', { class: 'field__error', 'data-error-for': select.name }),
    ]);

  // ==========================================================================
  // Attendees
  // ==========================================================================

  async function loadUsers() {
    await renderUsers();
    once('users:filters', () => {
      const rerun = () => {
        state.users.page = 1;
        renderUsers().catch((error) => fail(error, 'Could not load attendees'));
      };
      $('[data-user-search]').addEventListener('input', debounce(rerun, 300));
      $('[data-user-status]').addEventListener('change', rerun);
      $('[data-user-verified]').addEventListener('change', rerun);
      $('[data-user-booked]').addEventListener('change', rerun);
      $('[data-action="export-users"]').addEventListener('click', () => {
        window.open('/api/admin/export/users.csv', '_blank', 'noopener');
      });
    });
  }

  async function renderUsers() {
    const box = $('[data-users-table]');
    UI.skeleton(box, { kind: 'row', count: 8 });

    const params = new URLSearchParams({ page: String(state.users.page), per_page: '25' });
    const search = $('[data-user-search]')?.value.trim();
    if (search) params.set('search', search);
    const status = $('[data-user-status]')?.value;
    if (status) params.set('status', status);
    const verified = $('[data-user-verified]')?.value;
    if (verified) params.set('verified', verified);
    const booked = $('[data-user-booked]')?.value;
    if (booked) params.set('booked', booked);

    const { users, pagination } = await api(`/api/admin/users?${params}`);

    box.textContent = '';
    if (!users.length) {
      UI.empty(box, {
        title: 'No attendees match',
        message: 'Try a different search, or clear the filters.',
        icon: 'users',
      });
    } else {
      const body = el('tbody');
      for (const user of users) {
        body.append(
          el('tr', { 'data-clickable': 'true', onClick: () => showUser(user) }, [
            el('td', {}, [
              el('div', { class: 'cell-person' }, [
                el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(user.full_name) }),
                el('div', {}, [
                  el('span', { class: 'data-table__strong', text: user.full_name }),
                  el('span', { class: 'data-table__sub', text: user.email }),
                ]),
              ]),
            ]),
            el('td', { class: 'u-nowrap', text: user.whatsapp_number || '—' }),
            el('td', {}, [
              user.whatsapp_verified
                ? el('span', { class: 'chip chip--ok', text: 'Verified' })
                : el('span', { class: 'chip chip--wait', text: 'Pending' }),
            ]),
            el('td', { class: 'u-tabular', text: String(user.live_seats ?? user.bookings ?? 0) }),
            el('td', {}, [
              user.is_active
                ? el('span', { class: 'chip chip--ok', text: 'Active' })
                : el('span', { class: 'chip chip--off', text: 'Disabled' }),
            ]),
            el('td', { class: 'u-nowrap', text: formatShortDate(user.created_at) }),
          ]),
        );
      }

      box.append(
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Attendee' }),
              el('th', { text: 'WhatsApp' }),
              el('th', { text: 'Verification' }),
              el('th', { text: 'Seats' }),
              el('th', { text: 'Account' }),
              el('th', { text: 'Registered' }),
            ]),
          ]),
          body,
        ]),
      );
    }

    renderPager($('[data-users-pager]'), pagination, users.length, (page) => {
      state.users.page = page;
      renderUsers().catch((error) => fail(error, 'Could not load attendees'));
    });
  }

  async function showUser(user) {
    const drawer = UI.drawer({
      title: user.full_name,
      subtitle: user.email,
      render: (body) => UI.skeleton(body, { kind: 'text', count: 6 }),
    });

    try {
      const detail = await api(`/api/admin/users/${user.id}`);
      drawer.body.textContent = '';
      drawer.body.append(
        el('div', { class: 'u-flex' }, [
          detail.user.is_active
            ? el('span', { class: 'chip chip--ok', text: 'Active' })
            : el('span', { class: 'chip chip--off', text: 'Disabled' }),
          detail.user.whatsapp_verified
            ? el('span', { class: 'chip chip--ok', text: 'WhatsApp verified' })
            : el('span', { class: 'chip chip--wait', text: 'WhatsApp pending' }),
        ]),
        el('h3', { text: 'Contact' }),
        el('dl', { class: 'facts' }, [
          fact('Email', detail.user.email),
          fact('Mobile', detail.user.mobile_number || '—'),
          fact('WhatsApp', detail.user.whatsapp_number || '—'),
          fact('Emergency', detail.user.emergency_contact || '—'),
          fact('Address', detail.user.address || '—'),
          fact('Age', detail.user.age ? String(detail.user.age) : '—'),
        ]),
        el('h3', { text: `Bookings (${detail.bookings.length})` }),
      );

      if (!detail.bookings.length) {
        drawer.body.append(el('p', { class: 'muted', text: 'No bookings yet.' }));
      } else {
        const list = el('ul', { class: 'timeline' });
        for (const booking of detail.bookings) {
          list.append(
            el('li', { 'data-state': booking.status === 'CANCELLED' ? 'cancelled' : 'done' }, [
              el('strong', { text: `${booking.booking_reference} · seat ${booking.seat_number}` }),
              el('span', { text: `${booking.status.toLowerCase()} · ${formatShortDate(booking.created_at)}` }),
            ]),
          );
        }
        drawer.body.append(list);
      }
    } catch (error) {
      drawer.body.textContent = '';
      UI.empty(drawer.body, { title: 'Could not load this attendee', message: error.message, icon: 'alert' });
    }
  }

  // ==========================================================================
  // Notifications
  // ==========================================================================

  const NOTIF_TABS = [
    ['ALL', 'All'],
    ['BOOKING', 'Bookings'],
    ['TICKET', 'Tickets'],
    ['CONCERT', 'Concerts'],
    ['SYSTEM', 'System'],
  ];

  async function loadNotifications() {
    await renderNotifications();
    once('notifications:readall', () =>
      $('[data-action="read-all"]').addEventListener('click', async () => {
      try {
        await api('/api/admin/console-notifications/read-all', { method: 'PATCH', body: {} });
        UI.toastSuccess('All caught up');
        await renderNotifications();
        refreshUnread();
      } catch (error) {
        UI.toastError('Could not mark them read', error.message);
        }
      }),
    );
  }

  async function renderNotifications() {
    const list = $('[data-notif-list]');
    UI.skeleton(list, { kind: 'row', count: 6 });

    const params = new URLSearchParams({ page: String(state.notif.page), per_page: '20' });
    if (state.notif.category !== 'ALL') params.set('category', state.notif.category);
    const data = await api(`/api/admin/console-notifications?${params}`);

    const tabs = $('[data-notif-tabs]');
    tabs.textContent = '';
    for (const [key, label] of NOTIF_TABS) {
      const count =
        key === 'ALL' ? data.counts.unread : data.counts.by_category[key]?.unread || 0;
      const tab = el('button', {
        class: 'notif-tab',
        type: 'button',
        role: 'tab',
        'aria-selected': String(state.notif.category === key),
        onClick: () => {
          state.notif.category = key;
          state.notif.page = 1;
          renderNotifications().catch((error) => fail(error, 'Could not load notifications'));
        },
      });
      tab.append(label);
      if (count) tab.append(el('span', { class: 'notif-tab__count', text: String(count) }));
      tabs.append(tab);
    }

    list.textContent = '';
    if (!data.notifications.length) {
      UI.empty(list, {
        title: 'Nothing here',
        message:
          state.notif.category === 'ALL'
            ? 'Notifications appear as bookings come in and concerts fill up.'
            : 'No notifications in this category.',
        icon: 'bell',
      });
    } else {
      for (const item of data.notifications) list.append(notifRow(item));
    }

    renderPager($('[data-notif-pager]'), data.pagination, data.notifications.length, (page) => {
      state.notif.page = page;
      renderNotifications().catch((error) => fail(error, 'Could not load notifications'));
    });
  }

  const NOTIF_ICON = {
    BOOKING: 'ticket',
    TICKET: 'download',
    CONCERT: 'music',
    SYSTEM: 'alert',
  };

  function notifRow(item) {
    const unread = !item.read_at;
    const icon = el('span', {
      class: `notif__icon${item.severity === 'SUCCESS' ? ' notif__icon--success' : item.severity === 'WARNING' ? ' notif__icon--warning' : ''}`,
      'data-notif-icon': NOTIF_ICON[item.category] || 'info',
      'aria-hidden': 'true',
    });
    paintIcon(icon, NOTIF_ICON[item.category] || 'info', '--notif-icon');

    const row = el('article', { class: 'notif', 'data-unread': String(unread) }, [
      icon,
      el('div', { class: 'notif__text' }, [
        el('h3', { class: 'notif__title', text: item.title }),
        item.body ? el('p', { class: 'notif__body', text: item.body }) : null,
        el('time', { class: 'notif__time', datetime: item.created_at, text: relativeTime(item.created_at) }),
      ]),
      el('div', { class: 'notif__actions' }, [
        iconButton(unread ? 'check' : 'eye-view', unread ? 'Mark as read' : 'Mark as unread', async () => {
          try {
            await api(`/api/admin/console-notifications/${item.id}`, {
              method: 'PATCH',
              body: { read: unread },
            });
            await renderNotifications();
            refreshUnread();
          } catch (error) {
            UI.toastError('Could not update it', error.message);
          }
        }),
        iconButton('trash', 'Delete notification', async () => {
          const ok = await UI.confirm({
            title: 'Delete this notification?',
            message: item.title,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/admin/console-notifications/${item.id}`, { method: 'DELETE' });
            await renderNotifications();
            refreshUnread();
          } catch (error) {
            UI.toastError('Could not delete it', error.message);
          }
        }),
      ]),
    ]);
    return row;
  }

  // ==========================================================================
  // Reports & export
  // ==========================================================================

  const REPORTS = [
    {
      key: 'bookings',
      title: 'Booking report',
      body: 'Every booking with its reference, attendee, seat and status.',
      icon: 'ticket',
      csv: '/api/admin/export/bookings.csv',
    },
    {
      key: 'customers',
      title: 'Customer report',
      body: 'Registered attendees, contact details and WhatsApp verification.',
      icon: 'users',
      csv: '/api/admin/export/users.csv',
    },
    {
      key: 'concerts',
      title: 'Concert report',
      body: 'Each concert with its capacity, seats laid out and occupancy.',
      icon: 'music',
      build: () => state.concerts,
    },
    {
      key: 'occupancy',
      title: 'Seat occupancy report',
      body: 'Seat counts by status, per concert, for the current window.',
      icon: 'seat',
      build: () => state.concerts,
    },
  ];

  async function loadReports() {
    await renderReports();
    once('reports:filters', () => {
    $('[data-report-range]').addEventListener('change', (event) => {
      state.reports.days = Number(event.target.value);
      renderReports().catch((error) => fail(error, 'Could not load reports'));
    });
    $('[data-report-concert]').addEventListener('change', (event) => {
      state.reports.concertId = event.target.value;
      renderReports().catch((error) => fail(error, 'Could not load reports'));
    });
    $('[data-action="refresh-reports"]').addEventListener('click', () => {
      renderReports()
        .then(() => UI.toast('Reports refreshed'))
        .catch((error) => fail(error, 'Could not refresh'));
    });
    });
  }

  async function renderReports() {
    const kpis = $('[data-report-kpis]');
    UI.skeleton(kpis, { kind: 'kpi', count: 5 });

    const query = new URLSearchParams({ days: String(state.reports.days) });
    if (state.reports.concertId) query.set('concert_id', state.reports.concertId);

    const [summary, trend, concerts] = await Promise.all([
      api(`/api/admin/analytics/summary?${query}`),
      api(`/api/admin/analytics/bookings?${query}`),
      api('/api/admin/analytics/concerts'),
    ]);
    state.concerts = concerts.concerts;

    kpis.textContent = '';
    kpis.append(
      kpiCard({ label: 'Total bookings', value: summary.bookings.parties, icon: 'ticket', meta: 'parties' }),
      kpiCard({ label: 'Seats reserved', value: summary.bookings.live_seats, icon: 'seat', meta: 'currently held' }),
      kpiCard({
        label: 'Occupancy',
        value: `${summary.capacity.occupancy}%`,
        icon: 'gauge',
        feature: true,
        rail: summary.capacity.occupancy,
        meta: `${summary.capacity.remaining} seats free`,
      }),
      kpiCard({
        label: 'Cancellations',
        value: summary.bookings.cancelled_seats,
        icon: 'alert',
        meta: `${summary.bookings.cancellation_rate}% of all seat rows`,
        delta: {
          direction: summary.bookings.cancellation_rate > 15 ? 'down' : 'flat',
          label: summary.bookings.cancellation_rate > 15 ? 'High' : 'Normal',
        },
      }),
      kpiCard({
        label: 'Registered attendees',
        value: summary.people.registered,
        icon: 'users',
        meta: `${summary.people.whatsapp_verified} WhatsApp verified`,
      }),
    );

    UI.lineChart($('[data-report-trend]'), trend.series, [
      { key: 'seats', label: 'Seats' },
      { key: 'cancellations', label: 'Cancelled', accent: true },
    ]);

    UI.stackChart($('[data-report-occupancy]'), [
      { label: 'Booked', value: summary.seats.booked, tone: 'booked' },
      { label: 'Available', value: summary.seats.available, tone: 'available' },
      { label: 'Held', value: summary.seats.reserved, tone: 'reserved' },
      { label: 'Blocked', value: summary.seats.blocked, tone: 'blocked' },
    ]);

    UI.rankChart(
      $('[data-report-performance]'),
      state.concerts.map((c) => ({ label: c.name, value: c.occupancy, accent: c.occupancy >= 80 })),
      { suffix: '%' },
    );

    renderExports();
  }

  function renderExports() {
    const box = $('[data-exports]');
    box.textContent = '';
    for (const report of REPORTS) {
      const icon = el('span', { class: 'export-card__icon', 'aria-hidden': 'true' });
      paintIcon(icon, report.icon, '--export-icon');

      const formats = el('div', { class: 'export-card__formats' });
      formats.append(
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'CSV',
          onClick: () => exportReport(report, 'csv'),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Excel',
          onClick: () => exportReport(report, 'excel'),
        }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'PDF',
          onClick: () => exportReport(report, 'pdf'),
        }),
      );

      box.append(
        el('article', { class: 'export-card' }, [
          icon,
          el('h3', { text: report.title }),
          el('p', { text: report.body }),
          formats,
        ]),
      );
    }
  }

  /**
   * CSV comes from the server where an endpoint exists, and is built here from
   * data already on screen where one does not. "Excel" is the same CSV with a
   * BOM so Excel opens it as UTF-8 rather than mangling names; PDF hands the
   * table to the browser's own print-to-PDF, which is honest about what it is
   * rather than shipping a PDF writer for four tables.
   */
  function exportReport(report, format) {
    if (report.csv && format === 'csv') {
      window.open(report.csv, '_blank', 'noopener');
      return;
    }

    const rows = report.build ? report.build() : [];
    if (!rows.length) {
      UI.toastError('Nothing to export', 'There is no data in the current window.');
      return;
    }

    const columns = [
      ['name', 'Concert'],
      ['event_date', 'Date'],
      ['venue', 'Venue'],
      ['max_capacity', 'Capacity'],
      ['total_seats', 'Seats laid out'],
      ['booked_seats', 'Booked'],
      ['available_seats', 'Available'],
      ['reserved_seats', 'Held'],
      ['blocked_seats', 'Blocked'],
      ['parties', 'Parties'],
      ['cancellations', 'Cancellations'],
      ['occupancy', 'Occupancy %'],
    ];

    if (format === 'pdf') {
      printReport(report, rows, columns);
      return;
    }

    const csv = [
      columns.map(([, label]) => label).join(','),
      ...rows.map((row) =>
        columns
          .map(([key]) => {
            const value = key === 'event_date' ? String(row[key]).slice(0, 10) : row[key];
            const text = String(value ?? '');
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(','),
      ),
    ].join('\r\n');

    // The BOM is what makes Excel read this as UTF-8.
    const blob = new Blob([format === 'excel' ? '﻿' : '', csv], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `${report.key}-report.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    UI.toastSuccess('Export ready', `${report.title} downloaded.`);
  }

  /**
   * A branded, print-ready report.
   *
   * Built with DOM calls rather than innerHTML because the values come from the
   * database — a concert someone named `<script>` would otherwise execute in
   * the new window. Styling is a <style> element, which is fine: this is a
   * document this script created, not one served under the site's CSP.
   */
  function printReport(report, rows, columns) {
    const win = window.open('', '_blank', 'width=1024,height=768');
    if (!win) {
      UI.toastError('Pop-up blocked', 'Allow pop-ups for this site to save a report as PDF.');
      return;
    }
    const doc = win.document;
    doc.title = `${report.title} — ${state.admin?.full_name ? 'Night of Worship' : 'Report'}`;

    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.append(meta);

    const style = doc.createElement('style');
    style.textContent = `
      @page { size: A4 landscape; margin: 12mm; }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; padding: 28px 32px 40px; color: #0f172a; background: #fff;
             font: 12.5px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
              padding-bottom: 14px; margin-bottom: 20px; border-bottom: 3px solid #b58328; }
      .brand { display: flex; align-items: center; gap: 12px; }
      .brand img { width: 34px; height: 34px; }
      .brand b { display: block; font-size: 15px; letter-spacing: -.01em; }
      .brand span { display: block; font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: #b58328; }
      h1 { margin: 14px 0 2px; font-size: 21px; letter-spacing: -.02em; }
      .lede { margin: 0; font-size: 12px; color: #64748b; max-width: 80ch; }
      .stamp { text-align: right; font-size: 10.5px; color: #64748b; line-height: 1.7; }
      .stamp b { display: block; color: #0f172a; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; margin-top: 18px; }
      thead { display: table-header-group; }
      th { text-align: left; padding: 9px 10px; background: #16233d; color: #fff;
           font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
      th:first-child { border-radius: 6px 0 0 0; }
      th:last-child { border-radius: 0 6px 0 0; }
      td { padding: 8px 10px; border-bottom: 1px solid #e6eaf0; }
      tbody tr:nth-child(even) td { background: #fbfcfd; }
      tbody tr { page-break-inside: avoid; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .foot { margin-top: 22px; padding-top: 12px; border-top: 1px solid #e6eaf0;
              display: flex; justify-content: space-between; font-size: 10px; color: #64748b; }
      .free { color: #b58328; font-weight: 700; }
      @media print { .noprint { display: none; } }
    `;
    doc.head.append(style);

    // --- Header ---
    const head = doc.createElement('div');
    head.className = 'head';

    const left = doc.createElement('div');
    const brand = doc.createElement('div');
    brand.className = 'brand';
    const logo = doc.createElement('img');
    logo.src = `${window.location.origin}/assets/logo.svg`;
    logo.alt = '';
    const words = doc.createElement('div');
    const b = doc.createElement('b');
    b.textContent = 'Night of Worship';
    const sp = doc.createElement('span');
    sp.textContent = 'Concert management';
    words.append(b, sp);
    brand.append(logo, words);

    const h1 = doc.createElement('h1');
    h1.textContent = report.title;
    const lede = doc.createElement('p');
    lede.className = 'lede';
    lede.textContent = report.body;
    left.append(brand, h1, lede);

    const stamp = doc.createElement('div');
    stamp.className = 'stamp';
    const when = doc.createElement('b');
    when.textContent = new Date().toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    stamp.append(when);
    stamp.append(doc.createTextNode(`Generated ${new Date().toLocaleTimeString()}`));
    stamp.append(doc.createElement('br'));
    stamp.append(doc.createTextNode(`By ${state.admin?.full_name || 'the console'}`));
    stamp.append(doc.createElement('br'));
    stamp.append(doc.createTextNode(`${rows.length} row${rows.length === 1 ? '' : 's'}`));

    head.append(left, stamp);

    // --- Table ---
    const table = doc.createElement('table');
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const [key, label] of columns) {
      const th = doc.createElement('th');
      th.textContent = label;
      if (NUMERIC_COLUMNS.has(key)) th.className = 'num';
      headRow.append(th);
    }
    thead.append(headRow);

    const tbody = doc.createElement('tbody');
    for (const row of rows) {
      const tr = doc.createElement('tr');
      for (const [key] of columns) {
        const td = doc.createElement('td');
        if (NUMERIC_COLUMNS.has(key)) td.className = 'num';
        td.textContent =
          key === 'event_date'
            ? formatDate(row[key])
            : key === 'occupancy'
              ? `${row[key]}%`
              : String(row[key] ?? '');
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);

    // --- Footer ---
    const foot = doc.createElement('div');
    foot.className = 'foot';
    const freeNote = doc.createElement('span');
    freeNote.append(doc.createTextNode('Admission is free — this report contains no financial data. '));
    const em = doc.createElement('span');
    em.className = 'free';
    em.textContent = 'No payments are ever collected.';
    freeNote.append(em);
    const src = doc.createElement('span');
    src.textContent = window.location.origin;
    foot.append(freeNote, src);

    doc.body.append(head, table, foot);

    // Printing before the logo has decoded gives a report with a hole in it.
    const go = () => {
      win.focus();
      win.print();
    };
    if (logo.complete) go();
    else {
      logo.addEventListener('load', go);
      logo.addEventListener('error', go);
    }
  }

  /** Columns that should sit right-aligned and tabular in a printed report. */
  const NUMERIC_COLUMNS = new Set([
    'max_capacity', 'total_seats', 'booked_seats', 'available_seats',
    'reserved_seats', 'blocked_seats', 'parties', 'cancellations', 'occupancy',
  ]);

  // ==========================================================================
  // Settings
  // ==========================================================================

  const SETTINGS_SECTIONS = {
    branding: renderBranding,
    concert: renderConcertSettings,
    email: renderEmailSettings,
    whatsapp: renderWhatsappSettings,
    security: renderSecuritySettings,
  };

  async function loadSettings() {
    const { settings } = await api('/api/admin/settings');
    state.settings = settings;

    once('settings:nav', () => {
      $$('[data-settings-nav] button').forEach((button) => {
        button.addEventListener('click', () => {
          $$('[data-settings-nav] button').forEach((b) =>
            b.setAttribute('aria-selected', String(b === button)),
          );
          SETTINGS_SECTIONS[button.dataset.section]();
        });
      });
    });
    renderBranding();
  }

  const settingsCard = (title, lede, ...children) =>
    el('div', { class: 'surface' }, [
      el('div', { class: 'surface__head' }, [
        el('div', {}, [el('h2', { text: title }), lede ? el('p', { class: 'surface__head-sub', text: lede }) : null]),
      ]),
      el('div', { class: 'surface__body stack' }, children),
    ]);

  function renderBranding() {
    const box = $('[data-settings-body]');
    box.textContent = '';
    box.append(
      settingsCard(
        'Branding',
        'The name and mark used across the site, tickets and messages.',
        el('div', { class: 'logo-drop' }, [
          el('div', { class: 'logo-drop__preview' }, [
            el('img', { src: '/assets/logo.svg', alt: 'Current logo', width: 48, height: 48 }),
          ]),
          el('div', {}, [
            el('p', { class: 'data-table__strong', text: 'Church Concert mark' }),
            el('p', {
              class: 'field__hint',
              text: 'Replace public/assets/logo.svg and favicon.svg to change it everywhere. They are bundled files rather than an upload, because the CSP serves images from this origin only.',
            }),
          ]),
        ]),
        el('dl', { class: 'facts' }, [
          fact('Organisation', 'Grace Community Church'),
          fact('Product name', 'Night of Worship'),
          fact('Admission', 'Free — no payment is ever collected'),
        ]),
      ),
    );
  }

  function renderConcertSettings() {
    const box = $('[data-settings-body]');
    box.textContent = '';

    const form = el('form', { class: 'form-narrow' }, [
      el('div', { class: 'field' }, [
        el('label', { for: 's_min_age', text: 'Minimum age' }),
        el('span', { class: 'field__control field__control--inline' }, [
          el('span', { class: 'field__icon', 'data-icon': 'identity', 'aria-hidden': 'true' }),
          el('input', {
            id: 's_min_age',
            name: 'minimum_age',
            type: 'number',
            min: '18',
            max: '99',
            value: state.settings.minimum_age ?? 18,
          }),
        ]),
        el('p', { class: 'field__hint', text: 'Checked on the server when someone registers.' }),
      ]),
      checkbox('s_require_wa', 'require_whatsapp_verification', 'Require WhatsApp verification before booking', state.settings.require_whatsapp_verification),
      checkbox('s_self_cancel', 'allow_user_self_cancel', 'Let attendees cancel their own booking', state.settings.allow_user_self_cancel),
    ]);

    const save = el('button', { class: 'btn btn--primary btn--small', type: 'submit', text: 'Save settings' });
    form.append(save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(save, true, 'Saving…');
      try {
        await api('/api/admin/settings', { method: 'PATCH', body: formValues(form) });
        UI.toastSuccess('Settings saved');
        invalidate('settings');
      } catch (error) {
        UI.toastError('Could not save settings', error.message);
      } finally {
        busy(save, false);
      }
    });

    box.append(settingsCard('Concert settings', 'Rules applied to every concert unless a concert overrides them.', form));
  }

  const checkbox = (id, name, label, checked) =>
    el('div', { class: 'check' }, [
      el('input', { id, name, type: 'checkbox', checked: checked ? true : null }),
      el('label', { for: id, text: label }),
    ]);

  async function renderEmailSettings() {
    const box = $('[data-settings-body]');
    box.textContent = '';

    const status = el('div', { class: 'u-flex' }, [
      el('span', { class: 'chip chip--neutral', text: 'Checking…' }),
    ]);

    const testButton = el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      text: 'Send me a test email',
    });
    testButton.addEventListener('click', async () => {
      busy(testButton, true, 'Sending…');
      try {
        const result = await api('/api/admin/email/test', { method: 'POST', body: {} });
        UI.toastSuccess('Test sent', result.message);
      } catch (error) {
        UI.toastError('Test failed', error.message);
      } finally {
        busy(testButton, false);
      }
    });

    box.append(
      settingsCard(
        'Email',
        'Outgoing mail, and what goes out on it.',
        status,
        el('dl', { class: 'facts' }, [
          fact('Verification code', 'Email and WhatsApp — the same code, sent to both'),
          fact('Booking confirmation', 'Email and WhatsApp, each logged separately'),
          fact('Password reset', 'Email only — a reset link is a bearer credential'),
          fact('Ticket', 'Linked from the confirmation email, and downloadable from the portal'),
        ]),
        el('div', { class: 'u-flex' }, [testButton]),
        el('p', {
          class: 'field__hint',
          text:
            'Transport and credentials come from the environment (EMAIL_DRIVER, EMAIL_USER, ' +
            'EMAIL_PASSWORD — see .env.example), never from here, so a deployment cannot be ' +
            'reconfigured from a browser session. Gmail needs a 16-character App Password with ' +
            '2-Step Verification switched on; the account password will be rejected.',
        }),
      ),
    );

    // Report the real connection state rather than asserting it works.
    try {
      const result = await api('/api/admin/email/test');
      status.textContent = '';
      if (result.driver === 'mock') {
        status.append(
          el('span', { class: 'chip chip--wait', text: 'Mock driver' }),
          el('span', { class: 'text-sm muted', text: 'Nothing is actually delivered.' }),
        );
        testButton.disabled = true;
      } else if (result.ok) {
        status.append(
          el('span', { class: 'chip chip--ok', text: `${result.driver} connected` }),
          el('span', { class: 'text-sm muted', text: result.detail || '' }),
        );
      } else {
        status.append(
          el('span', { class: 'chip chip--off', text: 'Not connected' }),
          el('span', { class: 'text-sm muted', text: result.error || '' }),
        );
      }
    } catch (error) {
      status.textContent = '';
      status.append(el('span', { class: 'chip chip--off', text: 'Could not check' }),
        el('span', { class: 'text-sm muted', text: error.message }));
    }
  }

  function renderWhatsappSettings() {
    const box = $('[data-settings-body]');
    box.textContent = '';

    const remind = el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Send event reminder to everyone' });
    remind.addEventListener('click', async () => {
      const ok = await UI.confirm({
        title: 'Send the reminder now?',
        message: 'Everyone holding a live booking with a verified WhatsApp number gets a message with their seat and reference.',
        confirmLabel: 'Send reminder',
      });
      if (!ok) return;
      busy(remind, true, 'Sending…');
      try {
        const result = await api(`/api/admin/notifications/remind?concert_id=${state.concertId}`, {
          method: 'POST',
          body: {},
        });
        UI.toastSuccess('Reminders sent', result.message || '');
      } catch (error) {
        UI.toastError('Could not send reminders', error.message);
      } finally {
        busy(remind, false);
      }
    });

    box.append(
      settingsCard(
        'WhatsApp',
        'Used for ticket confirmation and reminders — never for signing in.',
        el('dl', { class: 'facts' }, [
          fact('Ticket confirmation', 'Sent on WhatsApp and by email the moment a booking is confirmed'),
          fact('Event reminder', 'Sent manually, from here — goes to both channels'),
          fact('Registration', 'Email and password. WhatsApp verifies the number it will message'),
          fact('Password recovery', 'Email link only, never WhatsApp'),
        ]),
        remind,
      ),
    );
  }

  function renderSecuritySettings() {
    const box = $('[data-settings-body]');
    box.textContent = '';

    const form = el('form', { class: 'form-narrow' }, [
      passwordField('sec_current', 'current_password', 'Current password', 'lock'),
      passwordField('sec_new', 'new_password', 'New password', 'key'),
    ]);
    const save = el('button', { class: 'btn btn--primary btn--small', type: 'submit', text: 'Change password' });
    form.append(save);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      busy(save, true, 'Saving…');
      try {
        await api('/api/auth/admin/password', { method: 'POST', body: formValues(form) });
        UI.toastSuccess('Password changed', 'Use the new password next time you sign in.');
        form.reset();
      } catch (error) {
        if (error.details) showFieldErrors(form, error.details);
        UI.toastError('Could not change the password', error.message);
      } finally {
        busy(save, false);
      }
    });

    box.append(
      settingsCard(
        'Security',
        'Your own account. Attendee accounts are managed from Attendees.',
        el('dl', { class: 'facts' }, [
          fact('Signed in as', state.admin?.email || '—'),
          fact('Role', state.admin?.role || '—'),
          fact('Session', 'Twelve hours, or fourteen days with “keep me signed in”'),
        ]),
        form,
      ),
    );
    enhanceFields(box);
  }

  const passwordField = (id, name, label, icon) =>
    el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      el('span', { class: 'field__control field__control--inline' }, [
        el('span', { class: 'field__icon', 'data-icon': icon, 'aria-hidden': 'true' }),
        el('input', { id, name, type: 'password', autocomplete: name.includes('new') ? 'new-password' : 'current-password', required: true }),
      ]),
      el('span', { class: 'field__error', 'data-error-for': name }),
    ]);

  // ==========================================================================
  // Utilities
  // ==========================================================================

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  // ==========================================================================
  // Boot
  // ==========================================================================

  (async function boot() {
    try {
      const { admin } = await api('/api/admin/me');
      state.admin = admin;
    } catch {
      window.location.href = '/admin/login.html';
      return;
    }

    $('[data-admin-name]').textContent = state.admin.full_name;
    $('[data-admin-role]').textContent = state.admin.email;
    for (const node of [$('[data-admin-initials]'), $('[data-topbar-initials]')]) {
      node.textContent = initials(state.admin.full_name);
    }

    mountShell();
    clearNotice('[data-notice]');

    // Quick actions live on more than one panel, so they are bound once here.
    $$('[data-action="create-concert"]').forEach((b) => b.addEventListener('click', createConcert));
    $$('[data-action="export-report"]').forEach((b) =>
      b.addEventListener('click', () => setTab('reports')),
    );

    try {
      const { concerts } = await api('/api/admin/analytics/concerts');
      state.concerts = concerts;
      fillConcertPickers(concerts);
    } catch (error) {
      fail(error, 'Could not load concerts');
    }

    refreshUnread();
    setInterval(refreshUnread, 60_000);

    const initial = window.location.hash.replace('#', '') || 'overview';
    setTab(initial, { push: false });
  })();
})();
