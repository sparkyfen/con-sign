import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon, type Ctx } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000aa1';
const MAC_A = 'AA:BB:CC:11:22:33';
const MAC_B = 'AA:BB:CC:44:55:66';
const FUTURE_TS = '2099-01-01T00:00:00.000Z';

interface SetupResponse {
  status: number;
  api_key: string | null;
  friendly_id: string | null;
  image_url: string | null;
  filename: string | null;
}
interface DisplayResponse {
  filename: string;
  image_url: string;
  refresh_rate: number;
}
interface RoomCreated {
  room: { id: string };
  me: { roommateId: string };
}

/**
 * Seed a fully-claimed device row in D1 — bypasses the /setup +
 * pair-code dance for tests that just need a paired panel to poke
 * at /display or /log. Returns the deviceId (D1 PK) and the api_key
 * the firmware would have received from /setup's pending hand-off.
 */
async function seedClaimedDevice(
  ctx: Ctx,
  mac: string,
  opts: { roomId?: string; revoked?: boolean } = {},
): Promise<{ deviceId: string; apiKey: string }> {
  // First /setup call creates the row keyed by MAC.
  await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: mac } });
  const row = await ctx.env.DB.prepare('SELECT id FROM device WHERE mac_address = ?')
    .bind(mac)
    .first<{ id: string }>();
  if (!row) throw new Error(`device row not found for MAC ${mac}`);
  const deviceId = row.id;
  const apiKey = crypto.randomUUID();
  await ctx.env.DB.prepare(
    `UPDATE device SET api_key = ?, room_id = ?, paired_at = datetime('now'),
                       last_seen_at = ?, revoked_at = ?
                 WHERE id = ?`,
  )
    .bind(
      apiKey,
      opts.roomId ?? null,
      opts.revoked ? null : new Date().toISOString(),
      opts.revoked ? new Date().toISOString() : null,
      deviceId,
    )
    .run();
  return { deviceId, apiKey };
}

