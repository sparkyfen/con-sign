-- Roommate-to-roommate notes (PLAN.md "Stretch — multi-room / multi-con UX").
--
-- Two surfaces per room:
--   1. A single pinned note (wiki-style, last-edit-wins) lives on the
--      `room` row itself — `pinned_note` plus the "last edited by /
--      at" trailer the dashboard renders ("Last edited by Tasselfox ·
--      2 hours ago"). Cap of ~1 KB is enforced at the API layer.
--   2. A feed of transient entries lives in `room_note`. Capped at
--      50 entries per room at insert time; oldest TTLs out.
--
-- Plus `notification_pref` — shared scaffolding, NOT only for notes.
-- The schema is keyed generically (recipient_user_id, room_id, kind,
-- source_roommate_id) so the same table can hold kind='panel_offline',
-- 'battery_low', etc. when the Admin-Notifications work lands.
-- `source_roommate_id` is nullable because most rule kinds don't have
-- a per-source dimension; for kind='room_note' it's the roommate whose
-- posts the recipient wants pings about. `enabled` is the actual
-- on/off switch.

ALTER TABLE room ADD COLUMN pinned_note TEXT;
ALTER TABLE room ADD COLUMN pinned_note_updated_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL;
ALTER TABLE room ADD COLUMN pinned_note_updated_at TEXT;

CREATE TABLE room_note (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  author_user_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_room_note_room_created ON room_note (room_id, created_at DESC);

CREATE TABLE notification_pref (
  id                  TEXT PRIMARY KEY,
  recipient_user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  room_id             TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,        -- 'room_note', later 'panel_offline', 'battery_low', ...
  source_roommate_id  TEXT REFERENCES roommate(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per (recipient, room, kind, source). NULL source is treated
-- as a distinct value by SQLite's UNIQUE constraint, so a "global"
-- pref for an Admin-Notifications kind (kind='panel_offline',
-- source_roommate_id NULL) coexists with per-source rows from notes.
CREATE UNIQUE INDEX idx_notification_pref_natural
  ON notification_pref (recipient_user_id, room_id, kind, source_roommate_id);
