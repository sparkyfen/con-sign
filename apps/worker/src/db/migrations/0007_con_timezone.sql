-- Add an IANA timezone for each con. The ICS feed we sync from emits
-- date-only DTSTART, so we never get a TZID — operators set this column
-- by hand (or via a future admin UI). NULL means "render UTC" on the
-- panel, which is functional but boring for cons not on UTC.
--
-- Used by the panel renderer for two things: the wall clock in the
-- header, and the DAY N calculation (which previously rolled at UTC
-- midnight regardless of where the con was).

ALTER TABLE con ADD COLUMN timezone TEXT;
