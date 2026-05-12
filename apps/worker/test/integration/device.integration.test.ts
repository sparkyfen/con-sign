import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';
const DEVICE_A = '11111111-1111-1111-1111-111111111111';
const DEVICE_B = '22222222-2222-2222-2222-222222222222';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
}

async function setupRoom(): Promise<{
  ctx: ReturnType<typeof newCtx>;
  roomId: string;
  roommateId: string;
}> {
  const ctx = newCtx();
  const conId = await seedCon(ctx);
  await loginAs(ctx, ADMIN);
  const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
    .body as RoomCreated;
  await call(ctx, 'PATCH', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`, {
    body: { fursonaName: 'Pubname', bskyHandle: 'private.bsky.social' },
  });
  await call(
    ctx,
    'PUT',
    `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}/visibility`,
    { body: { visibility: { fursona_name: 'guest', bsky_handle: 'personal' } } },
  );
  return { ctx, roomId: created.room.id, roommateId: created.me.roommateId };
}

describe('integration: device endpoint (pair-code flow)', () => {
  it('rejects requests without a bearer token', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/device/sign.png');
    expect(r.status).toBe(401);
  });

  it('accepts the bearer via ?d= query param (TRMNL cloud plugin shape)', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', `/api/device/sign.png?d=${DEVICE_A}`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Content-Type')).toContain('svg');
    expect(r.body).toContain('PAIRING CODE');
  });

  it('serves an unpaired panel with a fresh pair code', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Content-Type')).toContain('svg');
    expect(r.body).toContain('PAIRING CODE');
    // Code was stashed in KV under pair:dev:<deviceId>.
    const code = await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('reuses the same code across polls within the TTL window', async () => {
    const ctx = newCtx();
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const first = await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`);
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const second = await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`);
    expect(first).toBe(second);
  });

  it('claims a device and the next poll returns the paired sign', async () => {
    const { ctx, roomId } = await setupRoom();
    // Use a fresh request context so we don't accidentally send the admin
    // session cookie from the device side.
    const dev = newCtx();
    Object.assign(dev.env, ctx.env);

    await call(dev, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const code = (await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`))!;

    const claim = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code },
    });
    expect(claim.status).toBe(200);
    expect((claim.body as { deviceId: string }).deviceId).toBe(DEVICE_A);

    // KV entries for the consumed code are gone.
    expect(await ctx.env.SESSIONS.get(`pair:code:${code}`)).toBeNull();
    expect(await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`)).toBeNull();

    const r = await call(dev, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Pubname'); // guest-tier visible
    expect(r.body).not.toContain('private.bsky.social');
  });

  it('rejects an unknown or expired pair code', async () => {
    const { ctx, roomId } = await setupRoom();
    const r = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: 'NOTACODE' },
    });
    expect(r.status).toBe(404);
  });

  it('rejects a duplicate claim that races a winning one (TOCTOU guard)', async () => {
    const { ctx, roomId } = await setupRoom();
    // Pre-seed a device row already paired to a different room so the
    // conflict branch's WHERE rejects the second insert.
    const otherConId = await seedCon(ctx, { name: 'Other con' });
    const otherRoom = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId: otherConId, name: 'Other' },
    })).body as RoomCreated;
    await ctx.env.SESSIONS.put(`pair:code:RACE01`, DEVICE_A);
    await ctx.env.SESSIONS.put(`pair:dev:${DEVICE_A}`, 'RACE01');
    const win = await call(ctx, 'POST', `/api/rooms/${otherRoom.room.id}/devices/claim`, {
      body: { code: 'RACE01' },
    });
    expect(win.status).toBe(200);

    // Re-seed the (now-consumed) code so the second claim reaches claimDevice.
    await ctx.env.SESSIONS.put(`pair:code:RACE02`, DEVICE_A);
    await ctx.env.SESSIONS.put(`pair:dev:${DEVICE_A}`, 'RACE02');
    const lose = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: 'RACE02' },
    });
    expect(lose.status).toBe(409);
    expect((lose.body as { error: string }).error).toBe('device_already_claimed');

    // Device is still paired to the first room.
    const r = await call(ctx, 'GET', `/api/rooms/${otherRoom.room.id}/devices`);
    expect((r.body as { devices: { id: string }[] }).devices.map((d) => d.id)).toEqual([DEVICE_A]);
  });

  it('rate-limits brute-force claim attempts (CLAIM_RL)', async () => {
    const { ctx, roomId } = await setupRoom();
    // Replace the always-pass stub with a deterministic one: third call fails.
    let n = 0;
    ctx.env.CLAIM_RL = {
      limit: async () => ({ success: ++n < 3 }),
    };

    const first = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: 'NOTACODE' }, // doesn't matter, RL hits before code lookup
    });
    expect(first.status).toBe(404); // bad code, RL passed
    const second = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: 'NOTACODE' },
    });
    expect(second.status).toBe(404);
    const third = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: 'NOTACODE' },
    });
    expect(third.status).toBe(429);
    expect((third.body as { error: string }).error).toBe('claim_rate_limited');
  });

  it('rejects reuse of a consumed pair code', async () => {
    const { ctx, roomId } = await setupRoom();
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const code = (await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`))!;
    const ok = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, { body: { code } });
    expect(ok.status).toBe(200);
    const dup = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, { body: { code } });
    expect(dup.status).toBe(404);
  });

  it('accepts the code when typed with spaces or lowercase', async () => {
    const { ctx, roomId } = await setupRoom();
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const code = (await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`))!;
    const formatted = code.split('').join(' ').toLowerCase();
    const r = await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, {
      body: { code: formatted },
    });
    expect(r.status).toBe(200);
  });

  it('lists paired devices and revokes them', async () => {
    const { ctx, roomId } = await setupRoom();
    const dev = newCtx();
    Object.assign(dev.env, ctx.env);

    // Pair two devices.
    for (const d of [DEVICE_A, DEVICE_B]) {
      await call(dev, 'GET', '/api/device/sign.png', {
        headers: { Authorization: `Bearer ${d}` },
      });
      const code = (await ctx.env.SESSIONS.get(`pair:dev:${d}`))!;
      await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, { body: { code } });
    }

    const list = await call(ctx, 'GET', `/api/rooms/${roomId}/devices`);
    expect(list.status).toBe(200);
    const devices = (list.body as { devices: { id: string }[] }).devices;
    expect(devices.map((d) => d.id).sort()).toEqual([DEVICE_A, DEVICE_B].sort());

    // Revoke one.
    const rv = await call(ctx, 'DELETE', `/api/rooms/${roomId}/devices/${DEVICE_A}`);
    expect(rv.status).toBe(200);

    // It now renders the revoked panel.
    const r = await call(dev, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    expect(r.body).toContain('PANEL UNPAIRED');

    // It is no longer listed.
    const list2 = await call(ctx, 'GET', `/api/rooms/${roomId}/devices`);
    const ids2 = (list2.body as { devices: { id: string }[] }).devices.map((d) => d.id);
    expect(ids2).toEqual([DEVICE_B]);
  });

  it('refuses to revoke a device from a different room', async () => {
    const { ctx, roomId } = await setupRoom();
    // Pair DEVICE_A to roomId.
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE_A}` },
    });
    const code = (await ctx.env.SESSIONS.get(`pair:dev:${DEVICE_A}`))!;
    await call(ctx, 'POST', `/api/rooms/${roomId}/devices/claim`, { body: { code } });

    // Create a second room owned by the same admin and try to revoke A from it.
    const conId2 = await seedCon(ctx, { name: 'Other con' });
    const room2 = (await call(ctx, 'POST', '/api/rooms', { body: { conId: conId2, name: 'R2' } }))
      .body as RoomCreated;
    const r = await call(ctx, 'DELETE', `/api/rooms/${room2.room.id}/devices/${DEVICE_A}`);
    expect(r.status).toBe(404);
  });
});
