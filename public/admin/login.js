'use strict';

(function initAdminLogin() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy } = window.CC;

  const form = $('#admin-login-form');

  /**
   * Where to go once signed in.
   *
   * A steward who scans a ticket before signing in gets sent here with the
   * ticket URL in ?next=, and should land back on that ticket rather than on
   * the dashboard. Only same-origin paths are honoured: taking the parameter at
   * face value would turn the sign-in page into an open redirect, which is
   * exactly the shape a phishing link wants.
   */
  function destination() {
    const next = new URLSearchParams(window.location.search).get('next');
    if (!next) return '/admin/';
    try {
      const url = new URL(next, window.location.origin);
      if (url.origin !== window.location.origin) return '/admin/';
      return url.pathname + url.search + url.hash;
    } catch {
      return '/admin/';
    }
  }

  // Already signed in? Go straight through.
  api('/api/admin/me')
    .then(() => {
      window.location.href = destination();
    })
    .catch(() => {
      /* not signed in, the expected case on this page */
    });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    busy(submit, true, 'Signing in…');
    try {
      await api('/api/auth/admin/login', { method: 'POST', body: formValues(form) });
      window.location.href = destination();
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });
})();
