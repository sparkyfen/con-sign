/**
 * Adapter routes for TRMNL's stock BYOS firmware.
 *
 * These exist *only* to speak the protocol shape TRMNL's firmware
 * hardcodes (specific URL paths, specific headers, specific JSON
 * envelope). All actual logic — device state machine, render dispatch,
 * pair-code OTP, audit log — lives in the generic core
 * (`/api/device/sign.png`) and is shared with any custom-firmware
 * device. See `docs/devices/protocol.md` for the protocol every
 * device speaks under the adapter layer.
 */

import { Hono } from 'hono';
import type { Env } from '../../types.js';
import { HttpError } from '../../errors.js';
import { getDeviceWithCon, getOrCreateDeviceByMac } from '../../db/queries.js';
import { buildDisplayEnvelope } from '../../trmnl/adapter.js';

export const trmnlRoutes = new Hono<Env>();

const LOG_KV_PREFIX = 'trmnl:log:';
const LOG_TTL_SEC = 30 * 24 * 60 * 60; // 30d
const LOG_MAX_BYTES = 1024;

const macRegex = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;

/**
 * GET /api/trmnl/setup
 *
 * First-boot handshake. TRMNL sends its MAC address in the `ID` header;
 * we either return the existing api_key for that MAC (re-pair after
 * factory reset) or mint a new device row.
 *
 * Response shape matches TRMNL's BYOS contract.
 */
trmnlRoutes.get('/setup', async (c) => {
  const mac = (c.req.header('ID') ?? c.req.header('mac') ?? '').trim().toUpperCase();
  if (!mac || !macRegex.test(mac)) {
    throw new HttpError(400, 'invalid_mac', 'ID header must be a colon-separated MAC');
  }

  const deviceId = await getOrCreateDeviceByMac(c.env.DB, mac);
  return c.json({
    status: 200,
    api_key: deviceId,
    // TRMNL displays this in their dashboard / firmware logs to help
    // humans disambiguate panels. First 8 of the UUID is enough.
    friendly_id: deviceId.slice(0, 8).toUpperCase(),
    image_url: null,
    filename: null,
    message: 'Welcome to con-sign.',
  });
});

/**
 * GET /api/trmnl/display
 *
 * Hot loop. TRMNL polls this on its configured cadence with
 * `Access-Token: <api_key>`. We translate the device's current state
 * into TRMNL's expected JSON envelope. `image_url` points at the
 * generic /api/device/sign.png so the unpaired/paired/revoked
 * dispatch happens once, in the right place.
 */
trmnlRoutes.get('/display', async (c) => {
  const apiKey = (c.req.header('Access-Token') ?? '').trim();
  if (!apiKey) throw new HttpError(401, 'missing_access_token');

  const found = await getDeviceWithCon(c.env.DB, apiKey);
  if (!found) throw new HttpError(401, 'unknown_device');

  const envelope = buildDisplayEnvelope({
    deviceId: apiKey,
    origin: new URL(c.req.url).origin,
    con:
      found.con_start_date && found.con_end_date
        ? { startDate: found.con_start_date, endDate: found.con_end_date }
        : null,
  });
  return c.json(envelope);
});

/**
 * POST /api/trmnl/log
 *
 * Optional telemetry. TRMNL firmware POSTs runtime messages here
 * (battery, button events, errors). We keep the most recent message
 * per device in KV with a 30-day TTL — useful for incident triage,
 * not durable enough to power any product feature.
 *
 * Truncate to LOG_MAX_BYTES so a noisy panel can't blow up KV.
 */
trmnlRoutes.post('/log', async (c) => {
  const apiKey = (c.req.header('Access-Token') ?? '').trim();
  if (!apiKey) throw new HttpError(401, 'missing_access_token');

  const text = (await c.req.text()).slice(0, LOG_MAX_BYTES);
  await c.env.SESSIONS.put(`${LOG_KV_PREFIX}${apiKey}`, text, {
    expirationTtl: LOG_TTL_SEC,
  });
  return new Response(null, { status: 204 });
});
