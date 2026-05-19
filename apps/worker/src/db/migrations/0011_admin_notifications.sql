-- Admin Notifications v1 — schema delta from 0010_room_notes.sql.
--
-- See PLAN.md "Admin notifications". This migration sets up the
-- storage; the cron + Telegram DM glue ships in a follow-up PR.
--
--   * `notification_pref.threshold_json` — opaque blob of per-kind
--     thresholds (e.g. {"hours": 2} for panel_offline). Non-adjustable
--     in v1 — toggles only on the dashboard — but the column carries
--     defaults at runtime so a future "let me bump 2h to 4h" lands
--     without a migration.
--
--   * `room.quiet_*` — one quiet-hours window per room (not per
--     pref / not per admin), per the locked design. Stored as TEXT
--     "HH:MM" in con-local TZ so the runtime check is a string
--     compare against an Intl-formatted "current local time."
--
--   * `notification_log` — delivery audit. Cron + DM sender will
--     populate this; reads land in v1 so the "Recent Alerts" card
--     can render an empty state without 500ing.

ALTER TABLE notification_pref ADD COLUMN threshold_json TEXT;

-- SQLite treats NULLs in a UNIQUE index as distinct, so the
-- migration-0010 `idx_notification_pref_natural` index on
-- (recipient_user_id, room_id, kind, source_roommate_id) does NOT
-- prevent duplicate (recipient, room, kind) rows when source is NULL —
-- which is exactly the case for every Admin-Notifications rule kind
-- (panel_offline, panel_battery_low, etc.). Add a partial unique
-- index specifically for the NULL-source case so upserts on rule
-- prefs have a real conflict target to land on.
CREATE UNIQUE INDEX idx_notification_pref_natural_null_source
  ON notification_pref (recipient_user_id, room_id, kind)
  WHERE source_roommate_id IS NULL;

ALTER TABLE room ADD COLUMN quiet_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room ADD COLUMN quiet_start_local TEXT;
ALTER TABLE room ADD COLUMN quiet_end_local TEXT;

CREATE TABLE notification_log (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  fired_at          TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json      TEXT,        -- title + detail strings the cron wrote
  delivery_status   TEXT NOT NULL,  -- 'sent' | 'failed' | 'suppressed_quiet' | 'suppressed_off'
  delivery_error    TEXT
);
CREATE INDEX idx_notification_log_room_fired
  ON notification_log (room_id, fired_at DESC);
