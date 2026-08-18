'use strict';

(function initAdminLogin() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy } = window.CC;

  const form = $('#admin-login-form');

  // Already signed in? Go straight through.
  api('/api/admin/me')
    .then(() => {
      window.location.href = '/admin/';
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
      window.location.href = '/admin/';
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });
})();
