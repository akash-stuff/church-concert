/* The print button on a server-rendered confirmation, and the automatic print
   dialog when a page was opened with ?print=1.

   A separate file rather than an onclick attribute because the CSP allows
   scripts from 'self' only — an inline handler is dropped and the button would
   silently do nothing. */
'use strict';

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-print]')) window.print();
});

// The ticket route sets data-auto-print on this script tag when it was asked for
// a PDF rather than a preview. Waiting for `load` matters: printing before the
// banner artwork and the QR have decoded produces a page with holes in it.
if (document.currentScript?.hasAttribute('data-auto-print')) {
  window.addEventListener('load', () => {
    // A frame's grace after load, so layout has settled before the dialog
    // freezes the page.
    requestAnimationFrame(() => window.print());
  });
}
