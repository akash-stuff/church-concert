/* Shared frontend helpers. No framework, no build step. */
'use strict';

const CSRF_COOKIE = 'cc_csrf';

function readCookie(name) {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
    ?.split('=')[1];
}

/**
 * Fetch wrapper that attaches the CSRF header and turns API errors into
 * throwable objects carrying { status, code, details }.
 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  if (!['GET', 'HEAD'].includes(method)) {
    let token = readCookie(CSRF_COOKIE);
    if (!token) {
      await fetch('/api/csrf', { credentials: 'same-origin' });
      token = readCookie(CSRF_COOKIE);
    }
    if (token) options.headers['X-CSRF-Token'] = token;
  }

  const response = await fetch(path, options);
  const text = await response.text();
  const data = text ? safeParse(text) : {};

  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// --- DOM helpers ----------------------------------------------------------

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function notify(target, message, kind = 'error') {
  const box = typeof target === 'string' ? $(target) : target;
  if (!box) return;
  box.className = `notice notice--${kind}`;
  box.textContent = message || '';
  if (message) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearNotice(target) {
  const box = typeof target === 'string' ? $(target) : target;
  if (box) {
    box.textContent = '';
    box.className = 'notice';
  }
}

/** Paint per-field validation errors returned by the API. */
function showFieldErrors(form, details = {}) {
  $$('[data-error-for]', form).forEach((node) => {
    node.textContent = '';
  });
  $$('[name]', form).forEach((input) => input.removeAttribute('aria-invalid'));
  $$('.field__control--invalid', form).forEach((node) =>
    node.classList.remove('field__control--invalid'),
  );

  let first = null;
  for (const [field, message] of Object.entries(details)) {
    const slot = $(`[data-error-for="${field}"]`, form);
    if (slot) slot.textContent = message;
    const input = form.elements[field];
    if (input && input.setAttribute) {
      input.setAttribute('aria-invalid', 'true');
      // Tints the leading mark red alongside the border.
      input.closest('.field__control')?.classList.add('field__control--invalid');
      if (!first) first = input;
    }
  }
  if (first) first.focus();
}

// --- Field enhancement ----------------------------------------------------

/**
 * Mount a show/hide control on every password box, and clear the invalid tint
 * as soon as someone starts correcting the field. Both are done here rather
 * than per page so a new form gets them for free by using .field__control.
 */
function enhanceFields(scope = document) {
  $$('.field__control > input[type="password"]', scope).forEach((input) => {
    if (input.dataset.revealMounted) return;
    input.dataset.revealMounted = '1';

    const toggle = el('button', {
      type: 'button',
      class: 'field__reveal',
      'aria-pressed': 'false',
      'aria-label': 'Show password',
      title: 'Show password',
    });
    toggle.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      toggle.setAttribute('aria-pressed', String(!shown));
      const label = shown ? 'Show password' : 'Hide password';
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
      input.focus();
    });
    input.after(toggle);
  });

  $$('.field__control', scope).forEach((control) => {
    if (control.dataset.clearMounted) return;
    control.dataset.clearMounted = '1';
    control.addEventListener('input', () => {
      control.classList.remove('field__control--invalid');
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => enhanceFields());
} else {
  enhanceFields();
}

function formValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') values[element.name] = element.checked;
    else if (element.type === 'radio') {
      if (element.checked) values[element.name] = element.value;
    } else values[element.name] = element.value;
  }
  return values;
}

function busy(button, isBusy, busyLabel = 'Working…') {
  if (!button) return;
  if (isBusy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    // Clearing it, not just reading it: the attribute is what drives the
    // spinner in the stylesheet, so a stale one leaves the button spinning.
    delete button.dataset.label;
    button.disabled = false;
  }
}

