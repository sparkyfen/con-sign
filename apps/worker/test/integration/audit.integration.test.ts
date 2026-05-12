import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';
const FRIEND = '00000000-0000-0000-0000-000000000a02';
const STRANGER = '00000000-0000-0000-0000-000000000a03';
const DEVICE = '11111111-1111-1111-1111-111111111111';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
}

interface AuditEntryShape {
  action: string;
  targetId: string | null;
  actorUserId: string | null;
  metadata: Record<string, unknown> | null;
}

const actions = (entries: AuditEntryShape[]): string[] => entries.map((e) => e.action);

describe('integration: audit log', () => {
  it('records the full Level-3 action set across a room lifecycle', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);

    // 1. room.create
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;

    // 2. room.rename
    await call(ctx, 'PATCH', `/api/rooms/${r.room.id}`, { body: { name: 'R2' } });

    // 3. roommate.visibility_changed (admin's own row)
    await call(ctx, 'PUT', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}/visibility`, {
      body: { visibility: { fursona_name: 'guest' } },
    });

    // 4. roommate.passcode_rotated (admin's own row)
    await call(ctx, 'POST', `/api/rooms/${r.room.id}/roommates/${r.me.roommateId}/passcode`);

    // 5. room.invite_created + 6. room.member_joined
    const inv = (await call(ctx, 'POST', `/api/rooms/${r.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inv.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      roommateId: string;
    };

    // 7. device.claim
    await loginAs(ctx, ADMIN);
    await call(ctx, 'GET', '/api/device/sign.png', {
      headers: { Authorization: `Bearer ${DEVICE}` },
    });
    const code = (await ctx.env.SESSIONS.get(`pair:dev:${DEVICE}`))!;
    await call(ctx, 'POST', `/api/rooms/${r.room.id}/devices/claim`, { body: { code } });

    // 8. device.revoke
    await call(ctx, 'DELETE', `/api/rooms/${r.room.id}/devices/${DEVICE}`);

    // 9. room.member_removed
    await call(ctx, 'DELETE', `/api/rooms/${r.room.id}/roommates/${joined.roommateId}`);

    const trail = await call(ctx, 'GET', `/api/rooms/${r.room.id}/audit`);
    expect(trail.status).toBe(200);
    const entries = (trail.body as { entries: AuditEntryShape[] }).entries;
    // DESC by `at`; assert as a set since same-millisecond writes can swap.
    expect(actions(entries).sort()).toEqual(
      [
        'room.create',
        'room.rename',
        'roommate.visibility_changed',
        'roommate.passcode_rotated',
        'room.invite_created',
        'room.member_joined',
        'device.claim',
        'device.revoke',
        'room.member_removed',
      ].sort(),
    );
  });

  it('GET /api/rooms/:id/audit is member-readable, not admin-only', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const inv = (await call(ctx, 'POST', `/api/rooms/${r.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inv.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    await call(ctx, 'POST', '/api/rooms/join', { body: { token } });

    const trail = await call(ctx, 'GET', `/api/rooms/${r.room.id}/audit`);
    expect(trail.status).toBe(200);
  });

  it('GET /api/rooms/:id/audit 403s for strangers', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    await loginAs(ctx, STRANGER);
    const trail = await call(ctx, 'GET', `/api/rooms/${r.room.id}/audit`);
    expect(trail.status).toBe(403);
  });

  it('GET /api/me/audit returns only the caller’s own actions, across rooms', async () => {
    const ctx = newCtx();
    const con1 = await seedCon(ctx);
    const con2 = await seedCon(ctx, { name: 'Other' });
    await loginAs(ctx, ADMIN);
    await call(ctx, 'POST', '/api/rooms', { body: { conId: con1, name: 'A' } });
    await call(ctx, 'POST', '/api/rooms', { body: { conId: con2, name: 'B' } });

    // Friend creates their own room — should NOT show up under ADMIN's /me/audit.
    await loginAs(ctx, FRIEND);
    await call(ctx, 'POST', '/api/rooms', { body: { conId: con1, name: 'C' } });

    await loginAs(ctx, ADMIN);
    const mine = await call(ctx, 'GET', '/api/me/audit');
    expect(mine.status).toBe(200);
    const entries = (mine.body as { entries: AuditEntryShape[] }).entries;
    expect(entries.every((e) => e.actorUserId === ADMIN)).toBe(true);
    expect(entries.filter((e) => e.action === 'room.create')).toHaveLength(2);
  });

  it('paginates room audit via cursor (limit + nextCursor)', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;

    // Pump 25 rename actions so we have a healthy dataset.
    for (let i = 0; i < 25; i++) {
      await call(ctx, 'PATCH', `/api/rooms/${r.room.id}`, { body: { name: `R-${i}` } });
    }

    const page1 = await call(ctx, 'GET', `/api/rooms/${r.room.id}/audit?limit=10`);
    expect(page1.status).toBe(200);
    const b1 = page1.body as { entries: AuditEntryShape[]; nextCursor: string | null };
    expect(b1.entries).toHaveLength(10);
    expect(b1.nextCursor).toBeTruthy();

    const page2 = await call(
      ctx,
      'GET',
      `/api/rooms/${r.room.id}/audit?limit=10&cursor=${encodeURIComponent(b1.nextCursor!)}`,
    );
    const b2 = page2.body as { entries: AuditEntryShape[]; nextCursor: string | null };
    expect(b2.entries).toHaveLength(10);
    // No overlap between the two pages.
    const ids1 = new Set(b1.entries.map((e) => (e as unknown as { id: string }).id));
    for (const e of b2.entries) {
      expect(ids1.has((e as unknown as { id: string }).id)).toBe(false);
    }

    // Last page (25 renames + 1 create = 26 rows) — should be 6 entries and
    // nextCursor=null.
    const page3 = await call(
      ctx,
      'GET',
      `/api/rooms/${r.room.id}/audit?limit=10&cursor=${encodeURIComponent(b2.nextCursor!)}`,
    );
    const b3 = page3.body as { entries: AuditEntryShape[]; nextCursor: string | null };
    expect(b3.entries.length).toBeLessThan(10);
    expect(b3.nextCursor).toBeNull();
  });

  it('rejects an invalid limit', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = (await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } }))
      .body as RoomCreated;
    const bad = await call(ctx, 'GET', `/api/rooms/${r.room.id}/audit?limit=999`);
    expect(bad.status).toBe(400);
  });

  it('audit write failures do not break the underlying request', async () => {
    // Sabotage the audit_log table; room.create should still succeed.
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    await ctx.env.DB.prepare('DROP TABLE audit_log').run();

    const r = await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } });
    expect(r.status).toBe(200);
  });
});
