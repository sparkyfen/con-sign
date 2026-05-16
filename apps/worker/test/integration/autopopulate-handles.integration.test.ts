import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const JOINER = '00000000-0000-0000-0000-0000000000a2';
const STRANGER = '00000000-0000-0000-0000-0000000000a3';

async function seedIdentity(
  ctx: ReturnType<typeof newCtx>,
  args: { userId: string; provider: 'bsky' | 'telegram'; providerId: string; handle: string },
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(crypto.randomUUID(), args.userId, args.provider, args.providerId, args.handle)
    .run();
}

interface RoomCreated {
  room: { id: string };
  me: { roommateId: string };
}

describe('integration: roommate.bsky_handle / telegram_handle auto-populate', () => {
  it('seeds bsky_handle on room creation from the admin user identity', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    await seedIdentity(ctx, {
      userId: ADMIN,
      provider: 'bsky',
      providerId: 'did:plc:admin',
      handle: 'creator.bsky.social',
    });
    const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const me = await call(ctx, 'GET', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`);
    expect((me.body as { bskyHandle: string | null }).bskyHandle).toBe('creator.bsky.social');
  });

  it('seeds both bsky and telegram handles when both identities exist', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    await seedIdentity(ctx, {
      userId: ADMIN,
      provider: 'bsky',
      providerId: 'did:plc:admin',
      handle: 'creator.bsky.social',
    });
    await seedIdentity(ctx, {
      userId: ADMIN,
      provider: 'telegram',
      providerId: '12345',
      handle: 'creator_tg',
    });
    const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const me = await call(ctx, 'GET', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`);
    const body = me.body as { bskyHandle: string | null; telegramHandle: string | null };
    expect(body.bskyHandle).toBe('creator.bsky.social');
    expect(body.telegramHandle).toBe('creator_tg');
  });

  it('leaves both columns null when the user has no identities yet', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, STRANGER);
    // loginAs creates the user row but no identities.
    const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const me = await call(ctx, 'GET', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`);
    const body = me.body as { bskyHandle: string | null; telegramHandle: string | null };
    expect(body.bskyHandle).toBeNull();
    expect(body.telegramHandle).toBeNull();
  });

  it('seeds the joiner roommate row on invite-accept', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    await seedIdentity(ctx, {
      userId: ADMIN,
      provider: 'bsky',
      providerId: 'did:plc:admin',
      handle: 'admin.bsky.social',
    });
    const room = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const inv = (await call(ctx, 'POST', `/api/rooms/${room.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inv.inviteUrl.split('/invite/')[1]!;

    await loginAs(ctx, JOINER);
    await seedIdentity(ctx, {
      userId: JOINER,
      provider: 'bsky',
      providerId: 'did:plc:joiner',
      handle: 'joiner.bsky.social',
    });
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      roommateId: string;
    };
    const me = await call(ctx, 'GET', `/api/rooms/${room.room.id}/roommates/${joined.roommateId}`);
    expect((me.body as { bskyHandle: string }).bskyHandle).toBe('joiner.bsky.social');
  });

  it('backfill migration populates pre-existing rows', async () => {
    // The migration runs as part of doubles.createD1, but it has nothing
    // to fill at that point because there are no rows. Verify the SQL
    // itself works by manufacturing a stale (handle=NULL) row paired
    // with an identity, then re-running the UPDATE.
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    await seedIdentity(ctx, {
      userId: ADMIN,
      provider: 'bsky',
      providerId: 'did:plc:admin',
      handle: 'admin.bsky.social',
    });

    // Bypass the autopopulating insert and manufacture a NULL row.
    const created = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    await ctx.env.DB.prepare(
      "UPDATE roommate SET bsky_handle = NULL WHERE id = ?",
    )
      .bind(created.me.roommateId)
      .run();

    // Re-run the backfill UPDATE (idempotent SQL from the migration).
    await ctx.env.DB.prepare(
      `UPDATE roommate
          SET bsky_handle = (
            SELECT i.handle FROM identity i
              WHERE i.user_id = roommate.user_id AND i.provider = 'bsky'
              ORDER BY i.created_at DESC LIMIT 1
          )
        WHERE bsky_handle IS NULL
          AND EXISTS (
            SELECT 1 FROM identity i2
              WHERE i2.user_id = roommate.user_id AND i2.provider = 'bsky'
          )`,
    ).run();

    const me = await call(ctx, 'GET', `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`);
    expect((me.body as { bskyHandle: string }).bskyHandle).toBe('admin.bsky.social');
  });
});
