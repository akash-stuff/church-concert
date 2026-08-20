# Church Concert Seat Booking

Free seat reservation for church concerts. Several concerts can run at the same
time, each with its own seats, capacity and booking references. A verified adult
may book as many seats as they need while they last — a party booked together
shares one reference. Registration is 18+, verified by a code sent to both email
and WhatsApp. No payment gateway: there is nothing to pay.

Built on Node.js, Express, and your existing MySQL. The frontend is plain HTML,
CSS, and JavaScript — no build step, no bundler, nothing to compile.

---

## Before anything else: rotate your database password

The credentials for `13.126.91.61` were shared in plain text in a chat message.
Treat them as public:

1. Change the password for the `five2mysql` user.
2. Restrict port 3306 to your application server's IP. A MySQL port open to the
   internet gets found by scanners within hours.
3. Put the new password in `.env`, which is gitignored. It is never written to
   any file in this repository.

Nothing here ever connected to that server.

---

## Getting it running

Requires Node.js 20+ and MySQL 8.0+ (MariaDB 10.6+ also works).

```bash
npm install
cp .env.example .env
```

Edit `.env`. The two that must change:

```ini
DATABASE_URL=mysql://user:password@host:3306/your_database
JWT_SECRET=<64 random characters>
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then create the schema and your first admin:

```bash
npm run migrate      # creates tables, seeds two concerts with seats
npm run seed:admin   # prompts for a password; the first admin is SUPER_ADMIN
npm start
```

Open <http://localhost:3000>. The admin dashboard is at `/admin/login.html`.

Migrations only ever add to your database. They create tables prefixed for this
application and record what ran in `schema_migrations`, so `npm run migrate` is
safe to re-run and will not touch anything already there.

```bash
npm run migrate:status   # what has and has not been applied
```

### Email (Gmail)

Every attendee message goes out on **two channels**: email and WhatsApp. Email
also carries the thing WhatsApp does not — password-reset links.

Out of the box `EMAIL_DRIVER=mock` prints messages to the server console instead
of sending them. For real delivery through Gmail:

1. Switch on 2-Step Verification for the account:
   <https://myaccount.google.com/signinoptions/two-step-verification>
2. Create an App Password at <https://myaccount.google.com/apppasswords>
   (choose **Mail**). You get 16 characters; spaces are optional.
3. Put them in `.env`:

```ini
EMAIL_DRIVER=gmail
EMAIL_USER=concerts@yourchurch.org
EMAIL_PASSWORD=abcd efgh ijkl mnop
EMAIL_FROM=concerts@yourchurch.org
```

**The account password will not work.** Google removed plain-password SMTP in
2022; it is rejected with `535-5.7.8` however correct it looks. It must be an
App Password, and App Passwords are only offered once 2-Step Verification is on.

`EMAIL_FROM` has to be the authenticated account or a verified alias — Gmail
silently rewrites anything else, so a "no-reply@" address you have not verified
will not survive. Leave it blank and it defaults to `EMAIL_USER`.

Check it without guessing: **Settings → Email** in the console shows the live
connection state and has a *Send me a test email* button. It is worth using,
because a wrong App Password is otherwise silent — registration still succeeds,
reset links are still generated, and the only evidence is `FAILED` rows in the
notifications log that nobody is looking at.

**Sending limits.** A consumer `gmail.com` account is capped around 500
recipients a day, Google Workspace around 2,000. The event reminder sends one
message per attendee, so a large concert can hit that ceiling — send it in
batches, or point `EMAIL_DRIVER=smtp` at a transactional provider.

Any other SMTP server works too:

```ini
EMAIL_DRIVER=smtp
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=465
SMTP_SECURE=true
```

### WhatsApp

Out of the box `WHATSAPP_DRIVER=mock` prints verification codes to the server
console, so you can click through the whole flow without an API account. Watch
the terminal for `[auth:mock]`.

For real messages, set:

```ini
WHATSAPP_DRIVER=meta
WHATSAPP_API_URL=https://graph.facebook.com/v21.0
WHATSAPP_PHONE_NUMBER_ID=<from Meta>
WHATSAPP_ACCESS_TOKEN=<permanent system user token>
WHATSAPP_APP_SECRET=<for webhook signatures>
WHATSAPP_VERIFY_TOKEN=<any string you choose>
```

Point the webhook at `https://your-domain/api/webhooks/whatsapp` and use the
same `WHATSAPP_VERIFY_TOKEN` in Meta's console.

