'use strict';

/**
 * Reports, in the two formats the church actually uses: CSV and PDF.
 *
 * The important property here is that a report's CSV and its PDF are the *same
 * report*. Each definition below owns one query and one column list, and both
 * formats are rendered from that single result — so a PDF can never quietly
 * carry fewer columns than the spreadsheet, which is what happens when the two
 * are built in different places. (It is what used to happen: the PDF path was
 * hard-coded to concert columns and printed nothing at all for bookings.)
 *
 * Excel is deliberately not a format. It never was one — the "Excel" button
 * emitted the same CSV with a byte-order mark — so offering it as a third
 * choice implied a fidelity that did not exist. The CSV written here still
 * carries the BOM, so Excel opens it with accented names intact; that is the
 * part that mattered.
 *
 * The PDF is the browser's own print-to-PDF, driven by a server-rendered A4
 * landscape page. No PDF writer is shipped for four tables, and "Save as PDF"
 * in the print dialog is a thing everybody already knows how to do.
 */

const db = require('../db');
const env = require('../env');
const bookingService = require('../services/booking');
const { esc } = require('./ticket');

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV field.
 *
 * Fields are always quoted and inner quotes doubled, per RFC 4180, so a comma
 * in an address or a quote in a name cannot shift the columns.
 *
 * The leading apostrophe on anything starting with = + - @ is deliberate:
 * without it, Excel and Sheets treat the cell as a formula. A phone number
 * beginning "+91..." is the common case, and a field like `=HYPERLINK(...)` in
 * a name would otherwise execute on open. This is CSV injection, and quoting
 * alone does not prevent it.
 */
const csvCell = (value) => {
  if (value === null || value === undefined) return '""';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';

/** Send a CSV as a download. */
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // A BOM so Excel opens UTF-8 names correctly instead of mangling accents.
  res.write('﻿');
  res.write(csvRow(header));
  for (const row of rows) res.write(csvRow(row));
  res.end();
}

// ---------------------------------------------------------------------------
// PDF (a print-ready page; the browser makes the PDF)
// ---------------------------------------------------------------------------

