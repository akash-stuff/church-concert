'use strict';

(async function initForgot() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy, mountHeader } = window.CC;

  await mountHeader('/forgot-password.html');

  const form = $('#forgot-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    busy(submit, true, 'Sending…');
    try {
      const result = await api('/api/auth/forgot-password', { method: 'POST', body: formValues(form) });
      notify('[data-notice]', result.message, 'success');
      form.reset();
    } catch (error) {
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    } finally {
      busy(submit, false);
    }
  });
})();
