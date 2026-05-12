-- Migration: add MAC address column to `device` for hardware re-pair.
--
-- Commercial e-ink devices (TRMNL is the first) own a stable MAC. On the
-- BYOS setup handshake the device introduces itself by MAC; if a row
-- already exists for that MAC, we return the existing api_key (== device.id)
-- and the room keeps its audit history. Without this column, a
-- factory-reset device would orphan its old row and start over as a fresh
-- device.id, breaking the audit trail for that physical unit.
--
-- Nullable so existing rows and non-TRMNL devices (Pi Zero, ESP32 boards
-- without TRMNL's protocol, browser kiosks) don't need to populate it.

-- SQLite forbids adding a column with a UNIQUE constraint via
-- ALTER TABLE; the column itself is plain, and we attach the
-- uniqueness as a separate index.
ALTER TABLE device ADD COLUMN mac_address TEXT;
CREATE UNIQUE INDEX idx_device_mac ON device(mac_address);
