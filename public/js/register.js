'use strict';

(async function initRegister() {
  const { api, $, notify, clearNotice, showFieldErrors, formValues, busy, mountHeader } = window.CC;

  await mountHeader('/register.html');

  const form = $('#register-form');
  const dob = $('#date_of_birth');
  const sameAsMobile = $('#same_as_mobile');
  const mobile = $('#mobile_number');
  const whatsapp = $('#whatsapp_number');

  // Nobody old enough to attend was born after today, and the 18-year mark is
  // the latest useful date, so cap the picker there as a courtesy. The real
  // check happens on the server.
  const today = new Date();
  const cutoff = new Date(
    Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate()),
  );
  dob.max = cutoff.toISOString().slice(0, 10);
  dob.min = '1910-01-01';

  sameAsMobile.addEventListener('change', () => {
    if (sameAsMobile.checked) {
      whatsapp.value = mobile.value;
      whatsapp.readOnly = true;
    } else {
      whatsapp.readOnly = false;
    }
  });
  mobile.addEventListener('input', () => {
    if (sameAsMobile.checked) whatsapp.value = mobile.value;
  });

  const ageFrom = (value) => {
    const born = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(born.getTime())) return NaN;
    const now = new Date();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const months = now.getUTCMonth() - born.getUTCMonth();
    if (months < 0 || (months === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1;
    return age;
  };

  dob.addEventListener('change', () => {
    const slot = $('[data-error-for="date_of_birth"]');
    const age = ageFrom(dob.value);
    if (dob.value && Number.isFinite(age) && age < 18) {
      slot.textContent = 'Registration is available only for participants aged 18 years or above.';
      dob.setAttribute('aria-invalid', 'true');
    } else {
      slot.textContent = '';
      dob.removeAttribute('aria-invalid');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearNotice('[data-notice]');
    showFieldErrors(form, {});

    const submit = form.querySelector('button[type="submit"]');
    const values = formValues(form);

    const age = ageFrom(values.date_of_birth);
    if (!values.date_of_birth || !Number.isFinite(age)) {
      showFieldErrors(form, { date_of_birth: 'Enter your date of birth.' });
      return;
    }
    if (age < 18) {
      notify(
        '[data-notice]',
        'Registration is available only for participants aged 18 years or above.',
        'error',
      );
      showFieldErrors(form, {
        date_of_birth: 'Registration is available only for participants aged 18 years or above.',
      });
      return;
    }

    busy(submit, true, 'Registering…');
    try {
      const result = await api('/api/auth/register', { method: 'POST', body: values });
      const masked = result.whatsapp?.masked_number || 'your WhatsApp number';
      sessionStorage.setItem('cc_verify_hint', masked);
      window.location.href = '/verify.html';
    } catch (error) {
      busy(submit, false);
      if (error.details) showFieldErrors(form, error.details);
      notify('[data-notice]', error.message, 'error');
    }
  });
})();