**Templates.** Meta only allows free-form text within 24 hours of someone
messaging you. A verification code sent to a stranger falls outside that, so
approved templates are required in production:

```ini
WHATSAPP_TEMPLATE_VERIFICATION=seat_verification_code
WHATSAPP_TEMPLATE_CONFIRMATION=seat_booking_confirmation
```

Leave them blank and the app sends plain text, which works in testing and for
people who have messaged you recently.

---

## Everyday tasks

```bash
npm run seed:seats -- --section "Balcony" --prefix B --from 1 --to 24
npm run check          # parse every JS file
npm run test:reset     # return a scratch database to its seeded state
npm test               # the end-to-end suite (needs a scratch database)
npm run test:stress    # 30 people fight over one seat, then over one party's seats
```

Both test scripts write real rows. Point `DATABASE_URL` at a scratch database
before running them, never production.

Concerts, capacity, sections, seats, and the age and verification policies are
all editable from the admin dashboard. Nothing about the layout is hard-coded —
`A01`–`B10` is just what the migration seeds.

**Running several concerts.** Add them under the Concerts tab. Each keeps its own
seat plan, capacity and reference prefix, so `CHC-2026-00001` and
`NYP-2026-00001` can both exist. A concert can be copied onto a new date with its
whole seat layout, which saves rebuilding a large plan for every event in a
season. The picker at the top of the admin dashboard scopes every panel below it.

**Seats per person.** Unlimited by default: capacity is the only limit. Set
*Seats per person* on a concert to cap it — 4 keeps a family to four seats, 1
restores the original one-seat-each behaviour.

**Exports.** The Export tab produces CSV for users and for bookings. The bookings
file is one row per seat, sorted by seat number, so it works as a door list
without further editing.

---

## Who gets told what, and how

| Message | Email | WhatsApp |
| --- | :---: | :---: |
| Verification code | ✓ | ✓ |
| Welcome on registration | ✓ | ✓ |
| Booking confirmation and ticket | ✓ | ✓ |
| Booking cancellation | ✓ | ✓ |
| Seat moved | ✓ | ✓ |
| Event reminder | ✓ | ✓ |
| **Password reset link** | ✓ | — |

Every send writes **one row per channel** to `notifications`, because each
channel fails on its own: a dead WhatsApp number should not make the email look
undelivered in the console, or the other way round. A send counts as successful
if *either* channel arrived, which is the question the caller is really asking —
could we reach this person at all?

**Password reset is email-only, on purpose.** A reset link is a bearer
credential: whoever opens it takes the account. Email is the address the account
is keyed on; a WhatsApp number can be recycled by a carrier or left signed in on
a shared phone. Sending it to both would widen the blast radius for nothing.

### What the verification code now proves

The same code goes to both channels, so entering it proves the person controls
**one of them** — not both, and the server cannot tell which. That matters
because `users.whatsapp_verified` is what gates booking, and its original
meaning was "we have proven we can reach this number".

In practice the risk is small, because the ticket now goes to email as well —
somebody who verified by email still receives everything they need. But if you
want the stricter guarantee back, the change is to issue **two different codes**,
one per channel, and set a separate flag depending on which is entered.

---

## Tickets, QR codes and the door