describe('integration: TRMNL adapter routes', () => {
  it('rejects /setup without a MAC header', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/setup');
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_mac');
  });

  it('rejects /setup with a malformed MAC', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/setup', {
      headers: { ID: 'not-a-mac' },
    });
    expect(r.status).toBe(400);
  });

  it('/setup returns the 202 stub for a brand-new MAC (no api_key handed out unauthenticated)', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    expect(r.status).toBe(200);
    const body = r.body as SetupResponse;
    expect(body.status).toBe(202);
    expect(body.api_key).toBeNull();
    expect(body.friendly_id).toBeNull();
    expect(body.filename).toBe('unclaimed');
    // Stub still gives the firmware an image_url so the panel shows the
    // pair-code splash while idling.
    expect(body.image_url).toContain('/api/device/sign.png');
  });

  it('/setup writes a device.setup audit row on first contact, but not on re-pair', async () => {
    const ctx = newCtx();
    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    const after1 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(metadata_json) AS m FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number; m: string | null }>();
    expect(after1?.n).toBe(1);
    expect(after1?.m).toContain(MAC_A);

    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    const after2 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number }>();
    expect(after2?.n).toBe(1);

    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_B } });
    const after3 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number }>();
    expect(after3?.n).toBe(2);
  });

  it('/setup keeps returning the 202 stub for the same MAC without an Access-Token (no MAC-replay credential leak)', async () => {
    const ctx = newCtx();
    const first = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const second = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    expect(first.api_key).toBeNull();
    expect(second.api_key).toBeNull();
  });

  it('/setup hands the api_key off when the post-claim pending window is open', async () => {
    const ctx = newCtx();
    // Manufacture the post-claim state: row exists, api_key minted,
    // pending window in the future.
    const { apiKey } = await seedClaimedDevice(ctx, MAC_A);
    await ctx.env.DB.prepare(
      'UPDATE device SET api_key_pending_until = ? WHERE mac_address = ?',
    )
      .bind(FUTURE_TS, MAC_A)
      .run();

    const r = await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    const body = r.body as SetupResponse;
    expect(body.status).toBe(200);
    expect(body.api_key).toBe(apiKey);

    // Pending window cleared after first successful hand-off — second
    // unauth poll gets the stub again.
    const second = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    expect(second.status).toBe(202);
    expect(second.api_key).toBeNull();
  });

  it('/setup returns the api_key when the firmware presents matching ACCESS_TOKEN (re-pair)', async () => {
    const ctx = newCtx();
    const { apiKey } = await seedClaimedDevice(ctx, MAC_A);
    const r = await call(ctx, 'GET', '/api/trmnl/setup', {
      headers: { ID: MAC_A, ACCESS_TOKEN: apiKey },
    });
    const body = r.body as SetupResponse;
    expect(body.status).toBe(200);
    expect(body.api_key).toBe(apiKey);
    expect(body.friendly_id).toBe(apiKey.slice(0, 8).toUpperCase());
  });

  it('/setup ignores an ACCESS_TOKEN that does not match the row (impostor caller)', async () => {
    const ctx = newCtx();
    await seedClaimedDevice(ctx, MAC_A);
    const r = await call(ctx, 'GET', '/api/trmnl/setup', {
      headers: { ID: MAC_A, ACCESS_TOKEN: '00000000-0000-0000-0000-000000000000' },
    });
    expect((r.body as SetupResponse).status).toBe(202);
  });

  it('/display rejects requests without ACCESS_TOKEN', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/display');
    expect(r.status).toBe(401);
  });

  it('/display rejects an unknown ACCESS_TOKEN', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { ACCESS_TOKEN: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('unknown_device');
  });

  it('/display returns an envelope pointing at /api/device/sign.png with the api_key in the URL', async () => {
    const ctx = newCtx();
    const { apiKey } = await seedClaimedDevice(ctx, MAC_A);
    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { ACCESS_TOKEN: apiKey },
    });
    expect(r.status).toBe(200);
    const body = r.body as DisplayResponse;
    expect(body.image_url).toContain('/api/device/sign.png');
    expect(body.image_url).toContain(`d=${apiKey}`);
    expect(body.image_url).toContain('fmt=png');
    expect(body.filename).toMatch(/^sign-/);
  });

  it('/display uses the con-aware refresh rate once the device is paired', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx, {
      name: 'Test Con',
      startDate: '2020-01-01',
      endDate: '2020-01-04',
    });
    await loginAs(ctx, ADMIN);
    const room = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const { apiKey } = await seedClaimedDevice(ctx, MAC_A, { roomId: room.room.id });

    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { ACCESS_TOKEN: apiKey },
    });
    const body = r.body as DisplayResponse;
    // Con ended in 2020; we're now far outside the 7-day window.
    expect(body.refresh_rate).toBe(86400);
  });

  it('/log accepts a body, stores under trmnl:log:<deviceId>, and 204s', async () => {
    const ctx = newCtx();
    const { deviceId, apiKey } = await seedClaimedDevice(ctx, MAC_A);
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: { battery: 92, msg: 'hello' },
      headers: { ACCESS_TOKEN: apiKey },
    });
    expect(r.status).toBe(204);
    const stored = await ctx.env.SESSIONS.get(`trmnl:log:${deviceId}`);
    expect(stored).toContain('hello');
  });

  it('/log rejects without ACCESS_TOKEN', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'POST', '/api/trmnl/log', { body: { msg: 'nope' } });
    expect(r.status).toBe(401);
  });

  it('/log rejects an unknown ACCESS_TOKEN', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: [{ message: 'no key' }],
      headers: { ACCESS_TOKEN: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(401);
  });

  it('/display stashes battery/rssi/fw_version from request headers', async () => {
    const ctx = newCtx();
    const { deviceId, apiKey } = await seedClaimedDevice(ctx, MAC_A);
    await call(ctx, 'GET', '/api/trmnl/display', {
      headers: {
        ACCESS_TOKEN: apiKey,
        BATTERY_VOLTAGE: '3.92',
        PERCENT_CHARGED: '74',
        RSSI: '-58',
        FW_VERSION: '1.4.3',
        MODEL: 'og',
      },
    });
    const row = await ctx.env.DB.prepare('SELECT * FROM device WHERE id = ?')
      .bind(deviceId)
      .first<{
        battery_voltage: number;
        percent_charged: number;
        rssi: number;
        fw_version: string;
        model: string;
      }>();
    expect(row?.battery_voltage).toBeCloseTo(3.92);
    expect(row?.percent_charged).toBe(74);
    expect(row?.rssi).toBe(-58);
    expect(row?.fw_version).toBe('1.4.3');
    expect(row?.model).toBe('og');
  });

  it('/log parses structured records and extracts telemetry', async () => {
    const ctx = newCtx();
    const { deviceId, apiKey } = await seedClaimedDevice(ctx, MAC_A);
    await call(ctx, 'POST', '/api/trmnl/log', {
      body: [
        { message: 'wifi connected', battery_voltage: 3.71, wifi_signal: -67, firmware_version: '1.5.0' },
      ],
      headers: { ACCESS_TOKEN: apiKey },
    });
    const row = await ctx.env.DB.prepare('SELECT * FROM device WHERE id = ?')
      .bind(deviceId)
      .first<{ battery_voltage: number; rssi: number; fw_version: string }>();
    expect(row?.battery_voltage).toBeCloseTo(3.71);
    expect(row?.rssi).toBe(-67);
    expect(row?.fw_version).toBe('1.5.0');
  });

  it('routes are reachable at the /api/* root alias for TRMNL stock firmware', async () => {
    const ctx = newCtx();
    // /setup at the alias path.
    const r = await call(ctx, 'GET', '/api/setup', { headers: { ID: MAC_A } });
    expect(r.status).toBe(200);
    expect((r.body as SetupResponse).status).toBe(202);

    // Set up a paired device for the /display + /log aliases.
    const { apiKey } = await seedClaimedDevice(ctx, MAC_B);
    const display = await call(ctx, 'GET', '/api/display', {
      headers: { ACCESS_TOKEN: apiKey },
    });
    expect(display.status).toBe(200);
    const log = await call(ctx, 'POST', '/api/log', {
      body: [{ message: 'aliased' }],
      headers: { ACCESS_TOKEN: apiKey },
    });
    expect(log.status).toBe(204);
  });

  it('MAC-only request never receives a paired device api_key (vuln regression)', async () => {
    // Mallory learns Victim's MAC and hits /setup repeatedly hoping to
    // grab the api_key. With the row in paired state (api_key minted,
    // no pending window), every unauth poll gets the 202 stub.
    const ctx = newCtx();
    await seedClaimedDevice(ctx, MAC_A);
    for (let i = 0; i < 5; i++) {
      const r = await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
      expect((r.body as SetupResponse).api_key).toBeNull();
    }
  });

  it('CSRF middleware does not require Origin on /api/trmnl/* POSTs', async () => {
    const ctx = newCtx();
    const { apiKey } = await seedClaimedDevice(ctx, MAC_A);
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: { msg: 'hi' },
      headers: { ACCESS_TOKEN: apiKey, Origin: '' },
    });
    expect(r.status).toBe(204);
  });
});
