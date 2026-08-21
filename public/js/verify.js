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

  // Either the sentence the register endpoint handed back, or a fallback built
  // from whatever the session knows.
  const hint = sessionStorage.getItem('cc_verify_hint');
  if (hint) {
    $('[data-verify-lede]').textContent =
      `${hint} You can also reply to the WhatsApp message and this page will catch up.`;
  } else if (session.user.whatsapp_masked) {
    $('[data-verify-lede]').textContent =
      `We sent the same code to your email and to ${session.user.whatsapp_masked} on WhatsApp. ` +
      'Enter it from whichever reaches you first.';
  }

  // --------------------------------------------------------------------------
  // The code field
  //
  // One real <input> under a row of boxes. The input keeps the id, the name and
  // autocomplete="one-time-code", so paste, the OS autofill and the form
  // serialiser all behave exactly as they did; the boxes are painted from its
  // value on every keystroke and never hold state of their own. If the script
  // fails to run, the input is still a plain usable text field.
  // --------------------------------------------------------------------------
  const codeLength = Math.min(Math.max(Number(session.otp_length) || 6, 4), 8);
  const otp = $('[data-otp]');
  const otpInput = $('#code');
  const boxWrap = $('[data-otp-boxes]');
  let lastLength = 0;

  otpInput.maxLength = codeLength;

  const boxes = Array.from({ length: codeLength }, () => {
    const box = document.createElement('span');
    box.className = 'otp__box';
    boxWrap.append(box);
    return box;
  });

  function paintCode() {
    const digits = otpInput.value.split('');
    const filled = digits.length;

    boxes.forEach((box, i) => {
      const ch = digits[i] || '';
      if (box.textContent !== ch) box.textContent = ch;
      box.classList.toggle('is-filled', Boolean(ch));
      box.classList.toggle('is-active', i === filled && document.activeElement === otpInput);
    });

    // Only the box that just gained a digit pops, so typing reads as one thing
    // landing rather than the whole row twitching.
    if (filled > lastLength) {
      const box = boxes[filled - 1];
      if (box) {
        box.classList.remove('is-landing');
        void box.offsetWidth; // restart the animation
        box.classList.add('is-landing');
      }
    }
    lastLength = filled;

    otp.classList.toggle('is-complete', filled === codeLength);
  }

  function shake() {
    otp.classList.remove('is-error');
    void otp.offsetWidth;
    otp.classList.add('is-error');
  }

  // Digits only, however the value arrived — typed, pasted or autofilled.
  otpInput.addEventListener('input', () => {
    const clean = otpInput.value.replace(/D/g, '').slice(0, codeLength);
    if (clean !== otpInput.value) otpInput.value = clean;
    paintCode();
    if (clean.length === codeLength) {
      // Give the last box its beat before the form takes over.
      setTimeout(() => form.requestSubmit(), 180);
    }
  });
  otpInput.addEventListener('focus', paintCode);
  otpInput.addEventListener('blur', paintCode);
  // The caret can only ever be at the end; clicking mid-string would otherwise
  // put the next digit somewhere the boxes do not show.
  const toEnd = () => {
    const n = otpInput.value.length;
    otpInput.setSelectionRange(n, n);
  };
  otpInput.addEventListener('click', toEnd);
  otpInput.addEventListener('keyup', toEnd);
  otp.addEventListener('click', () => otpInput.focus());

  paintCode();

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

    if (otpInput.value.length < codeLength) {
      shake();
      otpInput.focus();
      notify('[data-notice]', `Enter all ${codeLength} digits of the code.`, 'warn');
      return;
    }

    otp.classList.add('is-checking');
    busy(submit, true, 'Checking…');
    try {
      await api('/api/auth/whatsapp/verify', { method: 'POST', body: formValues(form) });
      otp.classList.remove('is-checking');
      otp.classList.add('is-verified');
      notify('[data-notice]', 'Number verified. Taking you to the seat plan…', 'success');
      setTimeout(goNext, 900);
    } catch (error) {
      otp.classList.remove('is-checking');
      busy(submit, false);
      shake();
      // A rejected code is cleared rather than left for editing: it is six
      // digits, and re-reading the message beats hunting for the wrong one.
      otpInput.value = '';
      lastLength = 0;
      paintCode();
      otpInput.focus();
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
