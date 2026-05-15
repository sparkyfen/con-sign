import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000aa1';
const MAC_A = 'AA:BB:CC:11:22:33';
const MAC_B = 'AA:BB:CC:44:55:66';

interface SetupResponse {
  api_key: string;
  friendly_id: string;
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

  it('/setup mints a fresh api_key for a new MAC', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    expect(r.status).toBe(200);
    const body = r.body as SetupResponse;
    expect(body.api_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/); // uuid
    expect(body.friendly_id).toHaveLength(8);
    expect(body.friendly_id).toBe(body.api_key.slice(0, 8).toUpperCase());
  });

  it('/setup writes a device.setup audit row on first contact, but not on re-pair', async () => {
    const ctx = newCtx();
    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    // Audit table is the source of truth — count rows for this action.
    const after1 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(metadata_json) AS m FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number; m: string | null }>();
    expect(after1?.n).toBe(1);
    expect(after1?.m).toContain(MAC_A);

    // Second /setup with the same MAC is idempotent — no new audit row.
    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } });
    const after2 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number }>();
    expect(after2?.n).toBe(1);

    // A different MAC = a different first contact = another audit row.
    await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_B } });
    const after3 = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device.setup'",
    ).first<{ n: number }>();
    expect(after3?.n).toBe(2);
  });

  it('/setup returns the same api_key on re-pair (factory reset survives)', async () => {
    const ctx = newCtx();
    const first = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const second = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    expect(second.api_key).toBe(first.api_key);
  });

  it('/setup issues distinct keys for distinct MACs', async () => {
    const ctx = newCtx();
    const a = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const b = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_B } }))
      .body as SetupResponse;
    expect(a.api_key).not.toBe(b.api_key);
  });

  it('/display rejects requests with neither ACCESS_TOKEN nor ID', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/display');
    expect(r.status).toBe(401);
  });

  it('/display falls back to MAC when ACCESS_TOKEN is missing', async () => {
    const ctx = newCtx();
    // First /display ever — the device hasn't stored its api_key yet,
    // so it sends only ID (MAC). We should lazy-create the device row.
    const r = await call(ctx, 'GET', '/api/trmnl/display', { headers: { ID: MAC_A } });
    expect(r.status).toBe(200);
  });

  it('/display rejects an unknown ACCESS_TOKEN with no fallback MAC', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { ACCESS_TOKEN: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('unknown_device');
  });

  it('/display returns an envelope pointing at /api/device/sign.png with the bearer', async () => {
    const ctx = newCtx();
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { 'ACCESS_TOKEN': setup.api_key },
    });
    expect(r.status).toBe(200);
    const body = r.body as DisplayResponse;
    expect(body.image_url).toContain('/api/device/sign.png');
    expect(body.image_url).toContain(`d=${setup.api_key}`);
    expect(body.image_url).toContain('fmt=png');
    expect(body.refresh_rate).toBe(300); // unpaired → 5 min
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
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;

    // Pair the device into the room (simulate the OTP-claim flow without
    // round-tripping through KV, since claimDevice is the same code path).
    await ctx.env.DB.prepare(
      "UPDATE device SET room_id = ?, paired_at = datetime('now') WHERE id = ?",
    )
      .bind(room.room.id, setup.api_key)
      .run();

    const r = await call(ctx, 'GET', '/api/trmnl/display', {
      headers: { 'ACCESS_TOKEN': setup.api_key },
    });
    const body = r.body as DisplayResponse;
    // Con ended in 2020; we're now far outside the 7-day window.
    expect(body.refresh_rate).toBe(86400);
  });

  it('/log accepts a body, stores under trmnl:log:<deviceId>, and 204s', async () => {
    const ctx = newCtx();
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: { battery: 92, msg: 'hello' },
      headers: { 'ACCESS_TOKEN': setup.api_key },
    });
    expect(r.status).toBe(204);
    const stored = await ctx.env.SESSIONS.get(`trmnl:log:${setup.api_key}`);
    expect(stored).toContain('hello');
  });

  it('/log rejects without ACCESS_TOKEN or ID', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'POST', '/api/trmnl/log', { body: { msg: 'nope' } });
    expect(r.status).toBe(401);
  });

  it('/log accepts ID (MAC) as the device identifier', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: [{ message: 'hello via MAC' }],
      headers: { ID: MAC_B },
    });
    expect(r.status).toBe(204);
  });

  it('/display stashes battery/rssi/fw_version from request headers', async () => {
    const ctx = newCtx();
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    await call(ctx, 'GET', '/api/trmnl/display', {
      headers: {
        ACCESS_TOKEN: setup.api_key,
        BATTERY_VOLTAGE: '3.92',
        PERCENT_CHARGED: '74',
        RSSI: '-58',
        FW_VERSION: '1.4.3',
        MODEL: 'og',
      },
    });
    const row = await ctx.env.DB.prepare('SELECT * FROM device WHERE id = ?')
      .bind(setup.api_key)
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
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    await call(ctx, 'POST', '/api/trmnl/log', {
      body: [
        { message: 'wifi connected', battery_voltage: 3.71, wifi_signal: -67, firmware_version: '1.5.0' },
      ],
      headers: { ID: MAC_A },
    });
    const row = await ctx.env.DB.prepare('SELECT * FROM device WHERE id = ?')
      .bind(setup.api_key)
      .first<{ battery_voltage: number; rssi: number; fw_version: string }>();
    expect(row?.battery_voltage).toBeCloseTo(3.71);
    expect(row?.rssi).toBe(-67);
    expect(row?.fw_version).toBe('1.5.0');
  });

  it('routes are reachable at the /api/* root alias for TRMNL stock firmware', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/setup', { headers: { ID: MAC_A } });
    expect(r.status).toBe(200);
    const setup = r.body as SetupResponse;
    expect(setup.api_key).toMatch(/^[0-9a-f]{8}-/);
    const display = await call(ctx, 'GET', '/api/display', {
      headers: { ACCESS_TOKEN: setup.api_key },
    });
    expect(display.status).toBe(200);
    const log = await call(ctx, 'POST', '/api/log', {
      body: [{ message: 'aliased' }],
      headers: { ID: MAC_A },
    });
    expect(log.status).toBe(204);
  });

  it('CSRF middleware does not require Origin on /api/trmnl/* POSTs', async () => {
    // The TRMNL device sends no Origin header; verify the carve-out
    // actually lets the POST through (without the carve-out, this would
    // be 403 origin_required).
    const ctx = newCtx();
    const setup = (await call(ctx, 'GET', '/api/trmnl/setup', { headers: { ID: MAC_A } }))
      .body as SetupResponse;
    const r = await call(ctx, 'POST', '/api/trmnl/log', {
      body: { msg: 'hi' },
      headers: { 'ACCESS_TOKEN': setup.api_key, Origin: '' },
    });
    expect(r.status).toBe(204);
  });
});
