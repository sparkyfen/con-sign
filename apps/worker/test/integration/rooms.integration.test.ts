import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';
import { app } from '../../src/index.js';
import { SESSION_COOKIE } from '../../src/auth/session.js';
import type { Ctx } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000a01';
const FRIEND = '00000000-0000-0000-0000-000000000b01';

interface RoomCreated {
  room: { id: string; qrSlug: string };
  me: { roommateId: string };
  passcode: { passcode: string; shareUrl: string; qrDataUrl: string };
}

async function fetchBinary(ctx: Ctx, path: string): Promise<Response> {
  const cookie = `${SESSION_COOKIE}=${ctx.cookies.get(SESSION_COOKIE) ?? ''}`;
  const req = new Request(`http://localhost${path}`, { headers: { Cookie: cookie } });
  return app.fetch(req, ctx.env as unknown as Parameters<typeof app.fetch>[1]);
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
    const body = membership.body as { members: { role: string }[]; isOnlyAdmin: boolean };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.role).toBe('admin');
    // Sole admin → flag true so the UI can pre-disable Leave/Remove.
    expect(body.isOnlyAdmin).toBe(true);
  });

  it('isOnlyAdmin is false when another admin exists, and false for members', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;

    // Invite FRIEND as a member.
    const inviteRes = (await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inviteRes.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      roommateId: string;
    };

    // FRIEND is a member: flag must be false (member can never be "only admin").
    const friendView = await call(ctx, 'GET', `/api/rooms/${created.room.id}/membership`);
    expect((friendView.body as { isOnlyAdmin: boolean }).isOnlyAdmin).toBe(false);

    // Promote FRIEND to admin so there are now two admins. ADMIN should
    // observe isOnlyAdmin=false.
    await ctx.env.DB.prepare('UPDATE roommate SET role = ? WHERE id = ?')
      .bind('admin', joined.roommateId)
      .run();
    await loginAs(ctx, ADMIN);
    const adminView = await call(ctx, 'GET', `/api/rooms/${created.room.id}/membership`);
    expect((adminView.body as { isOnlyAdmin: boolean }).isOnlyAdmin).toBe(false);
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

  it('membership/visitor responses never leak passcode plaintext or hashes', async () => {
    // Backs the admin dashboard's masked passcode column (Gap 10): even
    // admins must never see another roommate's plaintext code or PBKDF2 hash
    // in any list/visitor projection. Only the per-roommate rotate endpoint
    // returns plaintext, and only to the row's owner.
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;
    const adminPasscode = created.passcode.passcode;

    // FRIEND joins so the room has two roommates with distinct passcodes.
    const inviteRes = (await call(ctx, 'POST', `/api/rooms/${created.room.id}/invite`)).body as {
      inviteUrl: string;
    };
    const token = inviteRes.inviteUrl.split('/invite/')[1]!;
    await loginAs(ctx, FRIEND);
    const joined = (await call(ctx, 'POST', '/api/rooms/join', { body: { token } })).body as {
      passcode: { passcode: string };
    };
    const friendPasscode = joined.passcode.passcode;
    expect(friendPasscode).not.toBe(adminPasscode);

    // Switch back to ADMIN and pull every list-style endpoint we serve.
    await loginAs(ctx, ADMIN);
    const membership = await call(ctx, 'GET', `/api/rooms/${created.room.id}/membership`);
    const visitor = await call(ctx, 'GET', `/api/r/${created.room.qrSlug}`);

    for (const r of [membership, visitor]) {
      const dump = JSON.stringify(r.body);
      expect(dump).not.toContain(adminPasscode);
      expect(dump).not.toContain(friendPasscode);
      expect(dump).not.toContain('passcode_hash');
      expect(dump).not.toContain('passcodeHash');
    }
  });

  it('serves a room QR PNG to admins, encoding the public room URL', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const created = (await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'Room' },
    })).body as RoomCreated;

    // The shared `call` helper consumes the body as text and breaks on
    // binary; fetch the PNG directly so we can assert raw bytes.
    const res = await fetchBinary(ctx, `/api/rooms/${created.room.id}/qr.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buf = new Uint8Array(await res.arrayBuffer());
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(buf.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buf.byteLength).toBeGreaterThan(200);
  });

  it('refuses room QR to non-admins', async () => {
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

    const r = await call(ctx, 'GET', `/api/rooms/${created.room.id}/qr.png`);
    expect(r.status).toBe(403);
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
