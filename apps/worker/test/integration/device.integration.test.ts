import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
}

async function setupRoomWithSecret(): Promise<{
  ctx: ReturnType<typeof newCtx>;
  roomId: string;
  roommateId: string;
  deviceToken: string;
}> {
  const ctx = newCtx();
  const conId = await seedCon(ctx);
  await loginAs(ctx, ADMIN);
  const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
    .body as RoomCreated;

  // Set a 'personal' field so the device view (guest tier) MUST exclude it.
  await call(ctx, 'PATCH', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`, {
    body: { fursonaName: 'Pubname', bskyHandle: 'private.bsky.social' },
  });
  await call(
    ctx,
    'PUT',
    `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}/visibility`,
    { body: { visibility: { fursona_name: 'guest', bsky_handle: 'personal' } } },
  );

  const token = (
    await call(ctx, 'POST', `/api/rooms/${created.room.id}/device-token`)
  ).body as { token: string };
  return {
    ctx,
    roomId: created.room.id,
    roommateId: created.me.roommateId,
    deviceToken: token.token,
  };
}

describe('integration: device endpoint', () => {
  it('rejects requests without a bearer token', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/device/sign.png?room=any');
    expect(r.status).toBe(401);
  });

  it('serves the room render with a valid bearer token', async () => {
    const { ctx, roomId, deviceToken } = await setupRoomWithSecret();
    // Use a fresh ctx (no admin session) — device requests are bearer-only.
    const dev = newCtx();
    Object.assign(dev.env, ctx.env);
    const r = await call(dev, 'GET', `/api/device/sign.png?room=${roomId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('Content-Type')).toContain('svg');
    expect(r.body).toContain('Pubname'); // guest-tier visible
    expect(r.body).not.toContain('private.bsky.social'); // personal hidden
  });

  it('rejects a wrong bearer token', async () => {
    const { ctx, roomId } = await setupRoomWithSecret();
    const dev = newCtx();
    Object.assign(dev.env, ctx.env);
    const r = await call(dev, 'GET', `/api/device/sign.png?room=${roomId}`, {
      headers: { Authorization: 'Bearer not-the-right-token' },
    });
    expect(r.status).toBe(401);
  });
});
