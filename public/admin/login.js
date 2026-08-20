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
  function destination(admin) {
    const next = new URLSearchParams(window.location.search).get('next');
    // Door staff have no console — every panel of it would 403 — so their home
    // is the check-in screen. An explicit ?next= still wins: a steward who
    // scanned a ticket first came here to get back to that ticket.
    const home = admin?.role === 'STAFF' ? '/checkin.html' : '/admin/';
    if (!next) return home;
    try {
      const url = new URL(next, window.location.origin);
      if (url.origin !== window.location.origin) return home;
      return url.pathname + url.search + url.hash;
    } catch {
      return home;
    }
  }

  // Already signed in? Go straight through.
  api('/api/admin/me')
    .then(({ admin }) => {
      window.location.href = destination(admin);
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
      const { admin } = await api('/api/auth/admin/login', {
        method: 'POST',
        body: formValues(form),
      });
      window.location.href = destination(admin);
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });
})();
