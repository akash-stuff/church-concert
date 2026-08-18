'use strict';

(async function initReset() {
  const { api, $, notify, clearNotice, showFieldErrors, busy, mountHeader } = window.CC;

  await mountHeader('/reset-password.html');

  const token = new URLSearchParams(window.location.search).get('token');
  const form = $('#reset-form');

  if (!token) {
    notify(
      '[data-notice]',
      'This link is missing its reset code. Open the link from your WhatsApp message, or request a new one.',
      'error',
    );
    form.querySelector('button[type="submit"]').disabled = true;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    const password = $('#password').value;
    if (password !== $('#confirm').value) {
      showFieldErrors(form, { confirm: 'Those passwords do not match.' });
      return;
    }

    busy(submit, true, 'Saving…');
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } });
      window.location.href = '/login.html?reset=done';
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });
})();
