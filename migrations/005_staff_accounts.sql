-- ---------------------------------------------------------------------------
-- 005: staff logins, so the console can create its own accounts.
--
-- Until now the only way to get an admin account was `npm run seed:admin` on
-- the server. That is fine for the first account and useless for the eighth: a
-- church has stewards who need to scan tickets on the door for one evening, and
-- nobody is going to SSH in to make them a login the afternoon before.
--
-- Two changes:
--
--   * A third role, STAFF. Deliberately not "just another ADMIN": a door
--     steward needs to answer one question — is this ticket good — and giving
--     them a login that can also cancel bookings, edit concerts, export the
--     attendee list and read audit logs is a great deal of authority to hand
--     out for one evening. STAFF is enforced in src/routes/admin.routes.js,
--     which allows the role only on check-in and the printable documents; the
--     enum here is what the routes match on.
--
--       SUPER_ADMIN  everything, including creating and deleting accounts
--       ADMIN        the whole console, but cannot manage other accounts
--       STAFF        door check-in, and printing a ticket or hand tags
--
--   * created_by_admin_id, so it is answerable later who let somebody in.
--     ON DELETE SET NULL rather than CASCADE: removing the super admin who
--     created a steward must not remove the steward, or an account tidy-up
--     would silently lock the door staff out mid-concert.
--
-- The ENUM is widened by adding STAFF at the end, so no existing row changes
-- value and the column's default ('ADMIN') is untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE admins
  MODIFY COLUMN role ENUM('SUPER_ADMIN','ADMIN','STAFF') NOT NULL DEFAULT 'ADMIN';

ALTER TABLE admins
  ADD COLUMN created_by_admin_id INT UNSIGNED NULL AFTER role,
  ADD CONSTRAINT fk_admins_created_by
    FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL;

-- The console lists accounts newest first and filters disabled ones out of the
-- default view; both are covered by this one index.
ALTER TABLE admins
  ADD KEY idx_admins_active_created (is_active, created_at);
