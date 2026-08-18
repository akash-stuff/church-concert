-- ---------------------------------------------------------------------------
-- 002_defaults.sql — starting data
-- Idempotent: safe to re-run. Everything here is editable from the admin
-- dashboard afterwards, including the seat layout.
-- ---------------------------------------------------------------------------

INSERT INTO app_settings (setting_key, value)
VALUES
  ('duplicate_check_fields', '["email","mobile_number","whatsapp_number"]'),
  ('minimum_age',            '18'),
  ('require_whatsapp_verification', 'true'),
  ('allow_user_self_cancel', 'true')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO counters (name, value)
VALUES ('booking_reference', 0)
ON DUPLICATE KEY UPDATE name = name;

INSERT INTO concerts
  (id, name, description, event_date, start_time, end_time, venue, address,
   max_capacity, booking_ref_prefix, is_active)
VALUES
  (1,
   'Night of Worship',
   'An evening of choir, strings and congregational singing. Seating is free but limited, so every attendee reserves a single seat in advance.',
   '2026-12-24', '18:30:00', '20:30:00',
   'Grace Community Church',
   'Main Sanctuary, 12 Chapel Road',
   10, 'CHC', 1)
ON DUPLICATE KEY UPDATE id = id;

INSERT INTO sections (id, concert_id, name, display_order)
VALUES
  (1, 1, 'Section A', 1),
  (2, 1, 'Section B', 2)
ON DUPLICATE KEY UPDATE id = id;

INSERT INTO seats (concert_id, section_id, seat_number, row_label, display_order, status)
VALUES
  (1, 1, 'A01', 'A', 1, 'AVAILABLE'),
  (1, 1, 'A02', 'A', 2, 'AVAILABLE'),
  (1, 1, 'A03', 'A', 3, 'AVAILABLE'),
  (1, 1, 'A04', 'A', 4, 'AVAILABLE'),
  (1, 1, 'A05', 'A', 5, 'AVAILABLE'),
  (1, 1, 'A06', 'A', 6, 'AVAILABLE'),
  (1, 1, 'A07', 'A', 7, 'AVAILABLE'),
  (1, 1, 'A08', 'A', 8, 'AVAILABLE'),
  (1, 1, 'A09', 'A', 9, 'AVAILABLE'),
  (1, 1, 'A10', 'A', 10, 'AVAILABLE'),
  (1, 2, 'B01', 'B', 1, 'AVAILABLE'),
  (1, 2, 'B02', 'B', 2, 'AVAILABLE'),
  (1, 2, 'B03', 'B', 3, 'AVAILABLE'),
  (1, 2, 'B04', 'B', 4, 'AVAILABLE'),
  (1, 2, 'B05', 'B', 5, 'AVAILABLE'),
  (1, 2, 'B06', 'B', 6, 'AVAILABLE'),
  (1, 2, 'B07', 'B', 7, 'AVAILABLE'),
  (1, 2, 'B08', 'B', 8, 'AVAILABLE'),
  (1, 2, 'B09', 'B', 9, 'AVAILABLE'),
  (1, 2, 'B10', 'B', 10, 'AVAILABLE')
ON DUPLICATE KEY UPDATE seat_number = seat_number;
