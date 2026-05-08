-- Migration: introduce a first-class `device` table for pair-code bootstrap.
--
-- Before this migration, a "device" was a hashed bearer token stored on a
-- room (`room.device_token_hash`). That model assumed the admin types/pastes
-- the token onto the device — workable for a tablet, awkward for a headless
-- e-ink panel.
--
-- The new model: each panel generates a stable UUID (`device.id`) on first
-- boot and uses it as its bearer forever. An unpaired panel is one with no
-- row here — its rotating 6-char pair code lives transiently in KV, not in
-- D1. Once an admin enters the code, we INSERT a row binding the device to
-- a room. Revoking sets `revoked_at`; re-pairing clears `room_id` and
-- `revoked_at` so the panel returns to the unpaired flow.

ALTER TABLE room DROP COLUMN device_token_hash;

CREATE TABLE device (
  id            TEXT PRIMARY KEY,                          -- UUID from firmware
  room_id       TEXT REFERENCES room(id) ON DELETE CASCADE,
  paired_at     TEXT,
  revoked_at    TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_device_room_id ON device(room_id);
