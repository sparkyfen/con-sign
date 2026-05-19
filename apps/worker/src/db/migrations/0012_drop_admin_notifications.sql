-- Cleanup migration: drop the schema additions from 0011 that were
-- shipped with the first Admin-Notifications implementation, then
-- reverted in source (commits d5b07f9 + 67ded11) when we paused to
-- rethink the strategy. Migration 0011 already ran in prod, so this
-- forward migration is how we put prod D1 back to "just the Notes
-- shared scaffolding."
--
-- If a future Admin-Notifications implementation needs any of these
-- back, add them in a fresh migration with the names + shapes the
-- new design actually wants — don't try to revive 0011 verbatim.
--
-- `notification_pref` itself stays — it ships with migration 0010 as
-- shared scaffolding the Notes feature uses today.

DROP TABLE IF EXISTS notification_log;

DROP INDEX IF EXISTS idx_notification_pref_natural_null_source;

ALTER TABLE notification_pref DROP COLUMN threshold_json;

ALTER TABLE room DROP COLUMN quiet_enabled;
ALTER TABLE room DROP COLUMN quiet_start_local;
ALTER TABLE room DROP COLUMN quiet_end_local;
