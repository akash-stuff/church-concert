-- ---------------------------------------------------------------------------
-- 006: who is actually sitting in each seat.
--
-- Until now a booking knew only the account that made it. That is fine for one
-- person booking one seat and wrong for the common case: somebody books four
-- seats for their family, and the church has one name, one email and one phone
-- number for four people who will walk through the door separately. The door
-- list said "Ruth Adeyemi x4", which is no use to a steward holding it.
--
-- The columns go on `bookings` rather than into a new `guests` table because
-- bookings is already one row per seat — the grain is exactly right, so a
-- separate table would be a 1:1 join bought for nothing.
--
--   guest_name   Who sits here. Required for new bookings; see the backfill.
--   guest_email  Their own address, or the booker's if they share one.
--   guest_phone  Same.
--   guest_age    Only meaningful for children, and optional throughout — see
--                below.
--
-- On guest_age being nullable: the platform already refuses to register anyone
-- under 18 as an account holder, so an adult guest's age is both known-ish and
-- uninteresting. What the church actually needs is to know a minor is coming and
-- how old they are, for safeguarding and seating. So age is asked for, optional,
-- and only pressed for when a guest is flagged as under 18. A NULL means
-- "an adult, not recorded", not "unknown child".
--
-- Nothing here participates in seat allocation, capacity or reference
-- numbering, and every column is nullable, so existing rows stay valid.
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN guest_name  VARCHAR(120) NULL AFTER seat_id,
  ADD COLUMN guest_email VARCHAR(190) NULL AFTER guest_name,
  ADD COLUMN guest_phone VARCHAR(24)  NULL AFTER guest_email,
  ADD COLUMN guest_age   TINYINT UNSIGNED NULL AFTER guest_phone;

-- Backfill every existing seat with the booking account's own details.
--
-- This is the honest reading of the old data: before this migration the only
-- person a booking named *was* the account holder, so that is who each seat is
-- recorded against. It also means the door list, the exports and the hand bands
-- have a name to print for historic bookings instead of a blank, which is worth
-- more than leaving them NULL to mark them as un-migrated.
UPDATE bookings b
   JOIN users u ON u.id = b.user_id
    SET b.guest_name  = u.full_name,
        b.guest_email = u.email,
        b.guest_phone = COALESCE(u.mobile_number, u.whatsapp_number)
  WHERE b.guest_name IS NULL;

-- The door list is built by name, and the console lets staff search for a guest
-- who is not the account holder. Both scan this.
ALTER TABLE bookings
  ADD KEY idx_bookings_guest_name (concert_id, guest_name);