const slug = (text) =>
  String(text || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

const today = () => new Date().toISOString().slice(0, 10);

/** Columns that read better right-aligned and tabular. */
const NUMERIC = new Set([
  'Party size', 'Age', 'Capacity', 'Seats laid out', 'Booked', 'Available',
  'Held', 'Blocked', 'Parties', 'Cancellations', 'Occupancy %', 'Seats held',
  'User ID',
]);

/**
 * The printable report.
 *
 * Styling comes from /css/report.css rather than a <style> block, for the same
 * reason as the ticket: the CSP is style-src 'self' with no 'unsafe-inline', so
 * an embedded block is dropped and the page prints unstyled.
 */
function renderReportDocument({ title, subtitle, header, rows, landscape = true }) {
  const alignment = header.map((label) => (NUMERIC.has(label) ? ' class="num"' : ''));

  const body = rows.length
    ? rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, i) => {
                const value = cell instanceof Date ? cell.toISOString().slice(0, 16).replace('T', ' ') : cell;
                return `<td${alignment[i]}>${esc(value ?? '')}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('\n')
    : `<tr><td class="empty" colspan="${header.length}">Nothing to report for this selection.</td></tr>`;

  return `<!doctype html>
<html lang="en" data-orientation="${landscape ? 'landscape' : 'portrait'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/report.css">
</head>
<body>

<header class="rpt-head">
  <div>
    <p class="rpt-org">${esc(env.appName)}</p>
    <h1 class="rpt-title">${esc(title)}</h1>
    <p class="rpt-sub">${esc(subtitle)}</p>
  </div>
  <div class="rpt-count">
    <b>${rows.length}</b>
    <span>${rows.length === 1 ? 'row' : 'rows'}</span>
  </div>
</header>

<table class="rpt-table">
  <thead>
    <tr>${header.map((label, i) => `<th${alignment[i]}>${esc(label)}</th>`).join('')}</tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>

<footer class="rpt-foot">
  <span>${esc(env.appName)} &middot; generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</span>
  <span>Admission is free &mdash; no payment is ever collected</span>
</footer>

<div class="actions no-print">
  <button class="btn btn--primary" type="button" data-print>Save as PDF</button>
  <span class="actions__hint">
    Choose &ldquo;Save as PDF&rdquo; as the destination. Landscape and background
    graphics are already set.
  </span>
</div>

<script src="/js/print.js"></script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// The reports themselves
// ---------------------------------------------------------------------------

const yesNo = (value) => (value ? 'Yes' : 'No');

/**
 * Bookings, one row per seat, so the file can be sorted by seat number and used
 * as a door list.
 *
 * Every seat now names its own guest (migration 006), which is the whole point
 * of this report: "Ruth Adeyemi x4" told a steward nothing. Both the guest's
 * details and the booking account's are included, because they answer different
 * questions — who is in this chair, and who to ring about the booking.
 */
async function bookingsReport(req) {
  const where = [];
  const params = [];

  if (req.query.concert_id) {
    where.push('b.concert_id = ?');
    params.push(Number(req.query.concert_id));
  }

  const status = String(req.query.status || 'live').toLowerCase();
  if (status === 'live') {
    where.push("b.status IN ('PENDING','CONFIRMED')");
  } else if (status !== 'all') {
    where.push('b.status = ?');
    params.push(status.toUpperCase());
  }

  const rows = await db.query(
    `SELECT b.booking_reference, b.status, b.source, b.created_at, b.confirmed_at,
            b.cancelled_at, b.cancelled_by, b.cancel_reason, b.note,
            b.guest_name, b.guest_email, b.guest_phone, b.guest_age,
            s.seat_number, sec.name AS section_name,
            c.name AS concert_name, c.event_date, c.start_time, c.venue,
            u.id AS user_id, u.full_name, u.email, u.mobile_number,
            u.whatsapp_number, u.whatsapp_verified, u.emergency_contact,
            a.full_name AS booked_by_admin,
            (SELECT COUNT(*) FROM bookings x
              WHERE x.booking_reference = b.booking_reference
                AND x.status IN ('PENDING','CONFIRMED')) AS party_size
       FROM bookings b
       JOIN seats s ON s.id = b.seat_id
       JOIN sections sec ON sec.id = s.section_id
       JOIN concerts c ON c.id = b.concert_id
       JOIN users u ON u.id = b.user_id
       LEFT JOIN admins a ON a.id = b.created_by_admin_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.event_date ASC, s.display_order ASC, s.seat_number ASC`,
    params,
  );

  const label = req.query.concert_id
    ? slug((await bookingService.getConcert(Number(req.query.concert_id))).name)
    : 'all-concerts';

  return {
    title: 'Booking report',
    subtitle: `One row per seat &middot; ${status} bookings &middot; ${label.replace(/-/g, ' ')}`,
    filename: `bookings-${label}-${today()}`,
    header: [
      'Seat', 'Section', 'Booking reference', 'Party size',
      'Guest', 'Guest email', 'Guest phone', 'Age',
      'Booked by', 'Account email', 'Account mobile', 'Account WhatsApp',
      'WhatsApp verified', 'Emergency contact',
      'Concert', 'Event date', 'Start time', 'Venue', 'Status', 'Booking fee',
      'Booked', 'Confirmed', 'Source', 'Booked by admin',
      'Cancelled', 'Cancelled by', 'Cancel reason', 'Note',
    ],
    rows: rows.map((r) => [
      r.seat_number,
      r.section_name,
      r.booking_reference,
      Number(r.party_size),
      r.guest_name || r.full_name,
      r.guest_email || r.email,
      r.guest_phone || r.mobile_number,
      r.guest_age ?? '',
      r.full_name,
      r.email,
      r.mobile_number,
      r.whatsapp_number,
      yesNo(r.whatsapp_verified),
      r.emergency_contact,
      r.concert_name,
      r.event_date,
      r.start_time,
      r.venue,
      r.status,
      'FREE',
      r.created_at,
      r.confirmed_at,
      r.source,
      r.booked_by_admin,
      r.cancelled_at,
      r.cancelled_by,
      r.cancel_reason,
      r.note,
    ]),
    audit: { action: 'EXPORT_BOOKINGS', entityType: 'BOOKING', rows: rows.length },
  };
}

/** Every registered account, and what it holds. */
async function usersReport(req) {
  const concertId = req.query.concert_id ? Number(req.query.concert_id) : null;
  const params = [];
  let seatJoin = '';

  if (concertId) {
    seatJoin = 'AND b.concert_id = ?';
    params.push(concertId);
  }

  const users = await db.query(
    `SELECT u.id, u.full_name, u.email, u.mobile_number, u.whatsapp_number,
            u.whatsapp_verified, u.date_of_birth, u.gender, u.address,
            u.emergency_contact, u.is_active, u.disabled_reason,
            u.terms_accepted_at, u.created_at, u.last_login_at,
            COUNT(b.id) AS seats_held,
            GROUP_CONCAT(DISTINCT s.seat_number ORDER BY s.seat_number SEPARATOR ' ') AS seat_numbers,
            GROUP_CONCAT(DISTINCT b.booking_reference ORDER BY b.booking_reference SEPARATOR ' ') AS refs,
            GROUP_CONCAT(DISTINCT b.guest_name ORDER BY b.guest_name SEPARATOR '; ') AS guests
       FROM users u
       LEFT JOIN bookings b
              ON b.user_id = u.id AND b.status IN ('PENDING','CONFIRMED') ${seatJoin}
       LEFT JOIN seats s ON s.id = b.seat_id
      GROUP BY u.id
      ORDER BY u.id ASC`,
    params,
  );

  const label = concertId ? slug((await bookingService.getConcert(concertId)).name) : 'all';

  return {
    title: 'Customer report',
    subtitle: `Registered attendees and what they hold &middot; ${label.replace(/-/g, ' ')}`,
    filename: `users-${label}-${today()}`,
    header: [
      'User ID', 'Full name', 'Email', 'Mobile', 'WhatsApp', 'WhatsApp verified',
      'Date of birth', 'Gender', 'Address', 'Emergency contact',
      'Account status', 'Disabled reason', 'Seats held', 'Seat numbers',
      'Guests named', 'Booking references', 'Terms accepted', 'Registered',
      'Last sign-in',
    ],
    rows: users.map((u) => [
      u.id,
      u.full_name,
      u.email,
      u.mobile_number,
      u.whatsapp_number,
      yesNo(u.whatsapp_verified),
      u.date_of_birth,
      u.gender,
      u.address,
      u.emergency_contact,
      u.is_active ? 'Active' : 'Disabled',
      u.disabled_reason,
      Number(u.seats_held),
      u.seat_numbers,
      u.guests,
      u.refs,
      u.terms_accepted_at,
      u.created_at,
      u.last_login_at,
    ]),
    audit: { action: 'EXPORT_USERS', entityType: 'USER', rows: users.length },
  };
}

/** One row per concert: capacity, seats by status, occupancy. */
async function concertsReport() {
  const rows = await db.query(
    `SELECT c.id, c.name, c.event_date, c.start_time, c.venue, c.max_capacity, c.is_active,
            (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id) AS total_seats,
            (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'AVAILABLE') AS available_seats,
            (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'RESERVED') AS reserved_seats,
            (SELECT COUNT(*) FROM seats s WHERE s.concert_id = c.id AND s.status = 'DISABLED') AS blocked_seats,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.concert_id = c.id AND b.status IN ${bookingService.ACTIVE}) AS booked_seats,
            (SELECT COUNT(DISTINCT b.booking_reference) FROM bookings b
              WHERE b.concert_id = c.id AND b.status IN ${bookingService.ACTIVE}) AS parties,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.concert_id = c.id AND b.status = 'CANCELLED') AS cancellations
       FROM concerts c
      ORDER BY c.event_date DESC`,
  );

  return {
    title: 'Concert report',
    subtitle: 'Every concert with its capacity, seats laid out and occupancy',
    filename: `concerts-${today()}`,
    header: [
      'Concert', 'Date', 'Start time', 'Venue', 'Active', 'Capacity',
      'Seats laid out', 'Booked', 'Available', 'Held', 'Blocked',
      'Parties', 'Cancellations', 'Occupancy %',
    ],
    rows: rows.map((r) => {
      const capacity = Number(r.max_capacity) || 0;
      const booked = Number(r.booked_seats) || 0;
      return [
        r.name,
        String(r.event_date).slice(0, 10),
        r.start_time,
        r.venue,
        yesNo(r.is_active),
        capacity,
        Number(r.total_seats),
        booked,
        Number(r.available_seats),
        Number(r.reserved_seats),
        Number(r.blocked_seats),
        Number(r.parties),
        Number(r.cancellations),
        capacity ? Math.round((booked / capacity) * 100) : 0,
      ];
    }),
    audit: { action: 'EXPORT_CONCERTS', entityType: 'CONCERT', rows: rows.length },
  };
}

/**
 * Seat occupancy, per section rather than per concert.
 *
 * The concert report already gives whole-concert totals; what this adds is
 * which part of the building is filling up, which is the question behind
 * "should we open the gallery".
 */
async function occupancyReport(req) {
  const params = [];
  let filter = '';
  if (req.query.concert_id) {
    filter = 'WHERE c.id = ?';
    params.push(Number(req.query.concert_id));
  }

  const rows = await db.query(
    `SELECT c.name AS concert_name, c.event_date, sec.name AS section_name,
            COUNT(s.id) AS total_seats,
            SUM(s.status = 'AVAILABLE') AS available_seats,
            SUM(s.status = 'RESERVED') AS reserved_seats,
            SUM(s.status = 'DISABLED') AS blocked_seats,
            SUM(s.status = 'BOOKED') AS booked_seats
       FROM sections sec
       JOIN concerts c ON c.id = sec.concert_id
       LEFT JOIN seats s ON s.section_id = sec.id
      ${filter}
      GROUP BY sec.id
      ORDER BY c.event_date DESC, sec.display_order ASC, sec.name ASC`,
    params,
  );

  return {
    title: 'Seat occupancy report',
    subtitle: 'Seat counts by status, per section',
    filename: `occupancy-${today()}`,
    header: [
      'Concert', 'Date', 'Section', 'Seats laid out', 'Booked', 'Available',
      'Held', 'Blocked', 'Occupancy %',
    ],
    rows: rows.map((r) => {
      const total = Number(r.total_seats) || 0;
      const booked = Number(r.booked_seats) || 0;
      return [
        r.concert_name,
        String(r.event_date).slice(0, 10),
        r.section_name,
        total,
        booked,
        Number(r.available_seats),
        Number(r.reserved_seats),
        Number(r.blocked_seats),
        total ? Math.round((booked / total) * 100) : 0,
      ];
    }),
    audit: { action: 'EXPORT_OCCUPANCY', entityType: 'SECTION', rows: rows.length },
  };
}

const REPORTS = {
  bookings: bookingsReport,
  users: usersReport,
  concerts: concertsReport,
  occupancy: occupancyReport,
};

module.exports = { REPORTS, sendCsv, csvCell, csvRow, renderReportDocument, slug, today };
