'use strict';

/**
 * QR codes for tickets.
 *
 * Two renderings, because the two places a ticket appears have different rules:
 *
 *   svg — for the printable ticket. Vector, so it stays sharp at whatever
 *         resolution the browser prints at. A raster QR at screen resolution
 *         prints soft, and a soft QR is a QR that will not scan.
 *   png — for email, as raw bytes to be attached and referenced by Content-ID.
 *         Gmail and Outlook strip inline SVG, so mail needs a raster; it also
 *         has to be an attachment rather than a `data:` URI, because Gmail
 *         refuses to render those and the QR arrives as a broken box. A remote
 *         URL is no good either — most clients block third-party images until
 *         the reader asks, and a QR nobody can see is a QR nobody can scan.
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

/**
 * Inline SVG markup, sized in CSS by the caller.
 *
 * `dark` overrides the module colour. Hand bands use it: a band is printed in
 * violet or teal, and a code in the site's navy on a coloured strip has nowhere
 * near the contrast a phone camera needs. The caller passes the darkest ink in
 * its own palette instead.
 */
async function ticketSvg(reference, { dark = '#16233d' } = {}) {
  try {
    return await QRCode.toString(checkInUrl(reference), {
      type: 'svg',
      errorCorrectionLevel: LEVEL,
      margin: 0,
      // The SVG has no intrinsic size so the ticket's CSS decides how big it is.
      color: { dark: `${dark}ff`, light: '#ffffffff' },
    });
  } catch (error) {
    console.error('[qr] could not render SVG:', error.message);
    return null;
  }
}


/**
 * The same PNG as raw bytes, for attaching to an email.
 *
 * Gmail does not render `data:` image URIs in mail — it strips them — so the
 * data-URI version above shows as a broken image there. Mail has to carry the
 * picture as an attachment referenced by Content-ID instead. Kept alongside
 * There is deliberately no data-URI variant. One existed, it was used for
 * exactly this, and it is why confirmation emails arrived with a broken image.
 */
async function ticketPngBuffer(reference, { width = 320 } = {}) {
  try {
    return await QRCode.toBuffer(checkInUrl(reference), {
      type: 'png',
      errorCorrectionLevel: LEVEL,
      margin: 1,
      width,
      color: { dark: '#16233dff', light: '#ffffffff' },
    });
  } catch (error) {
    console.error('[qr] could not render PNG buffer:', error.message);
    return null;
  }
}

module.exports = { checkInUrl, ticketSvg, ticketPngBuffer, LEVEL };
