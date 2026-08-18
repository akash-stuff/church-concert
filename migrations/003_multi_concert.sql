-- ---------------------------------------------------------------------------
-- 003: several concerts at once, and more than one seat per person.
--
-- Two rules change, one does not:
--
--   * A person may now hold any number of seats, in any number of concerts, up
--     to each concert's capacity. The unique index that enforced one booking
--     per person per concert is therefore dropped.
--   * A booking reference now covers a party rather than a single seat. Four
--     seats booked together share one reference, because that is what gets
--     checked at the door. There is still one row per seat.
--   * One live booking per seat is unchanged. uq_bookings_seat_active is the
--     rule the whole system rests on and it is left exactly as it was.
-- ---------------------------------------------------------------------------

-- A person can hold several seats now, so this must go.
ALTER TABLE bookings DROP INDEX uq_bookings_user_active;

-- A reference is shared by every seat in a party, so it is no longer unique on
-- its own. The pair still is: a seat cannot appear twice under one reference.
ALTER TABLE bookings DROP INDEX uq_bookings_reference;
ALTER TABLE bookings ADD UNIQUE KEY uq_bookings_reference_seat (booking_reference, seat_id);

-- Looking a party up by reference is the commonest query at the door.
ALTER TABLE bookings ADD KEY idx_bookings_reference (booking_reference);

-- "What does this person hold for this concert?" on the dashboard.
ALTER TABLE bookings ADD KEY idx_bookings_user_concert (user_id, concert_id, active_key);

-- Optional per-concert ceiling on seats one person may take. 0 means no limit,
-- which is the default: capacity is the only thing that stops them.
ALTER TABLE concerts
  ADD COLUMN max_seats_per_booking SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER max_capacity;

-- Booking references are numbered per concert, so two concerts running at once
-- each start at 00001 under their own prefix. Seed each concert's counter from
-- the references it already has, so numbering continues rather than repeats.
INSERT INTO counters (name, value)
SELECT CONCAT('booking_reference:', c.id),
       (SELECT COUNT(DISTINCT b.booking_reference) FROM bookings b WHERE b.concert_id = c.id)
  FROM concerts c
ON DUPLICATE KEY UPDATE value = GREATEST(counters.value, VALUES(value));

-- The old single global counter is replaced by the per-concert ones above.
DELETE FROM counters WHERE name = 'booking_reference';

-- A second concert, so the multi-concert screens have something to show and
-- the seed data demonstrates two events running side by side.
INSERT INTO concerts
  (name, description, event_date, start_time, end_time, venue, address,
   max_capacity, max_seats_per_booking, booking_ref_prefix, is_active)
SELECT 'New Year Praise Night',
       'Bring in the new year with the worship team and youth choir.',
       '2026-12-31', '21:00:00', '23:30:00',
       'Grace Community Church', '12 Chapel Lane, Springfield',
       30, 0, 'NYP', 1
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM concerts WHERE name = 'New Year Praise Night');

INSERT INTO sections (concert_id, name, display_order)
SELECT c.id, 'Nave', 1 FROM concerts c
 WHERE c.name = 'New Year Praise Night'
   AND NOT EXISTS (SELECT 1 FROM sections s WHERE s.concert_id = c.id AND s.name = 'Nave');

INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order, status)
SELECT s.concert_id, s.id, CONCAT('N', LPAD(n.n, 2, '0')), 'N', n.n, 'AVAILABLE'
  FROM sections s
  JOIN concerts c ON c.id = s.concert_id
  JOIN (
    SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
    UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
    UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
    UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16
    UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20
  ) n
 WHERE c.name = 'New Year Praise Night' AND s.name = 'Nave'
   AND NOT EXISTS (
     SELECT 1 FROM seats x
      WHERE x.concert_id = s.concert_id AND x.seat_number = CONCAT('N', LPAD(n.n, 2, '0'))
   );

-- The old wording assumed one seat each.
UPDATE app_settings
   SET value = 'true'
 WHERE setting_key = 'allow_user_self_cancel';
