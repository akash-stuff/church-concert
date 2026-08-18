'use strict';

(async function initVerify() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy, mountHeader, requireSession } =
    window.CC;

  const session = await mountHeader('/verify.html');
  if (!requireSession(session, '/verify.html')) return;

  if (session.user.whatsapp_verified) {
    window.location.href = session.booking ? '/dashboard.html' : '/seats.html';
    return;
  }

  const masked = sessionStorage.getItem('cc_verify_hint') || session.user.whatsapp_masked;
  if (masked) {
    $('[data-verify-lede]').textContent =
      `We sent a code to ${masked} on WhatsApp. Enter it below, or reply to the message and this page will catch up.`;
  }

  const form = $('#verify-form');
  const goNext = () => {
    sessionStorage.removeItem('cc_verify_hint');
    window.location.href = '/seats.html';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});
    const submit = form.querySelector('button[type="submit"]');

    busy(submit, true, 'Checking…');
    try {
      await api('/api/auth/whatsapp/verify', { method: 'POST', body: formValues(form) });
      notify('[data-notice]', 'Number verified. Taking you to the seat plan…', 'success');
      setTimeout(goNext, 900);
    } catch (error) {
      busy(submit, false);
      notify('[data-notice]', error.message, 'error');
      if (error.details) showFieldErrors(form, error.details);
    }
  });

  $('[data-resend]').addEventListener('click', async (event) => {
    clearNotice('[data-notice]');
    busy(event.currentTarget, true, 'Sending…');
    try {
      const result = await api('/api/auth/whatsapp/send', { method: 'POST' });
      if (result.already_verified) return goNext();
      notify('[data-notice]', result.message, result.sent ? 'success' : 'warn');
    } catch (error) {
      notify('[data-notice]', error.message, 'error');
    } finally {
      busy(event.currentTarget, false);
    }
    return undefined;
  });

  // If the person replies to the WhatsApp message instead of typing the code,
  // the webhook verifies them server-side. Poll so the page moves on by itself.
  const poll = setInterval(async () => {
    try {
      const state = await api('/api/me');
      if (state.user?.whatsapp_verified) {
        clearInterval(poll);
        notify('[data-notice]', 'Number verified from your reply. One moment…', 'success');
        setTimeout(goNext, 900);
      }
    } catch {
      /* ignore transient failures while polling */
    }
  }, 5000);

  setTimeout(() => clearInterval(poll), 10 * 60 * 1000);
})();
