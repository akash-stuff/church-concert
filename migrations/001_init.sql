-- ---------------------------------------------------------------------------
-- 001_init.sql — core schema
-- Runs inside the existing database named in DATABASE_URL. No CREATE DATABASE.
-- Engine: InnoDB (required for transactions and foreign keys).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admins (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name      VARCHAR(120)  NOT NULL,
  email          VARCHAR(190)  NOT NULL,
  password_hash  VARCHAR(255)  NOT NULL,
  role           ENUM('SUPER_ADMIN','ADMIN') NOT NULL DEFAULT 'ADMIN',
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  token_version  INT UNSIGNED  NOT NULL DEFAULT 1,
  last_login_at  DATETIME      NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name             VARCHAR(120)  NOT NULL,
  email                 VARCHAR(190)  NOT NULL,
  mobile_number         VARCHAR(20)   NOT NULL,
  whatsapp_number       VARCHAR(20)   NOT NULL,
  password_hash         VARCHAR(255)  NOT NULL,
  date_of_birth         DATE          NOT NULL,
  gender                ENUM('MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY') NOT NULL DEFAULT 'PREFER_NOT_TO_SAY',
  address               VARCHAR(500)  NOT NULL,
  emergency_contact     VARCHAR(20)   NOT NULL,
  terms_accepted_at     DATETIME      NOT NULL,
  age_confirmed_at      DATETIME      NOT NULL,
  whatsapp_verified     TINYINT(1)    NOT NULL DEFAULT 0,
  whatsapp_verified_at  DATETIME      NULL,
  is_active             TINYINT(1)    NOT NULL DEFAULT 1,
  disabled_reason       VARCHAR(255)  NULL,
  failed_login_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until          DATETIME      NULL,
  token_version         INT UNSIGNED  NOT NULL DEFAULT 1,
  last_login_at         DATETIME      NULL,
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_mobile (mobile_number),
  UNIQUE KEY uq_users_whatsapp (whatsapp_number),
  KEY idx_users_created (created_at),
  KEY idx_users_verified (whatsapp_verified)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS concerts (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                   VARCHAR(190) NOT NULL,
  description            TEXT         NULL,
  event_date             DATE         NOT NULL,
  start_time             TIME         NOT NULL,
  end_time               TIME         NULL,
  venue                  VARCHAR(190) NOT NULL,
  address                VARCHAR(500) NULL,
  max_capacity           INT UNSIGNED NOT NULL DEFAULT 10,
  registration_opens_at  DATETIME     NULL,
  registration_closes_at DATETIME     NULL,
  booking_opens_at       DATETIME     NULL,
  booking_closes_at      DATETIME     NULL,
  booking_ref_prefix     VARCHAR(12)  NOT NULL DEFAULT 'CHC',
  is_active              TINYINT(1)   NOT NULL DEFAULT 1,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_concerts_active (is_active, event_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sections (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  concert_id    INT UNSIGNED NOT NULL,
  name          VARCHAR(60)  NOT NULL,
  display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sections_concert_name (concert_id, name),
  CONSTRAINT fk_sections_concert FOREIGN KEY (concert_id) REFERENCES concerts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SELECTED exists for API/UI parity with the spec. Selection is a transient
-- client-side state; the server only ever persists AVAILABLE, BOOKED,
-- RESERVED or DISABLED. A seat is never left SELECTED in the database.
CREATE TABLE IF NOT EXISTS seats (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  concert_id    INT UNSIGNED NOT NULL,
  section_id    INT UNSIGNED NOT NULL,
  seat_number   VARCHAR(16)  NOT NULL,
  row_label     VARCHAR(8)   NULL,
  display_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('AVAILABLE','SELECTED','BOOKED','RESERVED','DISABLED') NOT NULL DEFAULT 'AVAILABLE',
  note          VARCHAR(255) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_seats_concert_number (concert_id, seat_number),
  KEY idx_seats_section (section_id, display_order),
  KEY idx_seats_status (concert_id, status),
  CONSTRAINT fk_seats_concert FOREIGN KEY (concert_id) REFERENCES concerts (id) ON DELETE CASCADE,
  CONSTRAINT fk_seats_section FOREIGN KEY (section_id) REFERENCES sections (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- The double-booking guarantee.
--
-- active_key is a STORED generated column: 1 while a booking is live
-- (PENDING/CONFIRMED), NULL once it is CANCELLED/EXPIRED. MySQL unique
-- indexes ignore NULLs, so:
--
--   uq_bookings_seat_active  ->  one seat can have at most ONE live booking,
--                                but any number of cancelled ones.
--   uq_bookings_user_active  ->  one user can have at most ONE live booking
--                                per concert.
--
-- These are hard database constraints. Even if application code, an admin
-- action and two concurrent requests all disagree, the database refuses the
-- second write with ER_DUP_ENTRY (1062).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_reference   VARCHAR(32)  NOT NULL,
  concert_id          INT UNSIGNED NOT NULL,
  user_id             INT UNSIGNED NOT NULL,
  seat_id             INT UNSIGNED NOT NULL,
  status              ENUM('PENDING','CONFIRMED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  active_key          TINYINT UNSIGNED GENERATED ALWAYS AS
                        (CASE WHEN status IN ('PENDING','CONFIRMED') THEN 1 ELSE NULL END) STORED,
  source              ENUM('USER','ADMIN') NOT NULL DEFAULT 'USER',
  created_by_admin_id INT UNSIGNED NULL,
  confirmed_at        DATETIME     NULL,
  cancelled_at        DATETIME     NULL,
  cancelled_by        VARCHAR(32)  NULL,
  cancel_reason       VARCHAR(255) NULL,
  note               VARCHAR(255) NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bookings_reference (booking_reference),
  UNIQUE KEY uq_bookings_seat_active (seat_id, active_key),
  UNIQUE KEY uq_bookings_user_active (concert_id, user_id, active_key),
  KEY idx_bookings_status (concert_id, status),
  KEY idx_bookings_user (user_id),
  CONSTRAINT fk_bookings_concert FOREIGN KEY (concert_id) REFERENCES concerts (id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_seat FOREIGN KEY (seat_id) REFERENCES seats (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bookings_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whatsapp_verifications (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,
  phone_e164   VARCHAR(20)  NOT NULL,
  code_hash    CHAR(64)     NOT NULL,
  attempts     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at   DATETIME     NOT NULL,
  consumed_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_wa_user (user_id, consumed_at),
  KEY idx_wa_expiry (expires_at),
  CONSTRAINT fk_wa_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  consumed_at DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  KEY idx_reset_user (user_id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED NULL,
  recipient           VARCHAR(64)  NOT NULL,
  channel             ENUM('WHATSAPP','EMAIL') NOT NULL DEFAULT 'WHATSAPP',
  type                ENUM('REGISTRATION','WHATSAPP_VERIFICATION','BOOKING_CONFIRMATION',
                           'BOOKING_CANCELLATION','SEAT_REASSIGNMENT','EVENT_REMINDER',
                           'PASSWORD_RESET') NOT NULL,
  body                TEXT         NULL,
  payload             JSON         NULL,
  status              ENUM('QUEUED','SENT','DELIVERED','READ','FAILED') NOT NULL DEFAULT 'QUEUED',
  provider_message_id VARCHAR(128) NULL,
  failure_reason      VARCHAR(500) NULL,
  sent_at             DATETIME     NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id),
  KEY idx_notif_status (status, created_at),
  KEY idx_notif_provider (provider_message_id),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_type  ENUM('ADMIN','USER','SYSTEM') NOT NULL,
  actor_id    INT UNSIGNED NULL,
  actor_label VARCHAR(190) NULL,
  action      VARCHAR(80)  NOT NULL,
  entity_type VARCHAR(40)  NULL,
  entity_id   VARCHAR(64)  NULL,
  metadata    JSON         NULL,
  ip_address  VARCHAR(45)  NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_type, actor_id),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Booking reference sequence. Incremented with SELECT ... FOR UPDATE inside
-- the booking transaction so two concurrent bookings can never share a ref.
CREATE TABLE IF NOT EXISTS counters (
  name       VARCHAR(64)  NOT NULL,
  value      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) NOT NULL,
  value       JSON        NOT NULL,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