A confirmed booking produces a ticket at
`/api/bookings/mine/confirmation` (the attendee's own) or
`/api/admin/bookings/:reference/ticket` (staff, for anybody). Both render the
same document from `src/lib/ticket.js` — only the authorisation differs.

Add `?print=1` and the page opens the print dialog on load. That is what every
"Download ticket (PDF)" button points at: choose **Save as PDF** as the
destination and you have a PDF. There is no headless browser and no PDF writer
in this application, deliberately — a church booking site should not carry a
150 MB Chromium download to produce four sides of A4.

The ticket is laid out for A4, not for a screen. Three things follow from that
and are easy to undo by accident:

- **Artwork is in `<img>` tags, never CSS backgrounds.** Browsers do not print
  background images unless the person ticks "Background graphics", and a ticket
  that arrives at the printer with no branding is no good.
- **`print-color-adjust: exact`** is what keeps the navy header navy. Without
  it the header prints white and the gold rules disappear.
- **The QR is inline SVG.** Vector, so the printer resamples it rather than
  scaling screen pixels. A soft QR is a QR that will not scan.

### What the QR contains

A check-in URL — `{APP_URL}/checkin.html?ref=CHC-2026-00001` — not the bare
reference. A steward scanning it with any phone camera lands on the page that
tells them whether to admit; a bare string would just show them text they then
have to type in somewhere.

That page and its endpoint (`GET /api/admin/checkin`) are **behind
requireAdmin**, which is the point: a QR printed on paper that anyone could
photograph must not, on its own, reveal who is coming or what they hold. A
steward signs in once on their phone and is returned to the ticket they scanned;
a stranger scanning the same code gets the staff sign-in page and nothing else.

The check-in verdict answers the question a steward actually has:

| Verdict | Means |
| --- | --- |
| **Admit** | Live booking, and the concert is today |
| **Cancelled** | The booking was cancelled and the seats released |
| **Not for today** | Valid, but for a later date |
| **Past concert** | The concert has already happened |
| **Not found** | No booking has that reference |

Each carries a glyph as well as a colour, because a steward may be
colour-blind, or squinting at a dim phone in a porch.

Error correction is level **Q** (~25% recoverable) rather than the default M.
These get folded into coat pockets. The extra redundancy costs a slightly
denser code and buys a scan that still works on creased paper — verified by
decoding a code with a smudge over 22% of its middle.

### Where the artwork comes from

`assets/ticket-banner.svg` (the masthead strip) and `assets/ticket-crest.svg`
are hand-drawn vector, and the confirmation page uses the same banner so the
screen and the paper look like one document. Vector is not a compromise here —
for print it beats a photograph, staying sharp at 300dpi and beyond for about
3 KB.

If you want real photographs instead, the poster upload in
**Concerts → Edit → Poster** already accepts PNG, JPEG and WebP; drop images in
there and concert cards use them. The ticket banner is a bundled file, so
swapping it means replacing `assets/ticket-banner.svg`.

---

## The staff console

`/admin/` is a single page with a sidebar, eight panels and no router. Each
panel fetches its own data the first time it is opened and caches it until
something invalidates it, so moving between them does not re-query the server.
The hash keeps the current panel across a reload.

| Panel | What it is for |
| --- | --- |
| Overview | KPI row, day-by-day booking chart, upcoming concerts, recent bookings, quick actions |
| Concerts | Card and table views, search and filters, create/edit/duplicate/archive, poster chooser |
| Seat Management | The interactive auditorium: zoom, section filter, seat search, and an inspector for the selected seat |
| Bookings | Filterable table, and a details drawer with customer, concert, seat, ticket and timeline |
| Attendees | Everyone registered, with a drawer showing their contact details and booking history |
| Notifications | The staff feed, by category, with read state and an unread badge on the bell |
| Reports & Export | Booking trend, occupancy, per-concert performance, and CSV / Excel / PDF export |
| Settings | Branding, concert rules, email, WhatsApp, and your own password |

Three things about it are worth knowing before changing it:

- **Paginated queries must not bind `LIMIT ?`.** `db.query` runs
  `pool.execute()`, i.e. real prepared statements, and MySQL rejects
  placeholders in `LIMIT` there — every paginated endpoint 500s with
  `Incorrect arguments to mysqld_stmt_execute` while the unpaginated ones carry
  on working, which makes it look like a few specific screens are broken rather
  than one shared helper. Take the ready-made clause from `pageParams(req)` and
  interpolate it (`${limit}`); it is built from two clamped integers, so nothing
  a caller sends can reach the SQL.

- **Loaders must not bind event listeners directly.** A loader re-runs whenever
  its panel is invalidated, so a listener added inside one stacks up: after
  three reloads a single keypress in a search box fires three renders. Wrap any
  binding in the `once(key, fn)` helper.
- **There is no charting library.** `public/js/ui.js` builds line, ranking and
  proportion charts as inline SVG, because the CSP allows scripts from `'self'`
  only and a bar chart is not worth a bundle. Chart colours are set in CSS, not
  in the JS, so the palette stays in one file.

### On money, and what these screens deliberately do not show

This is a free-admission system. There is no price, payment or revenue column
anywhere in the schema, and the public site promises there is no payment step.
So the console reports **occupancy, capacity, cancellation rate and WhatsApp
delivery** where a commercial ticketing dashboard would report revenue. Nothing
on screen is a placeholder for a number that does not exist.

If ticketing ever does become paid, that is a migration adding price to
`sections` and amount/payment status to `bookings`, plus the booking service —
not a UI change.

### Notifications: two different things with similar names

- `notifications` is the **outbound delivery log** — WhatsApp and email sent to
  attendees, with a provider message id and a QUEUED/SENT/FAILED state.
- `admin_notifications` is the **console's own feed** — "New booking received",
  addressed to staff, read in a browser, with no channel and no delivery state.

They are separate tables on purpose. Folding them together would produce one
table where half the columns are always NULL depending on which kind of row it
is. `src/services/console-feed.js` writes the second kind; every call is
best-effort and swallows its own errors, because a feed entry failing must never
fail the booking that produced it.

### Concert posters

`concerts.poster_path` is always a path under `/assets`, never a URL — the CSP
allows images from `'self'` and `data:` only. A concert without one falls back
to bundled artwork chosen from its id, so it always draws the same picture.
Uploads (`POST /api/admin/concerts/:id/poster`) accept PNG, JPEG and WebP up to
2 MB, sent as a base64 data URI. **SVG uploads are refused on purpose**: an SVG
is a document that can carry script, and these files are served same-origin from
a page whose CSP trusts `'self'`.

---

## How the important part works

Two people tapping the same seat at the same moment is the whole problem. This
is handled in the database, because frontend checks cannot be trusted and
application-level checks lose races.

`bookings` has a stored generated column:

```sql
active_key TINYINT GENERATED ALWAYS AS
  (CASE WHEN status IN ('PENDING','CONFIRMED') THEN 1 ELSE NULL END) STORED
```

with a unique index over it:

- `(seat_id, active_key)` — **one live booking per seat**

MySQL ignores `NULL`s in unique indexes, so a cancelled booking keeps its row and
its reference for the record while freeing the seat.

A person may hold many seats, so there is no per-person index. Instead
`(booking_reference, seat_id)` is unique: a party shares one reference, and no
seat can appear twice under it.

The constraint cannot be bypassed by any code path, including an admin creating a
booking by hand.

On top of that, `createBooking` locks the concert row, then the user row, then
each seat row **in ascending id order** — always that order, so there is no lock
cycle to deadlock on even when two parties ask for overlapping sets — counts live
bookings for the capacity check, and inserts.

Multi-seat bookings are all-or-nothing. If one seat in a party has gone, nothing
is written: telling a family they got three of their four seats leaves them
starting over anyway. Transactions run at
`READ COMMITTED` rather than MySQL's default: under `REPEATABLE READ` the
capacity count would read a snapshot from the start of the transaction and let
too many people in. Deadlocks, if they still happen, are retried with backoff
inside `db.transaction`, so a caller gets "that seat has gone" rather than a
500.

Verified with 30 concurrent requests on one seat: exactly one wins, 29 get a
clear `SEAT_TAKEN`, no server errors, and the database shows no double booking.
Verified again with six parties each requesting four seats out of the same six,
in rotated orders: no server errors, and every winner got all four — never a
partial set.

Confirmation messages are sent **after** the transaction commits and failures
are logged rather than thrown. A WhatsApp outage can never roll back a seat
someone already holds.

---

## Project layout

```
migrations/     001_init.sql (schema), 002_defaults.sql (seed data),
                003_multi_concert.sql (several concerts, seats per person),
                004_admin_console.sql (concert posters, staff notification feed)
scripts/        migrate, seed-admin, seed-seats, syntax-check, tests
src/
  env.js        config loading and validation
  db.js         pool, transaction with retry and isolation
  lib/          helpers, zod schemas, audit log and settings,
                ticket.js (the printable confirmation, shared by two routes)
  middleware/   auth (sessions, RBAC), security (CSRF, rate limits, errors)
  services/     booking (the transaction), whatsapp, email (Gmail SMTP),
                notifications (fans out to both channels),
                console-feed (staff-facing notifications)
  routes/       auth, app, admin, webhook
public/
  css/app.css   one stylesheet, three layers — see Design below
  js/           core.js (shared helpers), ui.js (toasts, drawer, dialog,
                charts), one file per attendee page
  admin/        the staff console: index.html + admin.js, and login
  assets/       SVG artwork, icons/ (masked line icons), posters/
docs/API.md     full endpoint reference
```

## Design

Deep navy on soft neutrals, with warm gold as the counter-accent.

Navy (`#16233d`, ramped to `#0d1729`) does the structure: the console sidebar,
the stage on a seat plan, the fill of a booked seat. It is the colour the
application is *made of*, not a highlight. Gold (`#b58328`) is rationed to
things that are genuinely primary — the primary button, the selected state, the
one metric on a card that matters — and it is never the only signal for
anything: every gold state also carries a label, a glyph, or a weight change.
Surfaces run white → `#f4f6f9` with a faint navy cast, so a card reads as
lifted without needing a heavy shadow. Plus Jakarta Sans sets headings and
figures, Inter sets the reading copy, and IBM Plex Mono is kept for booking
references, because those are codes read aloud at a door.

Spacing is an 8px scale (`--space-1` … `--space-8`). Every margin, gap and pad
in the console comes from it, which is what keeps eight unrelated screens
feeling like one product.

Status colours are conventional so they need no legend to interpret: green for
confirmed and verified, amber for held or pending, red for cancelled and full.

Every form field carries a leading mark — a person for a name, a handset for a
phone, a padlock for a password — so a long registration form can be scanned
rather than read. The mark is a CSS mask over an SVG in `public/assets/icons/`,
which is why it can turn indigo on focus and red when the field is rejected
without a second file. The markup for one field is:

```html
<div class="field">
  <label for="email">Email address</label>
  <span class="field__control field__control--inline">
    <span class="field__icon" data-icon="mail" aria-hidden="true"></span>
    <input id="email" name="email" type="email" required />
  </span>
  <span class="field__error" data-error-for="email"></span>
</div>
```

`--inline` centres the mark; leave it off for a `textarea` so the mark sits on
the first line. Add `<span class="field__chevron">` after a `<select>` for the
custom arrow. `core.js` mounts the password reveal button itself, so any
`input[type=password]` inside a `.field__control` gets one for free.

Motion is used for arrival and feedback, not decoration: page furniture rises in
on load, the seat plan draws itself in, buttons take a sheen on hover and a
spinner while a request is in flight, and the chosen seat pulses. All of it is
switched off under `prefers-reduced-motion`, and nothing is animated that a
reader has to wait for in order to understand the page.

Artwork lives in `public/assets/` — hand-drawn SVG, no external requests, which
suits the CSP that allows images from `'self'` and `data:` only. See
`public/assets/README.md` for what each file is and where it appears.

Four details worth knowing if you restyle it:

- **The stylesheet is three layers,** in one file, in this order:
  1. the structural rules — layout, spacing, what an element *is*;
  2. `PREMIUM LAYER` — re-tunes the tokens and adds the finish for the
     attendee-facing site;
  3. `CONSOLE LAYER` — the staff console: shell, primitives, screens.

  Both later layers declare `:root`; the last one wins, so the `CONSOLE LAYER`
  block is the palette in effect everywhere, attendee pages included. That is
  deliberate — one identity, not two.
- **There are no `style=""` attributes anywhere in `public/`,** and there must
  not be: the CSP sets `style-src 'self'` with no `'unsafe-inline'`, so an
  inline style is silently dropped by the browser. Use a class — the small
  helpers (`.mt-md`, `.m-0`, `.text-sm`, `.form-narrow`, `.measure`) exist for
  exactly the one-off cases that would otherwise reach for one.
- **Printing strips the decoration.** The `@media print` block drops the
  masthead, artwork and buttons and prints the details black on white, so a
  confirmation costs one sheet and no colour ink.
- **A seat you hold is outlined in green with a tick, not just tinted.** Chosen
  seats are a solid indigo fill; the tick survives greyscale printing and works
  for anyone who cannot separate green from indigo. This is the one element the
  premium layer deliberately leaves alone.

## Security notes

Passwords use Argon2id where it compiles, falling back to bcrypt automatically
(the startup log says which). Sessions are JWTs in `httpOnly`, `SameSite=Strict`
cookies with a `token_version` that invalidates everything on a password change.
CSRF is a double-submit token. Every query is a prepared statement. Helmet sets
a strict CSP with no inline scripts. Admin actions are written to `audit_logs`
with IP and user agent.

Rate limits are held in process memory, so with more than one instance each keeps
its own counts — enforce them at the load balancer if you scale out. Raise
`RATE_LIMIT_AUTH_MAX` if a group will register from one shared connection;
verification codes are already limited per account rather than per IP for that
reason.

---

## Deployment

```bash
docker compose up --build          # app plus a throwaway MySQL for local work
docker compose exec app npm run migrate
docker compose exec app npm run seed:admin
```

In production you already have MySQL, so run the `app` service alone and point
`DATABASE_URL` at your server. Do not deploy the `db` service.

Without Docker: `NODE_ENV=production npm start` behind nginx or Caddy as a
reverse proxy, kept alive by systemd or pm2.

Checklist for going live:

- [ ] Database password rotated; port 3306 closed to the internet
- [ ] `JWT_SECRET` is 32+ random characters and not the example value
- [ ] `APP_URL` is your `https://` address, so cookies are marked `Secure`
- [ ] `NODE_ENV=production` (this makes missing config fatal rather than a warning)
- [ ] TLS terminated, and `TRUST_PROXY=1` set so client IPs are read from
      `X-Forwarded-For` — without it, rate limiting sees only the proxy
- [ ] `SEED_ADMIN_PASSWORD` removed from `.env` once the admin exists
- [ ] WhatsApp templates approved, webhook signature secret set
- [ ] Capacity and the seat layout match the actual room, for every concert
- [ ] Old concerts switched off rather than deleted, so their records survive
- [ ] Automated database backups
- [ ] One real end-to-end run: register, verify, book, check the WhatsApp message
      and the printed confirmation

`GET /api/health` reports database connectivity for your load balancer.
