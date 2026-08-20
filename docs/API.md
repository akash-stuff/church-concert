# API reference

Base URL: `{APP_URL}/api`. Everything speaks JSON. All timestamps are UTC
ISO-8601 unless noted; `date_of_birth` and `event_date` are plain `YYYY-MM-DD`.

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [CSRF](#csrf)
- [Rate limits](#rate-limits)
- [Errors](#errors)
- [Public endpoints](#public-endpoints)
- [Account endpoints](#account-endpoints)
- [Booking endpoints](#booking-endpoints)
- [Admin endpoints](#admin-endpoints)
- [Webhooks](#webhooks)
- [Booking rules in one place](#booking-rules-in-one-place)

---

## Conventions

Success responses return the resource directly. Anything that creates something
returns `201`.

Two independent sessions exist. An attendee session cannot reach `/api/admin/*`
and an admin session is not an attendee: an admin who wants a seat registers an
ordinary account like anyone else.

| Session | Cookie | Set by |
| --- | --- | --- |
| Attendee | `cc_session` | `POST /auth/login`, `POST /auth/register` |
| Admin | `cc_admin_session` | `POST /auth/admin/login` |

Both cookies are `httpOnly`, `SameSite=Strict`, and `Secure` whenever
`APP_URL` is `https`. They carry a JWT holding the account id and a
`token_version`. Changing a password, resetting one, or disabling an account
increments `token_version`, which invalidates every session that account had
open.

## Authentication

Send the cookie. Browsers do this automatically; from a script use a cookie jar
(`curl -c jar -b jar`).

## CSRF

Every non-`GET` request needs a CSRF token. Read `cc_csrf` (a readable cookie,
set on any `GET /api/...`) and echo it in the `X-CSRF-Token` header. Requests
without a matching pair get `403 CSRF_FAILED`.

```bash
curl -c jar -s http://localhost:3000/api/csrf > /dev/null
TOKEN=$(grep cc_csrf jar | awk '{print $7}')
curl -b jar -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
     -d '{"identifier":"me@example.org","password":"..."}' \
     http://localhost:3000/api/auth/login
```

Webhooks are exempt; they authenticate by signature instead.

## Rate limits

Fixed windows, in memory, per process.

| Scope | Default | Key |
| --- | --- | --- |
| All `/api/*` | 300 / 15 min | IP |
| `/auth/*` | 40 / 15 min | IP |
| Verification codes | 12 / 15 min | account, falling back to IP |

Verification codes are limited per account on purpose: a congregation
registering on one church WiFi shares an IP and would otherwise lock each other
out. Guessing a code is bounded separately by `OTP_MAX_ATTEMPTS` per code.

Exceeding a limit returns `429 RATE_LIMITED` with a `Retry-After` header.

> Limits live in process memory, so with more than one instance each holds its
> own count. Behind several instances, enforce limits at the load balancer.

## Errors

```json
{
  "error": {
    "message": "That seat was just taken. Choose another.",
    "code": "SEAT_TAKEN",
    "details": { "field": "message" }
  }
}
```

`message` is written to be shown to a person as-is. `code` is for your logic.
`details` appears on validation failures, keyed by field name.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Field errors in `details` |
| `INVALID_CODE` | 400 | Wrong or expired verification code |
| `UNAUTHENTICATED` | 401 | No session, or it was invalidated |
| `INVALID_CREDENTIALS` | 401 | Wrong identifier or password |
| `CSRF_FAILED` | 403 | Missing or mismatched CSRF token |
| `UNDER_AGE` | 403 | Applicant is below the minimum age |
| `ACCOUNT_DISABLED` | 403 | Account switched off by an admin |
| `ACCOUNT_LOCKED` | 403 | Too many failed sign-ins |
| `WHATSAPP_NOT_VERIFIED` | 403 | Number not verified yet |
| `BOOKING_NOT_OPEN` / `BOOKING_CLOSED` | 403 | Outside the booking window |
| `NOT_FOUND` | 404 | No such resource |
| `SEAT_NOT_FOUND` | 404 | No such seat on this concert |
| `DUPLICATE_ACCOUNT` | 409 | A unique identifier is already registered |
| `ALREADY_BOOKED` | 409 | This account already holds a seat |
| `SEAT_TAKEN` | 409 | Someone else got there first |
| `SEAT_RESERVED` | 409 | Held by the church office |
| `SEAT_DISABLED` | 409 | Seat not in use |
| `FULLY_BOOKED` | 409 | Capacity reached |
| `CAPACITY_BELOW_BOOKED` | 409 | New capacity is under the number booked |
| `RATE_LIMITED` | 429 | Slow down |
| `INTERNAL_ERROR` | 500 | Logged server-side; details withheld |

---

## Public endpoints

### `GET /health`

No auth. For load balancers and the container healthcheck.

```json
{ "status": "ok", "database": "connected", "uptime_seconds": 421 }
```

### `GET /csrf`

Sets the `cc_csrf` cookie and returns `{ "csrf_token": "..." }`. Call it once
before your first write.

### `GET /concerts`

Every concert currently on offer, each with its own availability. This is what
the homepage lists. Inactive concerts are hidden from attendees.

```json
{
  "concerts": [
    {
      "id": 1,
      "name": "Night of Worship",
      "event_date": "2026-12-24",
      "venue": "Grace Community Church",
      "availability": { "max_capacity": 10, "remaining_capacity": 6, "fully_booked": false },
      "registration": "OPEN",
      "booking": "OPEN"
    }
  ]
}
```

### `GET /concert`

One concert and its live availability. `?concert_id=` picks it; without that,
the next concert that has not happened yet. Safe to poll.

```json
{
  "concert": {
    "id": 1,
    "name": "Night of Worship",
    "description": "An evening of carols and candlelight.",
    "event_date": "2026-12-24",
    "start_time": "18:30",
    "end_time": "20:30",
    "venue": "Grace Community Church",
    "address": "12 Chapel Lane, Springfield",
    "registration_open": true,
    "booking_open": true
  },
  "availability": {
    "max_capacity": 10,
    "booked_seats": 4,
    "remaining_capacity": 6,
    "bookable_seats": 16,
    "fully_booked": false
  }
}
```

`remaining_capacity` is the ceiling minus live bookings. `bookable_seats` is
how many seats are physically free. **The smaller of the two is what people can
actually book** — with 20 seats and a capacity of 10, booking stops at 10.

### `GET /seats`

The seat map for one concert, grouped by section. `?concert_id=` picks the
concert. Occupant names are never exposed here; `is_mine` marks seats the
signed-in caller already holds so the map can tick them rather than showing them
as anonymously taken.

```json
{
  "sections": [
    {
      "id": 1,
      "name": "Section A",
      "seats": [
        { "id": 1, "seat_number": "A01", "status": "AVAILABLE", "is_mine": false },
        { "id": 2, "seat_number": "A02", "status": "BOOKED", "is_mine": true }
      ]
    }
  ],
  "availability": { "...": "as above" }
}
```

Statuses: `AVAILABLE`, `BOOKED`, `RESERVED`, `DISABLED`. `SELECTED` exists in
the client while someone is choosing; it is never stored.

---

## Account endpoints

### `POST /auth/register`

Creates an account and sends a verification code. `201` on success.

| Field | Rules |
| --- | --- |
| `full_name` | 2–120 chars |
| `email` | Valid, unique, **immutable afterwards** |
| `mobile_number` | E.164, normalised |
| `whatsapp_number` | E.164, where the code is sent |
| `password` | 10+ chars, not a common password |
| `date_of_birth` | `YYYY-MM-DD`, must be 18+ today |
| `gender` | `MALE`, `FEMALE`, `OTHER`, `PREFER_NOT_TO_SAY` |
| `address` | 5–255 chars |
| `emergency_contact` | E.164 |
| `accept_terms` | Must be `true` |
| `confirm_age` | Must be `true` |

```json
{
  "user": { "id": 12, "full_name": "Mary Okonkwo", "whatsapp_verified": false },
  "whatsapp": { "sent": true, "expires_in_minutes": 10 },
  "message": "Account created. Check WhatsApp for your verification code."
}
```

Age is computed server-side from `date_of_birth`; `confirm_age` is a
declaration, not evidence. Someone who turns 18 tomorrow is refused today. The
refusal message is exactly:

> Registration is available only for participants aged 18 years or above.

Duplicates return `409 DUPLICATE_ACCOUNT` naming the clashing field. Which
fields must be unique is configurable (`duplicate_check_fields`).

### `POST /auth/whatsapp/send`

Requires a session. Sends a fresh code and invalidates any earlier one.

### `POST /auth/whatsapp/verify`

Body `{ "code": "123456" }`. Returns `{ "verified": true }`. After
`OTP_MAX_ATTEMPTS` wrong guesses the code is burned and a new one is needed.

### `POST /auth/login`

Body `{ "identifier": "...", "password": "..." }` — the identifier is an email,
mobile, or WhatsApp number. Wrong email and wrong password give the same
response, so the endpoint does not reveal who has an account. Eight consecutive
failures lock the account for 15 minutes.

### `POST /auth/logout`

Clears the session cookie. Always `200`.

### `POST /auth/forgot-password`

Body `{ "email": "..." }`. Always `200` with the same message whether or not the
address exists. The reset token is sent over WhatsApp and hashed at rest; it
expires after `RESET_TTL_MINUTES` and is single-use.

### `POST /auth/reset-password`

Body `{ "token": "...", "password": "..." }`. Invalidates every existing session
for that account.

### `GET /me`

The signed-in account plus its booking, if any.

### `PATCH /me`

Updates `full_name`, `mobile_number`, `whatsapp_number`, `address`,
`emergency_contact`, `gender`. Email and date of birth are immutable — age is
the basis of eligibility, so it cannot be edited after the fact. Changing
`whatsapp_number` clears verification and sends a new code; a booking already
held stays valid.

### `POST /me/change-password`

Body `{ "current_password": "...", "password": "..." }`. Signs out other
sessions and keeps the current one.

---

## Booking endpoints

### `POST /bookings`

Takes `guests`: one entry per seat, so a party of four is four named people
rather than one name repeated. See **Guest details** below.

```json
{ "concert_id": 1, "seat_ids": [7, 8, 9] }
```

Requires a session **and** a verified WhatsApp number. `concert_id` may be
omitted, in which case the next upcoming concert is used. `seat_id` (singular)
is still accepted for one seat.

**One reference covers the whole party.** Four seats booked together share
`CHC-2026-00001`, because that is what gets checked at the door. There is still
one database row per seat.

```json
{
  "booking": {
    "booking_reference": "CHC-2026-00001",
    "status": "CONFIRMED",
    "seat_count": 3,
    "seats": [{ "id": 7, "seat_number": "A07" }],
    "seat_numbers": ["A07", "A08", "A09"],
    "booking_fee": "FREE"
  },
  "concert": { "...": "..." },
  "message": "3 seats are yours: A07, A08, A09. A WhatsApp confirmation is on the way."
}
```

**All-or-nothing.** If any requested seat has gone, the whole request fails and
nothing is written — a family told "you got 3 of your 4 seats" has to start over
anyway. The error names the seat that went:

```json
{ "error": { "code": "SEAT_TAKEN", "message": "Seat A08 was just taken. Choose another.",
             "details": { "seat_number": "A08" } } }
```

Asking for more seats than remain returns `409 NOT_ENOUGH_CAPACITY` with
`remaining_capacity`, so the client can say how many are actually left rather
than a flat refusal. A concert with `max_seats_per_booking` set returns
`409 PER_PERSON_LIMIT`.

At most 25 seats per request; beyond that, `400 TOO_MANY_SEATS`.

### `GET /bookings/mine`

Everything the caller holds, grouped into parties by reference and ordered by
event date. `?concert_id=` narrows it to one concert.

```json
{
  "seat_count": 5,
  "bookings": [
    {
      "booking_reference": "CHC-2026-00001",
      "status": "CONFIRMED",
      "seat_count": 3,
      "concert": { "id": 1, "name": "Night of Worship", "event_date": "2026-12-24" },
      "seats": [
        { "booking_id": 12, "seat_id": 7, "seat_number": "A07", "section_name": "Section A" }
      ]
    }
  ]
}
```

### `DELETE /bookings/mine/:reference`

Cancels the whole party and frees its seats. Add `?seat_id=` to release **one**
seat and leave the rest standing, which is the common case when one person in a
group drops out.

```json
{
  "ok": true,
  "released_seats": ["A08"],
  "remaining_seats": ["A07", "A09"],
  "message": "Seat A08 released."
}
```

References are not reused. The person may book again while seats remain.

### `GET /bookings/mine/confirmation`

Returns a printable HTML page (not JSON) listing every seat in the party under
one reference, with name, WhatsApp number, and **Booking Fee: FREE**.
`?reference=` picks which party; without it, the next concert coming up.

---

## Admin endpoints

All require an admin session. `DELETE /admin/*`, settings changes and everything
under `/admin/staff` require `SUPER_ADMIN`. Every mutation is written to
`audit_logs` with the admin id, IP, and user agent.

There are three roles:

| Role | Reach |
| --- | --- |
| `SUPER_ADMIN` | Everything, including creating, re-roling and deleting logins |
| `ADMIN` | The whole console, but not `/admin/staff` |
| `STAFF` | `GET /admin/me`, `GET /admin/checkin`, `GET /admin/band-colours`, and the printable ticket and hand bands. Nothing else — every other admin path returns 403 `STAFF_SCOPE` |

`STAFF` is an allowlist rather than a denylist, so an endpoint added later is
closed to door staff until somebody opens it deliberately.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/admin/login` | Sign in (`email`, `password`) |
| `POST` | `/auth/admin/logout` | Sign out |
| `GET` | `/admin/me` | Current admin |
| `GET` | `/admin/overview` | Dashboard counts, recent bookings, failed messages |
| `GET` | `/admin/users` | List. `search`, `status`, `verified`, `booked`, `page`, `per_page` |
| `GET` | `/admin/users/:id` | One user with bookings and message history |
| `PATCH` | `/admin/users/:id` | `is_active`, `disabled_reason`, `whatsapp_verified` |
| `GET` | `/admin/bookings` | List. `search` (name, email, reference), `status`, `page` |
| `POST` | `/admin/bookings` | Book on someone's behalf (`user_id`, `seat_id`, `note`) |
| `PATCH` | `/admin/bookings/:id` | Move to another seat (`seat_id`) |
| `DELETE` | `/admin/bookings/:id` | Cancel (`reason`), releasing the seat |
| `GET` | `/admin/seats` | Full map including occupant names and holds |
| `POST` | `/admin/sections` | Add a section (`name`, `display_order`) |
| `PATCH` | `/admin/sections/:id` | Rename or reorder |
| `DELETE` | `/admin/sections/:id` | Delete a section and its seats |
| `POST` | `/admin/seats` | Add one seat |
| `POST` | `/admin/seats/bulk` | Generate a run (`section_id`, `prefix`, `from`, `to`) |
| `PATCH` | `/admin/seats/:id` | Rename, move section, or set `status` |
| `DELETE` | `/admin/seats/:id` | Delete an unbooked seat |
| `POST` | `/admin/seats/:id/reserve` | Hold a seat back (`note`) |
| `POST` | `/admin/seats/:id/release` | Release a hold, or cancel and free a booking |
| `GET` | `/admin/concerts` | Every concert, active or not, with availability |
| `POST` | `/admin/concerts` | Create one (`name`, `event_date`, `start_time`, `venue` required) |
| `POST` | `/admin/concerts/:id/duplicate` | Copy its seat layout onto a new date |
| `GET` | `/admin/concerts/:id` | One concert plus stats |
| `PATCH` | `/admin/concerts/:id` | Name, date, venue, `max_capacity`, `max_seats_per_booking`, `is_active`, windows, prefix |
| `DELETE` | `/admin/concerts/:id` | Delete, refused while seats are booked (super admin) |
| `GET` | `/admin/export/:report.csv` | A report as CSV. `report` is `bookings`, `users`, `concerts` or `occupancy` |
| `GET` | `/admin/export/:report.pdf` | The same report as a print-ready A4 landscape page |
| `GET` | `/admin/notifications` | Message log. `status`, `type`, `search` |
| `POST` | `/admin/notifications/remind` | Send the reminder to everyone holding a seat |
| `GET` | `/admin/audit-logs` | Activity trail |
| `GET` | `/admin/settings` | Platform settings |
| `PATCH` | `/admin/settings` | `minimum_age`, `require_whatsapp_verification`, `allow_user_self_cancel`, `duplicate_check_fields` |
| `GET` | `/admin/email/test` | Check the mail credentials without sending anything |
| `POST` | `/admin/email/test` | Send a real test message to the signed-in admin |
| `POST` | `/auth/admin/password` | Change your own password (`current_password`, `new_password`) |
| `GET` | `/admin/bookings/:reference/ticket` | The printable ticket for any party, as HTML. `?print=1` auto-opens the print dialog |
| `GET` | `/admin/bookings/:reference/band` | Printable hand bands, one wristband per seat. `?seat=` for one band, `?colour=` for the strip colour, `?print=1` to auto-print |
| `GET` | `/admin/band-colours` | The band palette, for the check-in screen's picker |
| `GET` | `/admin/staff` | Every console login, with role, state and who created it (super admin) |
| `POST` | `/admin/staff` | Create one (`full_name`, `email`, `password`, `role`: `ADMIN` or `STAFF`) |
| `PATCH` | `/admin/staff/:id` | `full_name`, `role`, `is_active`. A role or state change signs that account out everywhere |
| `POST` | `/admin/staff/:id/password` | Set somebody else's password (`new_password`), signing them out everywhere |
| `DELETE` | `/admin/staff/:id` | Remove a login. History in `audit_logs` survives it |
| `GET` | `/admin/checkin` | Verdict for a scanned ticket. `reference` required |
| `POST` | `/admin/concerts/:id/poster` | Upload a poster (`image` as a base64 data URI) |
| `DELETE` | `/admin/concerts/:id/poster` | Clear it and fall back to bundled artwork |
| `GET` | `/admin/console-notifications` | The staff feed. `category`, `unread`, `page`, `per_page` |
| `GET` | `/admin/console-notifications/unread-count` | Just the badge number |
| `PATCH` | `/admin/console-notifications/read-all` | Mark every notification read |
| `PATCH` | `/admin/console-notifications/:id` | Mark one read or unread (`read`) |
| `DELETE` | `/admin/console-notifications/:id` | Delete one |
| `GET` | `/admin/analytics/bookings` | Day-by-day series. `days` (7–365), `concert_id` |
| `GET` | `/admin/analytics/concerts` | One row per concert: capacity, seats by status, occupancy |
| `GET` | `/admin/analytics/summary` | Totals for a window. `days`, `concert_id` |

Every admin endpoint above is scoped by `?concert_id=`. Without it they fall
back to the next upcoming concert, which is what the dashboard opens on. Creating
sections, seats or manual bookings takes `concert_id` in the body.

### Delivery channels

Attendee messages go out on **email and WhatsApp together**, with one row per
channel in `notifications` so each can succeed or fail independently. The
exception is `PASSWORD_RESET`, which is email-only — see the README for why.

`POST /auth/register` and `POST /auth/whatsapp/send` therefore report per
channel:

```json
{
  "verification": {
    "sent": true,
    "expires_in_minutes": 10,
    "channels": {
      "whatsapp": { "attempted": true, "sent": true },
      "email":    { "attempted": true, "sent": false }
    },
    "masked_number": "+91 98••• ••210",
    "email": "ruth@example.org",
    "message": "We sent a verification code to your WhatsApp (+91 98••• ••210). Enter it to finish."
  }
}
```

`sent` at the top level is true if **either** channel arrived. The older
`whatsapp` block is still present on the register reply so an out-of-date front
end does not break, but new code should read `verification`.

`GET /auth/forgot-password` replies identically whether or not the address is
registered, so a mail failure is not observable to the caller — it lands in the
notifications log as `FAILED` for staff to find.

### Guest details

A booking is one row per seat, and each row names the person in that seat:
`guest_name`, `guest_email`, `guest_phone`, `guest_age`. Before this, every row
carried the account holder's details, so a family of four appeared on the door
list as one person four times over.

`POST /bookings` takes them as a `guests` array:

```json
{
  "concert_id": 7,
  "guests": [
    { "seat_id": 41, "name": "Ruth Adeyemi", "email": "ruth@example.com", "phone": "+919876543210" },
    { "seat_id": 42, "name": "Sam Adeyemi", "email": "sam@example.com",  "phone": "+919876543211", "age": 9 }
  ]
}
```

* `seat_id` is carried **on each guest**, not inferred from array position. The
  booking service sorts seats into ascending id order before locking them — that
  ordering is what keeps concurrent multi-seat requests deadlock-free — so
  anything paired up by index would attach people to the wrong seats.
* `guests` may replace `seat_ids` entirely. If both are sent they must agree:
  one guest per seat, no duplicates, or the request is a 400.
* `name`, `email` and `phone` are required per guest. `age` is optional and only
  really wanted for under-18s; a blank arrives as `null`, never as `0`.
* Staff booking on somebody's behalf (`POST /admin/bookings`) may omit `email`
  and `phone` — a walk-in often has neither — and anything missing falls back to
  the account holder's details.

`GET /admin/checkin` returns these per seat, plus `is_minor`, which is what the
door screen and the hand bands are rendered from.

### Tickets, hand bands and check-in

Three routes return **HTML**, not JSON, and all accept `?print=1` — which opens
the browser's print dialog on load, so "Save as PDF" produces the PDF:

| Route | Document | Who |
| --- | --- | --- |
| `GET /bookings/mine/confirmation` | A4 ticket for the whole party | The attendee |
| `GET /admin/bookings/:reference/ticket` | The same, for anybody | Staff |
| `GET /admin/bookings/:reference/band` | One wristband per seat | **Staff only** |

Hand bands are admin-only and reached from the check-in screen. That placement
is the point: a band says *this person has been checked in*, so it can only be
issued after a steward has verified the ticket. An attendee who could print
their own band at home would make the scan pointless. (They were briefly
attendee-facing "hand tags"; that was the wrong model.)

A band is a 220mm x 30mm strip — an adult wrist plus an overlap to stick down —
printed **landscape**, six to an A4 sheet, generated by `src/lib/hand-band.js`.
Everything that matters is repeated at both ends and mirrored, because half a
band faces away once it is on a wrist. `?seat=` prints one band, for the guest
who arrives late or whose band tore. `?colour=` picks from a named palette
(`violet` — the default — `purple`, `indigo`, `navy`, `teal`, `green`, `amber`,
`rose`); an unknown value falls back to violet rather than erroring. The QR is
rendered in the band's own dark ink so it still scans off a coloured strip.

Every printable page loads its CSS from a **file** under `/css` —
`ticket.css`, `band.css`, `report.css` — never an embedded `<style>` block. This
is not a style preference: the CSP is `style-src 'self'` with no
`'unsafe-inline'`, so an embedded block is dropped by the browser and the
document arrives with no layout at all. The same applies to `style="..."`
attributes, which is why `el()` in `public/js/core.js` applies styles through the
CSSOM instead.

The QR encodes `{APP_URL}/checkin.html?ref=<reference>`. It is per-party, not
per-seat, so every band on a booking carries the same code — which is correct: a
reference admits the whole party, and the seat number and guest name printed on
the band are what tell a steward who this is.

`GET /admin/checkin?reference=` is what that page calls. It is admin-only on
purpose: a QR on printed paper must not reveal an attendee's details to whoever
photographs it.

```json
{
  "found": true,
  "valid": true,
  "verdict": "ADMIT",
  "message": "Admit 3 people.",
  "reference": "CHC-2026-01042",
  "holder": "Ruth Adeyemi",
  "concert": { "name": "…", "event_date": "2026-12-24", "is_today": true },
  "seats": [{ "seat_number": "E04", "section_name": "General Nave", "status": "CONFIRMED" }],
  "live_seats": 3,
  "total_seats": 3
}
```

`verdict` is one of `ADMIT`, `CANCELLED`, `FUTURE`, `PAST` or `UNKNOWN`.
`valid` is true only for `ADMIT` — a ticket for next month is a real booking but
not a reason to open the door tonight. Every lookup is written to `audit_logs`
as `BOOKING_CHECKED_IN`, so there is a record of what was scanned and when.

### Analytics

Three read-only endpoints behind the console's charts and KPI cards.

`analytics/bookings` returns `{ days, series }` where each point is
`{ date, seats, bookings, cancellations }`. **Days with no activity are filled
in as zeros** rather than omitted — a line chart with missing days draws a
slope that is not there.

`analytics/concerts` returns one row per concert with `total_seats`,
`available_seats`, `reserved_seats`, `blocked_seats`, `booked_seats`, `parties`,
`cancellations` and a computed `occupancy` percentage.

`analytics/summary` returns `bookings`, `seats`, `capacity` and `people` blocks
for the window. The shape is identical with or without `concert_id`, so callers
do not branch on it.

None of these report revenue: admission is free and no price exists in the
schema. See "On money" in the README.

### Console notifications

Staff-facing, and **not** the same thing as `/admin/notifications`, which is the
outbound WhatsApp and email delivery log addressed to attendees. These are the
console's own feed — "New booking received" — written by
`src/services/console-feed.js` when a booking is created or cancelled, when a
concert crosses 80% or 95% capacity, or when a delivery fails.

The capacity warning is raised **once per threshold per concert**, not on every
booking; without that de-duplication the feed would fill with the same warning
exactly as the last seats went.

`GET /admin/console-notifications` also returns a `counts` block —
`{ by_category, unread, total }` — so the category chips and the header bell can
be drawn from one round trip.

### Poster upload

`POST /admin/concerts/:id/poster` takes `{ "image": "data:image/png;base64,…" }`.
This one endpoint gets a 3 MB body limit; everything else on the API is held to
100 KB.

Accepted types are **PNG, JPEG and WebP only**. SVG is refused deliberately: it
is a document that can carry script, and posters are served same-origin from
pages whose CSP trusts `'self'`. The stored filename is generated server-side
from the concert id and a random token, so nothing client-supplied reaches the
filesystem. Replacing a poster deletes the file it supersedes, but only ever
inside `assets/posters/uploads/`.

`PATCH /admin/concerts/:id` also accepts `poster_path` for choosing one of the
bundled illustrations. It is validated against
`^/assets/posters/[A-Za-z0-9._/-]+\.(svg|png|jpg|jpeg|webp)$` and rejects `..`.

### Exports

Both return `text/csv` as a download with a dated filename.

Every report is available as **CSV** and as **PDF**, and both come from one
shared query per report (`src/lib/exports.js`) — so a report's spreadsheet and
its printout always carry the same columns and the same rows. They used to be
built in two different places, which is why the booking and customer PDFs
printed nothing at all.

There is no Excel format. There never really was: the "Excel" button emitted the
same CSV with a byte-order mark, so offering it as a third choice implied a
fidelity it did not have. The BOM is still written, which is the part that made
Excel open accented names correctly.

`export/users.csv` — one row per account: contact details, age, account status,
plus how many seats they hold and their references. `?concert_id=` narrows the
seat columns to one concert.

`export/bookings.csv` — one row per **seat**, sorted seat-first so the file works
directly as a door list. Carries the attendee, WhatsApp number, party size, and
`Booking fee: FREE`. `?status=` accepts `live` (default), `all`, or a specific
status; `?concert_id=` narrows it.

Both files are UTF-8 with a BOM, so Excel opens accented names correctly. Any
field beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe: without it a
spreadsheet reads `+919812345001` as a formula, and a name containing
`=HYPERLINK(...)` would execute on open. Quoting alone does not prevent this.

Notes worth knowing:

- **A concert cannot be deleted while seats are booked** (`409
  CONCERT_HAS_BOOKINGS`). Cascading the delete would destroy those bookings
  silently and nobody would learn they had lost a seat. Set `is_active: false`
  to hide it from attendees instead.
- **Duplicating copies the layout, not the bookings.** Seats come across as
  `AVAILABLE`. This exists because rebuilding a 200-seat plan by hand for every
  event in a season is the kind of task people abandon halfway.
- **Capacity cannot be lowered below the number of live bookings**
  (`409 CAPACITY_BELOW_BOOKED`). Cancel bookings first; the system will not pick
  who loses a seat.
- **Raising capacity reopens booking** immediately.
- `minimum_age` is clamped to 18 and cannot go lower.
- Bulk seat generation zero-pads to two digits (`A01`) and skips seats that
  already exist, so it is safe to re-run.
- Releasing a booked seat cancels the booking and messages the person.

---

## Webhooks

### `GET /webhooks/whatsapp`

Meta's verification handshake. Echoes `hub.challenge` when
`hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`.

### `POST /webhooks/whatsapp`

Delivery receipts and inbound messages. The raw body is checked against
`X-Hub-Signature-256` using your app secret; a bad signature is rejected
without being processed. Delivery statuses update `notifications`. If someone
replies with their verification code, that verifies them — handy for people who
find copying a code awkward.

Both webhook routes skip CSRF (they are signature-authenticated) and must be
reachable over public HTTPS.

---

## Booking rules in one place

These are enforced in the database, not in the browser, and are covered by
`npm test` and `npm run test:stress`.

1. **One live booking per seat.** `uq_bookings_seat_active` over
   `(seat_id, active_key)`, where `active_key` is a stored generated column
   equal to `1` while status is `PENDING` or `CONFIRMED` and `NULL` otherwise.
   MySQL ignores `NULL`s in unique indexes, so cancelled bookings stay on
   record without blocking the seat. **This is the rule everything rests on and
   it has not changed.**
2. **A person may hold any number of seats**, at any number of concerts, up to
   each concert's capacity. The old one-booking-per-person index is gone;
   `uq_bookings_reference_seat` over `(booking_reference, seat_id)` replaces it,
   so a party shares one reference and no seat appears twice under it.
3. **An optional per-concert cap** lives in `concerts.max_seats_per_booking`.
   `0`, the default, means capacity is the only limit.
4. **Capacity.** Booking locks the concert row, counts live bookings, and
   refuses at the ceiling. Transactions run at `READ COMMITTED` so that count
   reflects what is committed now, not a snapshot from when the transaction
   began.
5. **Seats are locked in ascending id order.** Two parties asking for
   overlapping sets in different orders would otherwise deadlock.
6. **References are numbered per concert.** Two concerts running side by side
   each start at `00001` under their own prefix.
7. **Age.** Computed from `date_of_birth` on the server at registration.
8. **Verification.** `require_whatsapp_verification` gates booking, not
   registration.

Concurrency behaviour, measured: with 30 simultaneous requests for one seat,
exactly one succeeds and the other 29 receive `SEAT_TAKEN`. With six parties each
requesting four seats out of the same six, in rotated orders, no request returns
a server error and every winner gets all four of its seats — never a partial set.
Deadlocks are retried with backoff inside `db.transaction`, so callers never see
one.
