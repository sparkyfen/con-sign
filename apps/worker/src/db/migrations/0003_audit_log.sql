-- Migration: append-only audit log of admin actions.
--
-- Rows are written from the request handlers (see src/db/audit.ts). Reads:
-- per-room (any member of the room can see that room's history) and
-- per-user (the actor sees their own actions across rooms). No mutation
-- API — auditing is observational, never edited.
--
-- The action vocabulary lives in src/db/audit.ts as a TS union, not in
-- a CHECK constraint here, so adding new actions later is just app code.

CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  -- The user who performed the action. NULL only if a future system
  -- action ever needs to be logged (e.g. cron-driven cleanup).
  actor_user_id   TEXT REFERENCES user(id) ON DELETE SET NULL,
  -- Room context, NULL for actions that aren't room-scoped.
  -- ON DELETE SET NULL preserves history when a room is deleted.
  room_id         TEXT REFERENCES room(id) ON DELETE SET NULL,
  -- Short identifier of what happened: 'room.create', 'device.claim', etc.
  action          TEXT NOT NULL,
  -- The id of the thing acted upon (roommate id, device id, room id, ...).
  -- Free-form so each action chooses what's most useful.
  target_id       TEXT,
  -- JSON blob of action-specific extras: old/new room name, the joining
  -- user's display name, etc. Kept small; not for blob storage.
  metadata_json   TEXT,
  at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_room_at  ON audit_log(room_id, at DESC);
CREATE INDEX idx_audit_log_actor_at ON audit_log(actor_user_id, at DESC);
