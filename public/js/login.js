'use strict';

(async function initLogin() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy, mountHeader } = window.CC;

  const session = await mountHeader('/login.html');

  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (session?.user) {
    window.location.href = safeNext || '/dashboard.html';
    return;
  }

  if (params.get('reset') === 'done') {
    notify('[data-notice]', 'Password saved. Sign in with your new password.', 'success');
  }

  const form = $('#login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    busy(submit, true, 'Signing in…');
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: formValues(form) });
      if (!result.user.whatsapp_verified) {
        window.location.href = '/verify.html';
        return;
      }
      window.location.href = safeNext || '/dashboard.html';
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });
})();
