# Church Concert Seat Booking

Free seat reservation for church concerts. Several concerts can run at the same
time, each with its own seats, capacity and booking references. A verified adult
may book as many seats as they need while they last — a party booked together
shares one reference. Registration is 18+, verified over WhatsApp. No payment
gateway: there is nothing to pay.

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

### WhatsApp

Out of the box `WHATSAPP_DRIVER=mock` prints verification codes to the server
console, so you can click through the whole flow without an API account. Watch
the terminal for `[whatsapp:mock]`.

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
npm test               # 101 end-to-end checks (needs a scratch database)
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
                003_multi_concert.sql (several concerts, seats per person)
scripts/        migrate, seed-admin, seed-seats, syntax-check, tests
src/
  env.js        config loading and validation
  db.js         pool, transaction with retry and isolation
  lib/          helpers, zod schemas, audit log and settings
  middleware/   auth (sessions, RBAC), security (CSRF, rate limits, errors)
  services/     booking (the transaction), whatsapp, notifications
  routes/       auth, app, admin, webhook
public/         pages, css/app.css, js/, admin/, assets/ (SVG artwork)
docs/API.md     full endpoint reference
```

## Design

Blue on white. The page is a very pale blue (`#f5f8ff`), cards are white, and a
single saturated blue — `#2563eb`, with `#1d4ed8` for hover and headline accents
— carries every action: primary buttons, the seat you have chosen, live figures.
Nothing else competes, so the seat map is the busiest thing on any screen. Plus
Jakarta Sans sets headings and figures, Inter sets the reading copy, and IBM Plex
Mono is kept for booking references, because those are codes read aloud at a door.

Status colours are conventional so they need no legend to interpret: green for
confirmed and verified, amber for held or pending, red for cancelled and full.

Artwork lives in `public/assets/` — hand-drawn SVG, no external requests, which
suits the CSP that allows images from `'self'` and `data:` only. See
`public/assets/README.md` for what each file is and where it appears.

Three details worth knowing if you restyle it:

- **All colour is declared once,** in the `:root` block at the top of
  `public/css/app.css`. The SVGs in `public/assets/` are the exception: their
  colours are baked in and have to be edited alongside the tokens.
- **Printing strips the decoration.** The `@media print` block drops the
  masthead, artwork and buttons and prints the details black on white, so a
  confirmation costs one sheet and no colour ink.
- **A seat you hold is outlined in green with a tick, not just tinted.** Chosen
  seats are a solid blue fill; the tick survives greyscale printing and works for
  anyone who cannot separate green from blue.

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
