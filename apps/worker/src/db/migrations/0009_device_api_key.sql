-- Split the device's stable internal id from the firmware-facing
-- bearer credential. Before this migration `device.id` served as both
-- the row PK and the `api_key` returned to TRMNL firmware on /setup —
-- which meant `/api/trmnl/setup` handed out a paired panel's bearer
-- to anyone who could present its MAC address. There is no protocol-
-- level authenticator on /setup that we could be using and aren't:
-- stock TRMNL firmware sends only `ID: <MAC>` on its first contact.
--
-- After this migration:
--   - device.id stays the immutable row PK and remains the
--     unguessable URL bearer for the public-ish /sign.png image
--     endpoint (firmware fetches image_url with no auth headers).
--   - device.api_key is the secret the firmware presents in the
--     `ACCESS_TOKEN` header on /api/trmnl/display, /api/trmnl/log,
--     and (after claim) /api/trmnl/setup itself. NULL until an
--     operator claims the device, regenerated on revoke or admin
--     reset.
--   - device.api_key_pending_until carries a short TTL written when
--     a claim mints a new api_key. The device's next /setup poll
--     accepts the api_key without an Access-Token to bootstrap; the
--     window closes on first hand-off so attackers can't race in
--     repeatedly.
--
-- Unique partial index because most rows will be NULL until claimed.

ALTER TABLE device ADD COLUMN api_key TEXT;
ALTER TABLE device ADD COLUMN api_key_pending_until TEXT;
CREATE UNIQUE INDEX idx_device_api_key ON device(api_key) WHERE api_key IS NOT NULL;
