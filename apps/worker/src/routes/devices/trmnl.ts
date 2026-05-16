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
import {
  getDeviceWithCon,
  getOrCreateDeviceByMac,
  updateDeviceTelemetry,
} from '../../db/queries.js';
import { buildDisplayEnvelope } from '../../trmnl/adapter.js';
import { recordAudit } from '../../db/audit.js';
import { classifyDeviceState, envelopeStateFromRender } from '../../devices/state.js';

export const trmnlRoutes = new Hono<Env>();

const LOG_KV_PREFIX = 'trmnl:log:';
const LOG_TTL_SEC = 30 * 24 * 60 * 60; // 30d
const LOG_MAX_BYTES = 1024;

const macRegex = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;

function parseNumber(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseInt32(s: string | undefined): number | null {
  const n = parseNumber(s);
  return n == null ? null : Math.trunc(n);
}

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
  const mac = (c.req.header('ID') ?? '').trim().toUpperCase();
  if (!mac || !macRegex.test(mac)) {
    throw new HttpError(400, 'invalid_mac', 'ID header must be a colon-separated MAC');
  }

  const { id: deviceId, created } = await getOrCreateDeviceByMac(c.env.DB, mac);
  if (created) {
    // First-contact forensics: no actor user (the device beat any human
    // to the punch) and no room yet, but we record the MAC so an admin
    // can correlate the device's UUID to a physical panel later.
    await recordAudit(c.env.DB, {
      actorUserId: null,
      roomId: null,
      action: 'device.setup',
      targetId: deviceId,
      metadata: { mac },
    });
  }
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
 * Hot loop. TRMNL polls this with two identifying headers:
 *   - `ID`            — the device's MAC (always present).
 *   - `ACCESS_TOKEN`  — the api_key we issued at /setup (present once
 *                       the device has flashed its config).
 *
 * If ACCESS_TOKEN is set, trust it (faster path; one indexed UUID
 * lookup). Otherwise fall back to MAC — useful for the device's very
 * first /display call before it's stored the api_key, and as a
 * resilience net if its config gets cleared.
 *
 * Returns TRMNL's expected JSON envelope; `image_url` points at our
 * generic /api/device/sign.png so the unpaired/paired/revoked
 * dispatch happens once, in the right place.
 */
trmnlRoutes.get('/display', async (c) => {
  const apiKey = (c.req.header('ACCESS_TOKEN') ?? '').trim();
  const mac = (c.req.header('ID') ?? '').trim().toUpperCase();

  let deviceId: string | null = null;
  if (apiKey) {
    const found = await getDeviceWithCon(c.env.DB, apiKey);
    if (found) deviceId = apiKey;
  }
  if (!deviceId && mac && macRegex.test(mac)) {
    // No ACCESS_TOKEN, or it didn't resolve — fall back to MAC. Lazy-
    // create on first contact so a device that lost its api_key can
    // recover without going through /setup again. We don't audit
    // here; /setup is the canonical first-contact event, and a
    // device that bypassed it and landed on /display first is rare
    // enough that we'd rather log the anomaly via wrangler tail than
    // pollute the audit table.
    ({ id: deviceId } = await getOrCreateDeviceByMac(c.env.DB, mac));
  }
  if (!deviceId) throw new HttpError(401, 'unknown_device');

  const found = await getDeviceWithCon(c.env.DB, deviceId);
  if (!found) throw new HttpError(401, 'unknown_device');

  const widthQ = c.req.header('WIDTH');
  const heightQ = c.req.header('HEIGHT');
  const width = widthQ ? Math.max(100, Math.min(4096, Number(widthQ))) : 800;
  const height = heightQ ? Math.max(100, Math.min(4096, Number(heightQ))) : 480;

  // Capture optional telemetry from the request headers. parseNumber returns
  // null on absent/malformed so updateDeviceTelemetry skips them rather than
  // clobbering known-good values with NaN.
  await updateDeviceTelemetry(c.env.DB, deviceId, {
    batteryVoltage: parseNumber(c.req.header('BATTERY_VOLTAGE')),
    percentCharged: parseInt32(c.req.header('PERCENT_CHARGED')),
    rssi: parseInt32(c.req.header('RSSI')),
    fwVersion: c.req.header('FW_VERSION') ?? null,
    model: c.req.header('MODEL') ?? null,
  });

  // Mirror the routing rule in /api/device/sign.png so the cache-bust
  // tag matches what we'll actually render on the device's next fetch.
  const state = envelopeStateFromRender(classifyDeviceState(found.device));

  const envelope = buildDisplayEnvelope({
    deviceId,
    origin: new URL(c.req.url).origin,
    con:
      found.con_start_date && found.con_end_date
        ? { startDate: found.con_start_date, endDate: found.con_end_date }
        : null,
    state,
    width,
    height,
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
  // Per the TRMNL spec, /log carries the device's MAC in `ID` and is
  // the primary identifier. ACCESS_TOKEN is accepted as an alternative
  // for symmetry with /display.
  const apiKey = (c.req.header('ACCESS_TOKEN') ?? '').trim();
  const mac = (c.req.header('ID') ?? '').trim().toUpperCase();

  let deviceId: string | null = null;
  if (apiKey) deviceId = apiKey;
  else if (mac && macRegex.test(mac)) {
    ({ id: deviceId } = await getOrCreateDeviceByMac(c.env.DB, mac));
  }
  if (!deviceId) throw new HttpError(401, 'unknown_device');

  const text = (await c.req.text()).slice(0, LOG_MAX_BYTES);
  await c.env.SESSIONS.put(`${LOG_KV_PREFIX}${deviceId}`, text, {
    expirationTtl: LOG_TTL_SEC,
  });

  // Best-effort: extract telemetry that only appears in log records (battery,
  // wifi signal, firmware version) so the dashboard sees the same fields
  // regardless of whether they arrived via /display or /log.
  try {
    const parsed = JSON.parse(text) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const merged: import('../../db/queries.js').DeviceTelemetry = {};
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.battery_voltage === 'number') merged.batteryVoltage = rec.battery_voltage;
      if (typeof rec.wifi_signal === 'number') merged.rssi = rec.wifi_signal;
      if (typeof rec.firmware_version === 'string') merged.fwVersion = rec.firmware_version;
    }
    if (Object.keys(merged).length) {
      await updateDeviceTelemetry(c.env.DB, deviceId, merged);
    }
  } catch {
    // Non-JSON bodies are valid per loose interpretation of the docs; we
    // just keep the raw text in KV without extracting anything.
  }

  return new Response(null, { status: 204 });
});
