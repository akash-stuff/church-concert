-- ---------------------------------------------------------------------------
-- 007: address and emergency contact become optional.
--
-- Both were NOT NULL from 001, which made them compulsory at the one moment a
-- visitor is least willing to be interrogated: signing up for a free seat at a
-- church concert. Neither is load-bearing. Nothing in booking, seating,
-- check-in, the ticket or the wristband reads either column. They surface in
-- two read-only places and nowhere else: the attendee CSV export, whose writer
-- renders NULL as an empty cell, and the attendee detail panel in the console,
-- which already prints an em dash when the value is missing.
--
-- NULL rather than a default of '' so "not given" and "given as blank" cannot
-- be confused later. Existing rows are unaffected: widening NOT NULL to NULL
-- is non-destructive and needs no backfill.
--
-- The registration form still asks for both, and still validates them when
-- they are filled in — a half-typed phone number is rejected exactly as before.
-- What changed is only that leaving them empty is now allowed.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  MODIFY COLUMN address VARCHAR(500) NULL;

ALTER TABLE users
  MODIFY COLUMN emergency_contact VARCHAR(20) NULL;
