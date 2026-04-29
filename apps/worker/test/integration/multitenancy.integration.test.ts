import { describe, expect, it } from 'vitest';
import type { VisitorRoomView } from '@con-sign/shared';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';

describe('integration: multi-tenancy isolation', () => {
  it('two rooms in two cons do not leak roommates between each other', async () => {
    const ctx = newCtx();
    const conA = await seedCon(ctx, { name: 'Con A' });
    const conB = await seedCon(ctx, { name: 'Con B' });
    await loginAs(ctx, ADMIN);

    const roomA = (await call(ctx, 'POST', '/api/rooms', { body: { conId: conA, name: 'A' } }))
      .body as { room: { id: string; qrSlug: string }; me: { roommateId: string } };
    const roomB = (await call(ctx, 'POST', '/api/rooms', { body: { conId: conB, name: 'B' } }))
      .body as { room: { id: string; qrSlug: string }; me: { roommateId: string } };

    // Set guest-visible name on each so the visitor view returns something.
    for (const r of [roomA, roomB]) {
      await call(ctx, 'PATCH', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}`, {
        body: { fursonaName: `name-${r.room.id.slice(0, 4)}` },
      });
      await call(ctx, 'PUT', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}/visibility`, {
        body: { visibility: { fursona_name: 'guest' } },
      });
    }

    // Fresh visitors hit each slug; they must see only their own room.
    const visitorA = newCtx();
    Object.assign(visitorA.env, ctx.env);
    const viewA = (await call(visitorA, 'GET', `/api/r/${roomA.room.qrSlug}`))
      .body as VisitorRoomView;
    expect(viewA.room.id).toBe(roomA.room.id);
    expect(viewA.roommates).toHaveLength(1);
    expect(viewA.roommates[0]?.id).toBe(roomA.me.roommateId);

    const visitorB = newCtx();
    Object.assign(visitorB.env, ctx.env);
    const viewB = (await call(visitorB, 'GET', `/api/r/${roomB.room.qrSlug}`))
      .body as VisitorRoomView;
    expect(viewB.room.id).toBe(roomB.room.id);
    expect(viewB.roommates).toHaveLength(1);
    expect(viewB.roommates[0]?.id).toBe(roomB.me.roommateId);
  });

  it('a passcode for room A does not unlock room B', async () => {
    const ctx = newCtx();
    const conA = await seedCon(ctx, { name: 'A' });
    const conB = await seedCon(ctx, { name: 'B' });
    await loginAs(ctx, ADMIN);

    const a = (await call(ctx, 'POST', '/api/rooms', { body: { conId: conA, name: 'A' } })).body as {
      room: { qrSlug: string };
      passcode: { passcode: string };
    };
    const b = (await call(ctx, 'POST', '/api/rooms', { body: { conId: conB, name: 'B' } })).body as {
      room: { qrSlug: string };
    };

    // Try A's passcode on B's slug.
    const visitor = newCtx();
    Object.assign(visitor.env, ctx.env);
    const u = await call(visitor, 'POST', `/api/r/${b.room.qrSlug}/unlock`, {
      body: { passcode: a.passcode.passcode },
    });
    expect(u.status).toBe(401);
    expect((u.body as { matched: boolean }).matched).toBe(false);
  });
});
