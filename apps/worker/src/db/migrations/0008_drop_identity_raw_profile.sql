-- Drop the write-only `identity.raw_profile_json` column. The full
-- provider profile was being JSON.stringify'd into this column on every
-- BSky / Telegram login but nothing ever SELECTed it. Per-identity rows
-- shrink by ~1 KB.
--
-- SQLite supports DROP COLUMN as of 3.35.0; D1 ships well past that.

ALTER TABLE identity DROP COLUMN raw_profile_json;
