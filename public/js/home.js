'use strict';

(async function initHome() {
  const { api, $, el, notify, formatDate, formatTime, mountHeader } = window.CC;

  const session = await mountHeader('/');

  let data;
  try {
    data = await api('/api/concert');
  } catch (error) {
    notify('[data-notice]', `${error.message} Refresh the page to try again.`, 'error');
    return;
  }

  // A 200 that is not the shape we expect — a proxy error page, a changed
  // endpoint — used to throw on `concert.name` and leave the hero blank with an
  // unhandled rejection in the console. Say so instead.
  const { concert, availability } = data || {};
  if (!concert) {
    notify(
      '[data-notice]',
      'We could not load the concert details just now. Refresh the page to try again.',
      'error',
    );
    return;
  }

  document.title = `${concert.name} — reserve a seat`;
  const mark = $('.masthead__name');
  if (mark) mark.textContent = concert.name;

  const heading = $('.hero h1');
  if (heading && concert.description) {
    heading.textContent = concert.name;
  }

  const lede = $('.hero__lede');
  if (lede && concert.description) lede.textContent = concert.description;

  const meta = $('[data-hero-meta]');
  meta.textContent = '';
  for (const item of [
    formatDate(concert.event_date),
    `${formatTime(concert.start_time)}${concert.end_time ? ` – ${formatTime(concert.end_time)}` : ''}`,
    concert.venue,
  ]) {
    meta.append(el('li', { text: item }));
  }

  $('[data-board-count]').textContent = availability.remaining_capacity;
  $('[data-board-total]').textContent = availability.max_capacity;

  if (availability.fully_booked) {
    $('[data-board]').classList.add('board--full');
    $('[data-board-count]').textContent = '0';
    $('.board__label').innerHTML = '<strong>Fully booked</strong>';
    notify(
      '[data-notice]',
      'Every seat for this concert has been taken. Registration stays open in case a seat is released.',
      'warn',
    );
  }

  const cta = $('[data-primary-cta]');
  if (session?.user) {
    const held = session.seat_count || 0;
    if (held > 0) {
      cta.textContent = held === 1 ? 'Your seat' : `Your ${held} seats`;
      cta.href = '/dashboard.html';
    } else if (!session.user.whatsapp_verified) {
      cta.textContent = 'Verify WhatsApp';
      cta.href = '/dashboard.html';
    } else {
      cta.textContent = 'Choose your seats';
      cta.href = '/seats.html';
    }
  } else if (data.registration === 'CLOSED') {
    cta.textContent = 'Registration closed';
    cta.setAttribute('aria-disabled', 'true');
    cta.classList.add('btn--ghost');
    cta.classList.remove('btn--primary');
    cta.removeAttribute('href');
  } else if (availability.fully_booked) {
    cta.textContent = 'Join without a seat';
    cta.href = '/register.html';
  }

  // --- Every concert on offer ----------------------------------------------
  // With several running at once the homepage cannot be about one event, so it
  // lists them all and the hero simply features whichever comes next.
  try {
    const { concerts } = await api('/api/concerts');
    const box = $('[data-concerts]');
    if (!box) return;

    if (concerts.length < 2) {
      box.hidden = true;
      return;
    }

    const heading = $('[data-concerts-heading]');
    if (heading) heading.hidden = false;
    box.textContent = '';

    for (const item of concerts) {
      const full = item.availability.fully_booked;
      const closed = item.booking === 'CLOSED';
      const taken = item.availability.booked_seats;
      const capacity = item.availability.max_capacity;
      const percent = capacity ? Math.min(100, Math.round((taken / capacity) * 100)) : 0;

      const card = el('article', {
        class: `concert-card${full ? ' concert-card--full' : ''}${closed ? ' concert-card--closed' : ''}`,
      });

      card.append(
        el('p', {
          class: 'concert-card__date',
          text: `${formatDate(item.event_date)} · ${formatTime(item.start_time)}`,
        }),
        el('h3', { text: item.name }),
        el('p', { class: 'concert-card__where', text: item.venue }),
      );

      if (item.description) {
        card.append(el('p', { class: 'concert-card__lede', text: item.description }));
      }

      card.append(
        el('div', { class: `gauge${full ? ' gauge--full' : ''}` },
          el('div', { class: 'gauge__fill', style: `width: ${percent}%` })),
      );

      const foot = el('div', { class: 'concert-card__foot' });
      foot.append(
        el('div', { class: 'concert-card__seats' }, [
          el('strong', { text: full ? 'Full' : String(item.availability.remaining_capacity) }),
          el('span', { text: full ? '' : ` of ${capacity} left` }),
        ]),
      );

      if (full) {
        foot.append(el('span', { class: 'pill pill--off', text: 'Fully booked' }));
      } else if (closed) {
        foot.append(el('span', { class: 'pill pill--neutral', text: 'Booking closed' }));
      } else {
        foot.append(
          el('a', {
            class: 'btn btn--primary btn--small',
            href: session?.user
              ? `/seats.html?concert_id=${item.id}`
              : `/register.html?concert_id=${item.id}`,
            text: session?.user ? 'Choose seats' : 'Register to book',
          }),
        );
      }

      card.append(foot);
      box.append(card);
    }
  } catch {
    // The hero above already carries the essentials, so a failure here is not
    // worth an error message.
  }
})();
