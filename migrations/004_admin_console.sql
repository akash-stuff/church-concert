-- ---------------------------------------------------------------------------
-- 004: what the management console needs that the booking system never did.
--
-- Two additions, both purely for staff-facing screens. Neither touches the
-- booking rules: no column here participates in seat allocation, capacity or
-- reference numbering.
--
--   * concerts.poster_path — artwork for the concert cards. A path under
--     /assets, never a full URL, because the CSP allows images from 'self'
--     and data: only. NULL means "fall back to the bundled artwork", which is
--     chosen deterministically from the concert id so a given concert always
--     draws the same poster.
--   * admin_notifications — the console's own feed ("New booking received").
--     Deliberately a separate table from `notifications`: that one is an
--     outbound delivery log for WhatsApp and email, addressed to an attendee
--     and carrying a provider message id. This one is addressed to staff, has
--     no channel and no delivery state, and is read in a browser. Folding
--     them together would mean one table where half the columns are always
--     NULL depending on which kind of row it is.
-- ---------------------------------------------------------------------------

ALTER TABLE concerts
  ADD COLUMN poster_path VARCHAR(255) NULL AFTER description;

CREATE TABLE IF NOT EXISTS admin_notifications (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category    ENUM('BOOKING','TICKET','CONCERT','SYSTEM') NOT NULL,
  title       VARCHAR(190)  NOT NULL,
  body        VARCHAR(500)  NULL,
  -- What the notification is about, so the UI can deep-link to it. Free-form
  -- rather than a foreign key: a row must survive the thing it refers to being
  -- deleted, or clearing a concert would silently erase its own history.
  entity_type VARCHAR(32)   NULL,
  entity_id   INT UNSIGNED  NULL,
  concert_id  INT UNSIGNED  NULL,
  severity    ENUM('INFO','SUCCESS','WARNING') NOT NULL DEFAULT 'INFO',
  read_at     DATETIME      NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The two queries the centre actually runs: the feed, and the unread badge.
  KEY idx_admin_notifications_feed (created_at),
  KEY idx_admin_notifications_unread (read_at, created_at),
  KEY idx_admin_notifications_category (category, created_at),
  CONSTRAINT fk_admin_notifications_concert
    FOREIGN KEY (concert_id) REFERENCES concerts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the feed from bookings that already exist, so the centre is not empty on
-- a database that has been running for a while. Capped at the most recent 50:
-- this is a courtesy backfill, not an audit trail — audit_logs is that.
INSERT INTO admin_notifications (category, title, body, entity_type, entity_id, concert_id, severity, created_at)
SELECT 'BOOKING',
       CONCAT('Booking ', b.booking_reference, ' confirmed'),
       CONCAT(u.full_name, ' · seat ', s.seat_number),
       'BOOKING',
       b.id,
       b.concert_id,
       'SUCCESS',
       b.created_at
  FROM bookings b
  JOIN users u ON u.id = b.user_id
  JOIN seats s ON s.id = b.seat_id
 WHERE b.status = 'CONFIRMED'
 ORDER BY b.id DESC
 LIMIT 50;
