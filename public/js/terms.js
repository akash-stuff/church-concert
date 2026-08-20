'use strict';

/* Nothing on this page needs data — the header nav is the only dynamic part,
 * and it differs for a signed-in attendee. */
(async function initTerms() {
  await window.CC.mountHeader('/terms.html');
})();
