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
  consumePendingApiKey,
  getDevice,
  getDeviceByApiKey,
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
 * TRMNL firmware sends `ID: <MAC>` here. The stock protocol provides
 * no other authenticator on this endpoint, so we treat MAC as a
 * non-secret identity claim, not a credential. There are three exits:
 *
 *   - Firmware already has its `api_key` and presents matching
 *     `ACCESS_TOKEN`: re-pair from the same device. Return the key.
 *   - Row was just claimed (claim opened a short pending window) and
 *     this is the first poll inside the window: hand the key off,
 *     close the window. The device records it and starts polling
 *     /display.
 *   - Otherwise: return a `status: 202` stub. Stock firmware accepts
 *     that and retries — used for both "never claimed" and "MAC seen
 *     but you're not who you claim to be" (no Access-Token, no pending
 *     window). The stub keeps the same response shape so the firmware
 *     parses it cleanly.
 *
 * Bootstrapping a new device looks like:
 *   1. Boot → /setup → 202 stub → firmware retries.
 *   2. Admin types pair code in dashboard → server mints the device's
 *      api_key + opens a 5-min pending window.
 *   3. Device's next /setup poll inside the window picks up the key.
 *   4. Window closes. Subsequent /setup polls only succeed when the
 *      firmware presents `ACCESS_TOKEN`.
 */
trmnlRoutes.get('/setup', async (c) => {
  const mac = (c.req.header('ID') ?? '').trim().toUpperCase();
  if (!mac || !macRegex.test(mac)) {
    throw new HttpError(400, 'invalid_mac', 'ID header must be a colon-separated MAC');
  }
  const accessToken = (c.req.header('ACCESS_TOKEN') ?? '').trim();

  const { id: deviceId, created } = await getOrCreateDeviceByMac(c.env.DB, mac);
  if (created) {
    // First-contact forensics: no actor user (the device beat any human
    // to the punch) and no room yet, but we record the MAC so an admin
    // can correlate the device's internal UUID to a physical panel.
    await recordAudit(c.env.DB, {
      actorUserId: null,
      roomId: null,
      action: 'device.setup',
      targetId: deviceId,
      metadata: { mac },
    });
  }

  const row = await getDevice(c.env.DB, deviceId);
  if (row?.api_key && accessToken && accessToken === row.api_key) {
    // Re-pair from the same device. Firmware already has the key; we're
    // just confirming the bootstrap completed.
    return c.json(setupResponse(row.api_key));
  }

  // No matching Access-Token — only the post-claim pending window can
  // hand the key out. The query clears the window on hit, so this is
  // single-use across the whole keyspace and there's no second chance
  // for a racer once the legitimate device polls.
  const pending = await consumePendingApiKey(c.env.DB, deviceId);
  if (pending) {
    return c.json(setupResponse(pending));
  }

  // Unclaimed device, or paired-but-impostor caller. Either way: keep
  // the firmware idling on /setup until an admin acts. Hand it an
  // image_url for the pair-code screen so the corridor sees the OTP
  // an operator needs to type into the dashboard.
  return c.json(setupStub(deviceId, new URL(c.req.url).origin));
});

function setupResponse(apiKey: string): Record<string, unknown> {
  return {
    status: 200,
    api_key: apiKey,
    // TRMNL displays this in their dashboard / firmware logs to help
    // humans disambiguate panels. First 8 of the api_key is enough
    // and doesn't leak the secret.
    friendly_id: apiKey.slice(0, 8).toUpperCase(),
    image_url: null,
    filename: null,
    message: 'Welcome to con-sign.',
  };
}

function setupStub(deviceId: string, origin: string): Record<string, unknown> {
  // The pair-code screen is rendered by /api/device/sign.png and keyed
  // on device.id. Pre-claim that lookup is safe: device.id grants no
  // access beyond the public OTP image (api_key is the credential and
  // is still NULL). Once a claim mints api_key, /sign.png stops
  // accepting device.id and only honors api_key — so this URL stops
  // working the moment it would expose sensitive content.
  const img = new URL('/api/device/sign.png', origin);
  img.searchParams.set('d', deviceId);
  img.searchParams.set('fmt', 'png');
  img.searchParams.set('w', '800');
  img.searchParams.set('h', '480');
  return {
    status: 202,
    api_key: null,
    friendly_id: null,
    image_url: img.toString(),
    filename: 'unclaimed',
    refresh_rate: 900,
    message: 'Device awaiting operator claim.',
  };
}

/**
 * GET /api/trmnl/display
 *
 * Hot loop. TRMNL firmware polls with `ACCESS_TOKEN: <api_key>` once
 * it's been through the /setup bootstrap. There's no MAC fallback —
 * before claim the firmware has no key and should stay on /setup;
 * after claim it has the key and uses it. Anything else is treated
 * as unknown and returns 401, which the firmware backs off from.
 *
 * Returns TRMNL's expected JSON envelope; `image_url` points at our
 * generic /api/device/sign.png so the unpaired/paired/revoked
 * dispatch happens once, in the right place.
 */
trmnlRoutes.get('/display', async (c) => {
  const apiKey = (c.req.header('ACCESS_TOKEN') ?? '').trim();
  if (!apiKey) throw new HttpError(401, 'unknown_device');
  const lookup = await getDeviceByApiKey(c.env.DB, apiKey);
  if (!lookup) throw new HttpError(401, 'unknown_device');
  const deviceId = lookup.id;

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
    apiKey,
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
  // Per /display: only an Access-Token gets you in. The MAC alone is
  // never a credential — it's printed on every panel and routinely
  // visible to anyone on the same Wi-Fi.
  const apiKey = (c.req.header('ACCESS_TOKEN') ?? '').trim();
  if (!apiKey) throw new HttpError(401, 'unknown_device');
  const lookup = await getDeviceByApiKey(c.env.DB, apiKey);
  if (!lookup) throw new HttpError(401, 'unknown_device');
  const deviceId = lookup.id;

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
