import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';
const FRIEND = '00000000-0000-0000-0000-000000000b01';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
  passcode: { passcode: string; shareUrl: string; qrDataUrl: string };
}

describe('integration: room lifecycle', () => {
  it('admin creates a room → gets passcode + share URL ONCE', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);

    const r = await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room 421' },
    });
    expect(r.status).toBe(200);
    const body = r.body as RoomCreated;
    expect(body.room.qrSlug).toMatch(/^[a-z0-9]{10}$/);
    expect(body.passcode.passcode).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(body.passcode.shareUrl).toContain(`#k=${encodeURIComponent(body.passcode.passcode)}`);
    expect(body.passcode.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects creation when the con does not exist', async () => {
    const ctx = newCtx();
    await loginAs(ctx, ADMIN);
    const r = await call(ctx, 'POST', '/api/rooms', {
      body: { conId: '00000000-0000-0000-0000-000000000000', name: 'X' },
    });
    expect(r.status).toBe(404);
  });

  it('admin invites a friend → friend joins → gets own passcode', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);

    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const inviteRes = (await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    expect(inviteRes.inviteUrl).toMatch(/\/invite\//);
    const token = inviteRes.inviteUrl.split('/invite/')[1]!;

    // Switch to FRIEND and consume the invite.
    await loginAs(ctx, FRIEND);
    const joined = await call(ctx, 'POST', '/api/rooms/join', { body: { token } });
    expect(joined.status).toBe(200);
    const j = joined.body as {
      roommateId: string;
      role: string;
      passcode: { passcode: string; shareUrl: string };
    };
    expect(j.role).toBe('member');
    expect(j.passcode.passcode).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);

    // Re-using the same token must fail (one-shot).
    const replay = await call(ctx, 'POST', '/api/rooms/join', { body: { token } });
    expect(replay.status).toBe(409);
  });

  it('membership endpoint lists everyone with display name + role', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const membership = await call(ctx, 'GET', `/api/rooms/${created.room.id}/membership`);
    const members = (membership.body as { members: { role: string }[] }).members;
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('admin');
  });

  it('refuses to remove the last admin', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const r = await call(
      ctx,
      'DELETE',
      `/api/rooms/${created.room.id}/roommates/${created.me.roommateId}`,
    );
    expect(r.status).toBe(409);
  });

  it('member can remove themselves', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const inviteRes = (await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inviteRes.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      roommateId: string;
    };
    const r = await call(
      ctx,
      'DELETE',
      `/api/rooms/${created.room.id}/roommates/${joined.roommateId}`,
    );
    expect(r.status).toBe(200);
  });

  it('rejects a non-admin trying to invite', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const inviteRes = (await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inviteRes.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    await call(ctx, 'POST', '/api/rooms/join', { body: { token } });
    const r = await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`);
    expect(r.status).toBe(403);
  });
});
