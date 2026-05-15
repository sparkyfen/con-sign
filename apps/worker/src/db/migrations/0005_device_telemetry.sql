-- Migration: device telemetry columns reported by TRMNL on every /display.
--
-- All nullable so non-TRMNL devices (a Pi Zero firmware we write ourselves,
-- a future Inkplate) don't need to populate them, and so existing rows
-- migrate cleanly.
--
-- Storing on the device row keeps the dashboard's "is this panel happy"
-- check a single query. Per-poll history (i.e., a time series of battery
-- readings) is not modeled here — if we ever want that, it goes in a
-- separate `device_telemetry` table, not by widening this one.

ALTER TABLE device ADD COLUMN battery_voltage  REAL;
ALTER TABLE device ADD COLUMN percent_charged  INTEGER;
ALTER TABLE device ADD COLUMN rssi             INTEGER;
ALTER TABLE device ADD COLUMN fw_version       TEXT;
ALTER TABLE device ADD COLUMN model            TEXT;
