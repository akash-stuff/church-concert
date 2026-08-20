'use strict';

/**
 * QR codes for tickets.
 *
 * Two renderings, because the two places a ticket appears have different rules:
 *
 *   svg — for the printable ticket. Vector, so it stays sharp at whatever
 *         resolution the browser prints at. A raster QR at screen resolution
 *         prints soft, and a soft QR is a QR that will not scan.
 *   png — for email. Gmail and Outlook strip inline SVG, so the email version
 *         has to be a raster data URI. Nothing is fetched over the network:
 *         a remote image would be blocked by the CSP on the site and by most
 *         mail clients' image blocking on the way in.
 *
 * What the code contains is a check-in URL, not the bare reference. A steward
 * scanning it with any phone camera lands on the page that tells them whether
 * the ticket is good; a bare string would just show them text they would then
 * have to type in somewhere.
 */

const QRCode = require('qrcode');
const env = require('./../env');

/**
 * Error correction is deliberately Q (~25% recoverable) rather than the default
 * M. These get printed, folded, put in a coat pocket and handed over in a badly
 * lit porch — the extra redundancy costs a slightly denser code and buys a
 * scan that still works when the paper is creased.
 */
const LEVEL = 'Q';

/** The URL a scan should land on. */
function checkInUrl(reference) {
  return `${env.appUrl}/checkin.html?ref=${encodeURIComponent(reference)}`;
}

/** Inline SVG markup, sized in CSS by the caller. */
async function ticketSvg(reference) {
  try {
    return await QRCode.toString(checkInUrl(reference), {
      type: 'svg',
      errorCorrectionLevel: LEVEL,
      margin: 0,
      // The SVG has no intrinsic size so the ticket's CSS decides how big it is.
      color: { dark: '#16233dff', light: '#ffffffff' },
    });
  } catch (error) {
    console.error('[qr] could not render SVG:', error.message);
    return null;
  }
}

/** PNG data URI, for email. */
async function ticketPng(reference, { width = 320 } = {}) {
  try {
    return await QRCode.toDataURL(checkInUrl(reference), {
      errorCorrectionLevel: LEVEL,
      margin: 1,
      width,
      color: { dark: '#16233dff', light: '#ffffffff' },
    });
  } catch (error) {
    console.error('[qr] could not render PNG:', error.message);
    return null;
  }
}

module.exports = { checkInUrl, ticketSvg, ticketPng, LEVEL };
