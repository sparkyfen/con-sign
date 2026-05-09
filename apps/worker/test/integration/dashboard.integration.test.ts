import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000d01';
const FRIEND = '00000000-0000-0000-0000-000000000d02';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
}

async function seedIdentity(
  ctx: ReturnType<typeof newCtx>,
  args: { userId: string; provider: 'bsky' | 'telegram'; providerId: string; handle: string },
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url, raw_profile_json)
     VALUES (?, ?, ?, ?, ?, NULL, '{}')`,
  )
    .bind(crypto.randomUUID(), args.userId, args.provider, args.providerId, args.handle)
    .run();
}

describe('integration: dashboard fetch endpoints', () => {
  it('GET /api/rooms returns every room the caller is a member of, with role + con info', async () => {
    const ctx = newCtx();
    const con1 = await seedCon(ctx, { name: 'Anthrocon' });
    const con2 = await seedCon(ctx, { name: 'Further Confusion', startDate: '2026-01-15' });
    await loginAs(ctx, ADMIN);

    const r1 = (await call(ctx, 'POST', '/api/rooms', { body: { conId: con1, name: 'Suite 1842' } })).body as RoomCreated;
    const r2 = (await call(ctx, 'POST', '/api/rooms', { body: { conId: con2, name: 'Tower 12' } })).body as RoomCreated;

    const list = await call(ctx, 'GET', '/api/rooms');
    expect(list.status).toBe(200);
    const rooms = (list.body as { rooms: { id: string; conName: string; role: string }[] }).rooms;
    expect(rooms).toHaveLength(2);
    const byId = new Map(rooms.map((r) => [r.id, r]));
    expect(byId.get(r1.room.id)?.conName).toBe('Anthrocon');
    expect(byId.get(r1.room.id)?.role).toBe('admin');
    expect(byId.get(r2.room.id)?.conName).toBe('Further Confusion');
  });

  it('GET /api/rooms is empty for a logged-in user with no memberships', async () => {
    const ctx = newCtx();
    await loginAs(ctx, FRIEND);
    const r = await call(ctx, 'GET', '/api/rooms');
    expect((r.body as { rooms: unknown[] }).rooms).toEqual([]);
  });

  it('GET /api/rooms requires a session', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/rooms');
    expect(r.status).toBe(401);
  });

  it('GET /api/rooms/:id returns room + con + caller role', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx, { name: 'Anthrocon', startDate: '2026-07-04', endDate: '2026-07-07' });
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'Suite 1842' } })).body as RoomCreated;

    const detail = await call(ctx, 'GET', `/api/rooms/${r.room.id}`);
    expect(detail.status).toBe(200);
    const body = detail.body as {
      room: { id: string; name: string };
      con: { name: string; startDate: string };
      myRole: string;
    };
    expect(body.room.id).toBe(r.room.id);
    expect(body.room.name).toBe('Suite 1842');
    expect(body.con.name).toBe('Anthrocon');
    expect(body.con.startDate).toBe('2026-07-04');
    expect(body.myRole).toBe('admin');
  });

  it('GET /api/rooms/:id 403s for non-members', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } })).body as RoomCreated;

    await loginAs(ctx, FRIEND); // overwrites the cookie
    const detail = await call(ctx, 'GET', `/api/rooms/${r.room.id}`);
    expect(detail.status).toBe(403);
  });

  it('GET /api/auth/me returns display name + identities', async () => {
    const ctx = newCtx();
    await loginAs(ctx, ADMIN);
    await seedIdentity(ctx, { userId: ADMIN, provider: 'bsky', providerId: 'did:plc:abc', handle: 'sparky.social' });
    await seedIdentity(ctx, { userId: ADMIN, provider: 'telegram', providerId: '12345', handle: 'sparky_tg' });

    const me = await call(ctx, 'GET', '/api/auth/me');
    expect(me.status).toBe(200);
    const body = me.body as {
      userId: string;
      displayName: string;
      identities: { provider: string; handle: string }[];
    };
    expect(body.userId).toBe(ADMIN);
    expect(body.displayName).toBeTruthy();
    const handles = body.identities.map((i) => `${i.provider}:${i.handle}`).sort();
    expect(handles).toEqual(['bsky:sparky.social', 'telegram:sparky_tg']);
  });

  it('GET /api/auth/me works for a user with no identities yet', async () => {
    const ctx = newCtx();
    await loginAs(ctx, FRIEND);
    const me = await call(ctx, 'GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect((me.body as { identities: unknown[] }).identities).toEqual([]);
  });

  it('GET /api/rooms/:id/roommates/:rid lets you read your own row in full', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } })).body as RoomCreated;
    await call(ctx, 'PATCH', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}`, {
      body: { fursonaName: 'Sparky', pronouns: 'they/them' },
    });

    const got = await call(ctx, 'GET', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}`);
    expect(got.status).toBe(200);
    const body = got.body as { fursonaName: string; pronouns: string; role: string };
    expect(body.fursonaName).toBe('Sparky');
    expect(body.pronouns).toBe('they/them');
    expect(body.role).toBe('admin');
  });

  it('GET /api/rooms/:id/roommates/:rid lets admins read other roommates', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } })).body as RoomCreated;
    const inv = (await call(ctx, 'POST', `/api/rooms/${r.room.id}/invite`)).body as { inviteUrl: string };
    const token = inv.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      roommateId: string;
    };
    await call(ctx, 'PATCH', `/api/rooms/${r.room.id}/roommates/${joined.roommateId}`, {
      body: { fursonaName: 'Friend' },
    });

    // Admin reads friend's row.
    await loginAs(ctx, ADMIN);
    const got = await call(ctx, 'GET', `/api/rooms/${r.room.id}/roommates/${joined.roommateId}`);
    expect(got.status).toBe(200);
    expect((got.body as { fursonaName: string }).fursonaName).toBe('Friend');
  });

  it('GET /api/rooms/:id/roommates/:rid 403s for non-admin reading someone else', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } })).body as RoomCreated;
    const inv = (await call(ctx, 'POST', `/api/rooms/${r.room.id}/invite`)).body as { inviteUrl: string };
    const token = inv.inviteUrl.split('/invite/')[1]!;
    const adminRoommateId = r.me.roommateId;

    await loginAs(ctx, FRIEND);
    await call(ctx, 'POST', '/api/rooms/join', { body: { token } });

    const blocked = await call(ctx, 'GET', `/api/rooms/${r.room.id}/roommates/${adminRoommateId}`);
    expect(blocked.status).toBe(403);
  });
});
