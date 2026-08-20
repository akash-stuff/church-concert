/* Shared interface pieces: toasts, drawer, confirm dialog, skeletons, empty
   states and charts. No framework and no build step, in keeping with the rest
   of the front end, and no external script — the CSP allows 'self' only.

   Everything here is additive over core.js and reachable as window.UI. */
'use strict';

(function initUI() {
  const { el, $, $$ } = window.CC;

  // --- Focus management ---------------------------------------------------
  // Shared by the drawer and the dialog: both are modal, so both have to trap
  // the tab ring and give focus back to whatever opened them.

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapFocus(container, onEscape) {
    const previous = document.activeElement;

    const first = container.querySelector(FOCUSABLE);
    (first || container).focus();

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = $$(FOCUSABLE, container).filter((node) => node.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];

      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    container.addEventListener('keydown', onKeydown);
    return function release() {
      container.removeEventListener('keydown', onKeydown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }

  // --- Toasts -------------------------------------------------------------

  function toastStack() {
    let stack = $('[data-toasts]');
    if (!stack) {
      stack = el('div', { class: 'toast-stack', 'data-toasts': true, 'aria-live': 'polite' });
      document.body.append(stack);
    }
    return stack;
  }

  /**
   * `kind` is one of success | error | info. Errors stay until dismissed:
   * something went wrong is not a message to time out from under someone who
   * looked away.
   */
  function toast(title, { body = '', kind = 'info', duration, key } = {}) {
    const stack = toastStack();

    // Repeated failures produce the same message over and over — a retried
    // panel load will queue five identical toasts and bury the page under them.
    // An existing toast with the same identity is bumped with a counter rather
    // than duplicated.
    const identity = key ?? `${kind}:${title}:${body}`;
    const existing = stack.querySelector(`[data-toast-key="${CSS.escape(identity)}"]`);
    if (existing) {
      const count = Number(existing.dataset.toastCount || '1') + 1;
      existing.dataset.toastCount = String(count);
      const badge = existing.querySelector('.toast__repeat');
      if (badge) badge.textContent = `×${count}`;
      return () => existing.remove();
    }
    const node = el(
      'div',
      {
        class: `toast toast--${kind}`,
        role: kind === 'error' ? 'alert' : 'status',
        'data-toast-key': identity,
        'data-toast-count': '1',
      },
      [
        el('span', { class: 'toast__icon', 'aria-hidden': 'true' }),
        el('span', { class: 'toast__text' }, [
          el('strong', { class: 'toast__title' }, [
            title,
            el('span', { class: 'toast__repeat' }),
          ]),
          body ? el('span', { class: 'toast__body', text: body }) : null,
        ]),
      ],
    );

    const close = el('button', {
      type: 'button',
      class: 'toast__close',
      'aria-label': 'Dismiss notification',
    });
    const dismiss = () => {
      node.dataset.leaving = 'true';
      setTimeout(() => node.remove(), 200);
    };
    close.addEventListener('click', dismiss);
    node.append(close);
    stack.append(node);

    const life = duration ?? (kind === 'error' ? 0 : 4500);
    if (life > 0) setTimeout(dismiss, life);
    return dismiss;
  }

  const toastSuccess = (title, body) => toast(title, { body, kind: 'success' });
  const toastError = (title, body) => toast(title, { body, kind: 'error' });

  // --- Drawer -------------------------------------------------------------

  let openDrawer = null;

  /**
   * Right-hand detail panel. `render` receives the body element and fills it,
   * so a caller can paint a skeleton first and replace it when data lands.
   */
  function drawer({ title, subtitle = '', render, actions = [], onClose }) {
    closeDrawer();

    const scrim = el('div', { class: 'scrim' });
    const body = el('div', { class: 'drawer__body' });
    const panel = el(
      'aside',
      {
        class: 'drawer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        tabindex: '-1',
      },
      [
        el('header', { class: 'drawer__head' }, [
          el('div', {}, [
            el('h2', { class: 'drawer__title', text: title }),
            subtitle ? el('p', { class: 'drawer__sub', text: subtitle }) : null,
          ]),
          el('button', {
            type: 'button',
            class: 'toast__close',
            'aria-label': 'Close panel',
            onClick: () => closeDrawer(),
          }),
        ]),
        body,
      ],
    );

    if (actions.length) {
      const foot = el('footer', { class: 'drawer__foot' });
      for (const action of actions) {
        // The handler is handed its own button so it can show a spinner on the
        // control that was actually pressed. Without it a slow action leaves the
        // drawer looking inert, which reads as the app having hung.
        const button = el('button', {
          type: 'button',
          class: `btn btn--small ${action.variant ? `btn--${action.variant}` : 'btn--ghost'}`,
          text: action.label,
        });
        button.addEventListener('click', () =>
          action.onClick({ close: closeDrawer, body, button }),
        );
        foot.append(button);
      }
      panel.append(foot);
    }

    document.body.append(scrim, panel);
    if (render) render(body);

    const release = trapFocus(panel, () => closeDrawer());
    scrim.addEventListener('click', () => closeDrawer());

    openDrawer = { scrim, panel, release, onClose };
    return { body, close: closeDrawer };
  }

  function closeDrawer() {
    if (!openDrawer) return;
    const { scrim, panel, release, onClose } = openDrawer;
    openDrawer = null;
    release();
    scrim.remove();
    panel.remove();
    if (onClose) onClose();
  }

  // --- Confirmation dialog ------------------------------------------------

  /**
   * Resolves true or false. Destructive confirmations pass danger: true, which
   * colours the primary button and is the only place red is used for an action.
   */
  function confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const scrim = el('div', { class: 'scrim' });
      let release = () => {};

      const finish = (answer) => {
        release();
        scrim.remove();
        dialog.remove();
        resolve(answer);
      };

      const dialog = el(
        'div',
        { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', tabindex: '-1' },
        [
          el('h2', { text: title }),
          el('p', { text: message }),
          el('div', { class: 'dialog__actions' }, [
            el('button', {
              type: 'button',
              class: 'btn btn--ghost btn--small',
              text: cancelLabel,
              onClick: () => finish(false),
            }),
            el('button', {
              type: 'button',
              class: `btn btn--small ${danger ? 'btn--danger' : 'btn--primary'}`,
              text: confirmLabel,
              onClick: () => finish(true),
            }),
          ]),
        ],
      );

      document.body.append(scrim, dialog);
      scrim.addEventListener('click', () => finish(false));
      release = trapFocus(dialog, () => finish(false));
    });
  }

  /**
   * confirm(), plus one field. Resolves the trimmed value, or null if the
   * person backed out — so a caller can treat "cancelled" and "left it empty"
   * identically, which is what every caller wants.
   *
   * Pass `options` ([{value, label}]) for a select instead of a text input. Both
   * shapes live in one function because the surrounding furniture — scrim, focus
   * trap, Escape, Enter-to-submit, the two buttons — is the whole cost of a
   * dialog, and it is identical either way.
   *
   * Not window.prompt: that one is styled by the browser, cannot mask a
   * password, offers no select at all, and is blocked outright in some embedded
   * webviews.
   */
  function prompt({
    title,
    message,
    label,
    type = 'text',
    value = '',
    options = null,
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
  }) {
    return new Promise((resolve) => {
      const scrim = el('div', { class: 'scrim' });
      let release = () => {};

      const input = options
        ? el(
            'select',
            { id: 'cc-prompt-input' },
            options.map((option) =>
              el('option', {
                value: option.value,
                text: option.label,
                selected: option.value === value ? true : null,
              }),
            ),
          )
        : el('input', {
            id: 'cc-prompt-input',
            type,
            value,
            autocomplete: type === 'password' ? 'new-password' : 'off',
            required: true,
          });

      const finish = (answer) => {
        release();
        scrim.remove();
        dialog.remove();
        resolve(answer);
      };

      const submit = () => {
        const entered = input.value.trim();
        finish(entered || null);
      };

      const dialog = el(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' },
        [
          el('h2', { text: title }),
          message ? el('p', { text: message }) : null,
          el('div', { class: 'field' }, [
            el('label', { for: 'cc-prompt-input', text: label }),
            options ? input : el('span', { class: 'field__control field__control--inline' }, [input]),
          ]),
          el('div', { class: 'dialog__actions' }, [
            el('button', {
              type: 'button',
              class: 'btn btn--ghost btn--small',
              text: cancelLabel,
              onClick: () => finish(null),
            }),
            el('button', {
              type: 'button',
              class: 'btn btn--primary btn--small',
              text: confirmLabel,
              onClick: submit,
            }),
          ]),
        ],
      );

      // Enter submits, because a one-field dialog that needs a mouse to accept
      // it is an odd thing to hand somebody.
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });

      document.body.append(scrim, dialog);
      scrim.addEventListener('click', () => finish(null));
      release = trapFocus(dialog, () => finish(null));
      input.focus();
    });
  }

  // --- Loading and empty states -------------------------------------------

  function skeleton(container, { kind = 'text', count = 3 } = {}) {
    container.textContent = '';
    for (let i = 0; i < count; i += 1) {
      container.append(el('div', { class: `sk sk--${kind}` }));
    }
  }

  /**
   * What a panel shows when its data would not load. Distinct from `empty`,
   * which means "nothing here yet" — this means "we could not find out", and
   * the difference matters: one is the end of the story and the other has a
   * retry.
   */
  function failure(container, { title, message, detail, onRetry } = {}) {
    container.textContent = '';
    const node = el('div', { class: 'empty empty--error' }, [
      el('div', { class: 'empty__art', 'aria-hidden': 'true' }),
      el('h3', { text: title || 'That did not load' }),
      message ? el('p', { text: message }) : null,
    ]);
    node.style.setProperty('--empty-icon', "url('/assets/icons/alert.svg')");

    if (onRetry) {
      node.append(
        el('button', {
          type: 'button',
          class: 'btn btn--primary btn--small',
          text: 'Try again',
          onClick: onRetry,
        }),
      );
    }
    // The server's own words, when it gave any. Collapsed, because it is for
    // whoever is diagnosing rather than whoever is booking seats.
    if (detail) {
      node.append(
        el('details', { class: 'empty__detail' }, [
          el('summary', { text: 'Technical detail' }),
          el('pre', { text: detail }),
        ]),
      );
    }
    container.append(node);
  }

  function empty(container, { title, message, icon = 'info', action } = {}) {
    container.textContent = '';
    const node = el('div', { class: 'empty' }, [
      el('div', { class: 'empty__art', 'aria-hidden': 'true' }),
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null,
    ]);
    node.style.setProperty('--empty-icon', `url('/assets/icons/${icon}.svg')`);
    if (action) {
      node.append(
        el('button', {
          type: 'button',
          class: 'btn btn--primary btn--small',
          text: action.label,
          onClick: action.onClick,
        }),
      );
    }
    container.append(node);
  }

  // --- Charts -------------------------------------------------------------
  // Inline SVG built by hand. Only what these screens actually need: a line
  // chart with an area fill, grouped bars, and a horizontal ranking bar.

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  }

  const niceMax = (value) => {
    if (value <= 5) return 5;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / magnitude) * magnitude;
  };

  /**
   * Line chart over a date series.
   * `series` is [{ key, label, accent }] naming fields on each point.
   */
  function lineChart(container, points, series, { height = 240, formatX } = {}) {
    container.textContent = '';
    if (!points.length) {
      empty(container, { title: 'Nothing to chart yet', message: 'Activity will appear here as bookings come in.', icon: 'chart' });
      return;
    }

    const width = 800;
    const pad = { top: 16, right: 16, bottom: 28, left: 36 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const peak = Math.max(1, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0)));
    const max = niceMax(peak);
    const x = (i) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v) => pad.top + plotH - (v / max) * plotH;

    const root = svg('svg', {
      class: 'chart',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `${series.map((s) => s.label).join(' and ')} over ${points.length} days`,
    });

    // Grid and value axis.
    const grid = svg('g', { class: 'chart__grid' });
    const axis = svg('g', { class: 'chart__axis' });
    for (let step = 0; step <= 4; step += 1) {
      const value = (max / 4) * step;
      const yy = y(value);
      grid.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: yy, y2: yy }));
      axis.append(
        svg('text', { x: pad.left - 8, y: yy + 3, 'text-anchor': 'end' }, [
          document.createTextNode(String(Math.round(value))),
        ]),
      );
    }
    root.append(grid, axis);

    // At most six date labels, whatever the window length.
    const labelEvery = Math.max(1, Math.ceil(points.length / 6));
    const dates = svg('g', { class: 'chart__axis' });
    points.forEach((point, i) => {
      if (i % labelEvery !== 0 && i !== points.length - 1) return;
      dates.append(
        svg('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' }, [
          document.createTextNode(formatX ? formatX(point) : String(point.date).slice(5)),
        ]),
      );
    });
    root.append(dates);

    for (const line of series) {
      const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(Number(p[line.key]) || 0)}`).join(' ');
      const suffix = line.accent ? '--accent' : '';
      root.append(
        svg('path', {
          class: `chart__area chart__area${suffix}`,
          d: `${path} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`,
        }),
      );
      root.append(svg('path', { class: `chart__line chart__line${suffix}`, d: path }));
    }

    // One hover target per day, covering the full plot height so the tooltip is
    // reachable without pixel-hunting the line itself.
    const bandWidth = plotW / Math.max(1, points.length - 1 || 1);
    points.forEach((point, i) => {
      const group = svg('g');
      group.append(
        svg('rect', {
          class: 'chart__hit',
          x: x(i) - bandWidth / 2,
          y: pad.top,
          width: bandWidth,
          height: plotH,
          tabindex: '0',
          role: 'img',
          'aria-label': `${point.date}: ${series.map((s) => `${Number(point[s.key]) || 0} ${s.label}`).join(', ')}`,
        }),
      );

      const text = series.map((s) => `${s.label} ${Number(point[s.key]) || 0}`).join(' · ');
      const boxWidth = Math.max(80, text.length * 5.4 + 16);
      const boxX = Math.min(Math.max(x(i) - boxWidth / 2, 2), width - boxWidth - 2);
      group.append(
        svg('g', { class: 'chart__hover' }, [
          svg('rect', { x: boxX, y: pad.top + 4, width: boxWidth, height: 34, rx: 6 }),
          svg('text', { x: boxX + 8, y: pad.top + 19 }, [document.createTextNode(point.date)]),
          svg('text', { x: boxX + 8, y: pad.top + 32 }, [document.createTextNode(text)]),
        ]),
      );
      root.append(group);
    });

    for (const line of series) {
      points.forEach((point, i) => {
        if (points.length > 40 && i % 3 !== 0) return;
        root.append(
          svg('circle', {
            class: `chart__dot ${line.accent ? 'chart__dot--accent' : ''}`,
            cx: x(i),
            cy: y(Number(point[line.key]) || 0),
            r: 3,
          }),
        );
      });
    }

    container.append(root);
  }

  /** Horizontal ranking bars — used for concert performance and occupancy. */
  function rankChart(container, rows, { valueKey = 'value', labelKey = 'label', suffix = '', accent = false } = {}) {
    container.textContent = '';
    if (!rows.length) {
      empty(container, { title: 'Nothing to compare yet', message: 'Add a concert to see it here.', icon: 'chart' });
      return;
    }

    const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
    const list = el('div', { class: 'rank-list' });
    for (const row of rows) {
      const value = Number(row[valueKey]) || 0;
      const pct = Math.round((value / max) * 100);
      list.append(
        el('div', { class: 'rank' }, [
          el('div', { class: 'rank__top' }, [
            el('span', { class: 'rank__label', text: row[labelKey] }),
            el('strong', { class: 'rank__value', text: `${value}${suffix}` }),
          ]),
          el('div', { class: 'rank__rail' }, [
            (() => {
              const fill = el('i');
              fill.style.width = `${pct}%`;
              if (accent || row.accent) fill.dataset.accent = 'true';
              return fill;
            })(),
          ]),
        ]),
      );
    }
    container.append(list);
  }

  /** Stacked proportion bar — seat occupancy by status. */
  function stackChart(container, segments) {
    container.textContent = '';
    const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    if (!total) {
      empty(container, { title: 'No seats yet', message: 'Add seats to a concert to see occupancy.', icon: 'seat' });
      return;
    }

    const bar = el('div', { class: 'stack-bar' });
    const legend = el('ul', { class: 'stack-legend' });
    for (const segment of segments) {
      const value = Number(segment.value) || 0;
      if (value > 0) {
        const part = el('span', {
          class: 'stack-bar__part',
          'data-tone': segment.tone,
          title: `${segment.label}: ${value}`,
        });
        part.style.width = `${(value / total) * 100}%`;
        bar.append(part);
      }
      legend.append(
        el('li', {}, [
          el('i', { 'data-tone': segment.tone }),
          `${segment.label} `,
          el('strong', { text: String(value) }),
          el('span', { class: 'muted', text: ` · ${Math.round((value / total) * 100)}%` }),
        ]),
      );
    }
    container.append(bar, legend);
  }

  window.UI = {
    toast,
    toastSuccess,
    toastError,
    drawer,
    closeDrawer,
    confirm,
    prompt,
    skeleton,
    empty,
    failure,
    lineChart,
    rankChart,
    stackChart,
    svg,
    trapFocus,
  };
})();
