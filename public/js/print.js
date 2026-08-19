/* The print button on a server-rendered confirmation. A separate file rather
   than an onclick attribute because the CSP allows scripts from 'self' only. */
'use strict';

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-print]')) window.print();
});