// --- Formatting -----------------------------------------------------------

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).length <= 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShortDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(value) {
  if (!value) return '—';
  const [h, m] = String(value).split(':');
  const hour = Number(h);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}.${m ?? '00'} ${suffix}`;
}

function pillFor(status) {
  const map = {
    CONFIRMED: 'ok',
    PENDING: 'wait',
    CANCELLED: 'off',
    EXPIRED: 'neutral',
    SENT: 'ok',
    DELIVERED: 'ok',
    READ: 'ok',
    QUEUED: 'wait',
    FAILED: 'off',
    AVAILABLE: 'ok',
    BOOKED: 'neutral',
    RESERVED: 'wait',
    DISABLED: 'off',
  };
  return el('span', { class: `pill pill--${map[status] || 'neutral'}`, text: status || '—' });
}

/**
 * Render the seat map. `onSelect` makes seats interactive; omit it for a
 * read-only view. `renderActions(seat)` adds admin controls beneath each seat.
 */
/**
 * Render the seat map.
 *
 * `selectedIds` may be a Set, an array, or a single id: a party books several
 * seats at once now, so selection is a collection rather than one value.
 * `mySeatNumbers` marks seats the signed-in person already holds.
 */
function renderSeatMap(container, sections, options = {}) {
  const {
    selectedId,
    selectedIds,
    onSelect,
    mySeatNumber,
    mySeatNumbers,
    renderActions,
    showStage = true,
  } = options;

  const selected = new Set(
    selectedIds instanceof Set
      ? selectedIds
      : Array.isArray(selectedIds)
        ? selectedIds
        : [selectedIds, selectedId].filter((id) => id !== undefined && id !== null),
  );

  const owned = new Set(
    (Array.isArray(mySeatNumbers) ? mySeatNumbers : [mySeatNumber]).filter(Boolean),
  );
  container.textContent = '';

  if (showStage) container.append(el('div', { class: 'stage', text: 'Stage' }));

  if (!sections.length) {
    container.append(
      el('p', {
        class: 'table-empty',
        text: 'No seats have been set up yet. An administrator adds them from the seat editor.',
      }),
    );
    return;
  }

  for (const section of sections) {
    const block = el('div', { class: 'section-block' });
    block.append(el('p', { class: 'section-block__name', text: section.name }));

    const rows = el('div', { class: 'seat-rows' });
    for (const seat of section.seats) {
      const isMine = seat.is_mine === true || owned.has(seat.seat_number);
      const selectable = Boolean(onSelect) && seat.status === 'AVAILABLE' && !seat.booking && !isMine;
      const isSelected = selected.has(seat.id);

      const label = isMine
        ? `Seat ${seat.seat_number}, already yours`
        : selectable
          ? `Seat ${seat.seat_number}, available${isSelected ? ', chosen' : ''}`
          : `Seat ${seat.seat_number}, ${seat.status.toLowerCase()}`;

      const button = el('button', {
        type: 'button',
        class: 'seat',
        'data-status': seat.status,
        'data-seat-id': seat.id,
        'data-mine': isMine ? 'true' : null,
        'aria-pressed': selectable ? String(isSelected) : null,
        'aria-label': label,
        title: seat.note || label,
        disabled: !selectable,
        text: seat.seat_number,
      });

      if (selectable) button.addEventListener('click', () => onSelect(seat));

      if (renderActions) {
        const cell = el('div', { class: 'seat-admin' }, [button]);
        const actions = renderActions(seat);
        if (actions) cell.append(actions);
        rows.append(cell);
      } else {
        rows.append(button);
      }
    }

    block.append(rows);
    container.append(block);
  }

  container.append(
    el('div', { class: 'legend' }, [
      legendKey('', 'Available'),
      legendKey('selected', 'Selected'),
      legendKey('booked', 'Booked'),
      legendKey('reserved', 'Held'),
      legendKey('disabled', 'Not in use'),
      mySeatNumber ? legendKey('mine', 'Your seat') : null,
    ]),
  );
}

function legendKey(variant, label) {
  return el('span', { class: 'legend__key' }, [
    el('span', { class: `legend__swatch${variant ? ` legend__swatch--${variant}` : ''}` }),
    label,
  ]);
}

/** Fill the masthead nav based on whether someone is signed in. */
async function mountHeader(current) {
  const nav = $('[data-nav]');
  if (!nav) return null;

  let session = { user: null };
  try {
    session = await api('/api/me');
  } catch {
    /* offline or not signed in — show the guest nav */
  }

  const links = session.user
    ? [
        ['/dashboard.html', 'My booking'],
        ['/seats.html', 'Seats'],
        ['#logout', 'Sign out'],
      ]
    : [
        ['/concert.html', 'The concert'],
        ['/login.html', 'Sign in'],
        ['/register.html', 'Register'],
      ];

  nav.textContent = '';
  for (const [href, label] of links) {
    const link = el('a', { href, text: label });
    if (href === current) link.setAttribute('aria-current', 'page');
    if (href === '#logout') {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        window.location.href = '/';
      });
    }
    nav.append(link);
  }
  return session;
}

/** Redirect to sign-in, remembering where the person wanted to go. */
function requireSession(session, target = window.location.pathname) {
  if (!session?.user) {
    window.location.href = `/login.html?next=${encodeURIComponent(target)}`;
    return false;
  }
  return true;
}

window.CC = {
  api,
  $,
  $$,
  el,
  notify,
  clearNotice,
  showFieldErrors,
  enhanceFields,
  formValues,
  busy,
  formatDate,
  formatShortDate,
  formatTime,
  pillFor,
  renderSeatMap,
  mountHeader,
  requireSession,
};
