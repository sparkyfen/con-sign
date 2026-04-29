-- 0001_init.sql — initial schema for con-sign.
-- See PLAN.md "Data Model (D1)" for the canonical reference.

-- Cons are sourced from the furrycons.com ICS feed (cron-synced); users pick.
CREATE TABLE con (
  id                 TEXT PRIMARY KEY,            -- uuid
  ics_uid            TEXT NOT NULL UNIQUE,        -- VEVENT UID, idempotency key
  name               TEXT NOT NULL,
  start_date         TEXT NOT NULL,               -- ISO 8601 (YYYY-MM-DD)
  end_date           TEXT NOT NULL,
  location           TEXT,
  url                TEXT,
  source_updated_at  TEXT NOT NULL,               -- last sync timestamp
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_con_dates ON con (start_date, end_date);

CREATE TABLE room (
  id                 TEXT PRIMARY KEY,
  con_id             TEXT NOT NULL REFERENCES con(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  qr_slug            TEXT NOT NULL UNIQUE,        -- short random slug for /r/:slug
  device_token_hash  TEXT,                        -- argon2 of bearer token (NULL until issued)
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_room_con ON room (con_id);

CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A user can attach multiple identities (login both bsky AND telegram).
CREATE TABLE identity (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('bsky', 'telegram')),
  provider_id       TEXT NOT NULL,                -- did (bsky) or numeric tg user id
  handle            TEXT,                         -- display handle (@foo.bsky.social, @foo)
  avatar_url        TEXT,                         -- bsky CDN URL; null for tg (proxied)
  raw_profile_json  TEXT,                         -- last-seen profile blob
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_id)
);
CREATE INDEX idx_identity_user ON identity (user_id);

-- Roommate = a user's membership in a room with a role + their fursona profile
-- + their personal passcode.
CREATE TABLE roommate (
  id                    TEXT PRIMARY KEY,
  room_id               TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'member')),

  -- per-roommate passcode that unlocks this roommate's `personal` fields
  passcode_hash         TEXT NOT NULL,            -- argon2
  passcode_rotated_at   TEXT NOT NULL DEFAULT (datetime('now')),

  -- fursona profile
  fursona_name          TEXT,
  fursona_species       TEXT,
  pronouns              TEXT,
  bsky_handle           TEXT,
  telegram_handle       TEXT,

  -- where they are, right now
  status_kind           TEXT CHECK (status_kind IN ('preset', 'custom')),
  status_preset         TEXT CHECK (status_preset IN
                          ('room', 'lobby', 'dealers', 'panels', 'out', 'asleep')),
  status_custom_text    TEXT,
  status_updated_at     TEXT,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, user_id)
);
CREATE INDEX idx_roommate_room ON roommate (room_id);
CREATE INDEX idx_roommate_user ON roommate (user_id);

-- Per-roommate, per-field visibility tier.
CREATE TABLE field_visibility (
  id           TEXT PRIMARY KEY,
  roommate_id  TEXT NOT NULL REFERENCES roommate(id) ON DELETE CASCADE,
  field_name   TEXT NOT NULL,                     -- e.g. 'fursona_species', 'status'
  min_tier     TEXT NOT NULL CHECK (min_tier IN ('guest', 'personal', 'private')),
  UNIQUE (roommate_id, field_name)
);
CREATE INDEX idx_field_visibility_roommate ON field_visibility (roommate_id);

-- Stretch (table created now so the schema is stable):
CREATE TABLE party (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  starts_at       TEXT NOT NULL,
  ends_at         TEXT,
  telegram_link   TEXT,
  capacity        INTEGER,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_party_room ON party (room_id);
