import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon, type Ctx } from '../helpers.js';
import type {
  NotePrefsView,
  RoomNotesView,
} from '@con-sign/shared';

const ADMIN = '00000000-0000-0000-0000-000000000aa1';
const FRIEND = '00000000-0000-0000-0000-000000000bb1';
const STRANGER = '00000000-0000-0000-0000-000000000cc1';

interface RoomCreated {
  room: { id: string };
  me: { roommateId: string };
}

async function setupPair(): Promise<{
  ctx: Ctx;
  friendCtx: Ctx;
  strangerCtx: Ctx;
  roomId: string;
  adminRoommateId: string;
  friendRoommateId: string;
}> {
  const ctx = newCtx();
  const conId = await seedCon(ctx);
  await loginAs(ctx, ADMIN);
  const room = (
    await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'Room' } })
  ).body as RoomCreated;

  const inv = (await call(ctx, 'POST', `/api/rooms/${room.room.id}/invite`)).body as {
    inviteUrl: string;
  };
  const token = inv.inviteUrl.split('/invite/')[1]!;

  const friendCtx = newCtx();
  Object.assign(friendCtx.env, ctx.env);
  await loginAs(friendCtx, FRIEND);
  const join = (await call(friendCtx, 'POST', '/api/rooms/join', { body: { token } })).body as {
    roommateId: string;
  };

  const strangerCtx = newCtx();
  Object.assign(strangerCtx.env, ctx.env);
  await loginAs(strangerCtx, STRANGER);

  return {
    ctx,
    friendCtx,
    strangerCtx,
    roomId: room.room.id,
    adminRoommateId: room.me.roommateId,
    friendRoommateId: join.roommateId,
  };
}

describe('integration: room notes (pinned + feed)', () => {
  it('GET returns empty pinned + empty feed for a fresh room', async () => {
    const { ctx, roomId } = await setupPair();
    const r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes`);
    expect(r.status).toBe(200);
    const body = r.body as RoomNotesView;
    expect(body.pinned.body).toBe('');
    expect(body.pinned.updatedAt).toBeNull();
    expect(body.feed).toEqual([]);
    expect(body.feedCap).toBe(50);
  });

  it('PUT pinned stamps body + updater + timestamp; subsequent edits last-write-wins', async () => {
    const { ctx, friendCtx, roomId } = await setupPair();
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notes/pinned`, {
      body: { body: 'Wi-Fi: HiltonGuest / pw: furcon2026' },
    });
    let r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes`);
    let body = r.body as RoomNotesView;
    expect(body.pinned.body).toContain('HiltonGuest');
    expect(body.pinned.updatedByUserId).toBe(ADMIN);

    // Friend's edit overwrites the blob and stamps the new updater.
    await call(friendCtx, 'PUT', `/api/rooms/${roomId}/notes/pinned`, {
      body: { body: 'New Wi-Fi: HiltonGuestNew / pw: confurence' },
    });
    r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes`);
    body = r.body as RoomNotesView;
    expect(body.pinned.body).toContain('HiltonGuestNew');
    expect(body.pinned.updatedByUserId).toBe(FRIEND);
  });

  it('rejects pinned > 1 KB', async () => {
    const { ctx, roomId } = await setupPair();
    const r = await call(ctx, 'PUT', `/api/rooms/${roomId}/notes/pinned`, {
      body: { body: 'x'.repeat(1025) },
    });
    expect(r.status).toBe(400);
  });

  it('POST feed entry appears in GET, newest-first', async () => {
    const { ctx, friendCtx, roomId } = await setupPair();
    await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, { body: { body: 'first' } });
    await call(friendCtx, 'POST', `/api/rooms/${roomId}/notes`, { body: { body: 'second' } });
    const r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes`);
    const body = r.body as RoomNotesView;
    expect(body.feed).toHaveLength(2);
    expect(body.feed[0]?.body).toBe('second');
    expect(body.feed[1]?.body).toBe('first');
    expect(body.feed[0]?.authorUserId).toBe(FRIEND);
    expect(body.feed[1]?.authorUserId).toBe(ADMIN);
  });

  it('rejects feed entry > 280 chars', async () => {
    const { ctx, roomId } = await setupPair();
    const r = await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'x'.repeat(281) },
    });
    expect(r.status).toBe(400);
  });

  it('feed cap at 50: the 51st insert evicts the oldest', async () => {
    const { ctx, roomId } = await setupPair();
    for (let i = 0; i < 51; i++) {
      const r = await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, {
        body: { body: `msg ${i}` },
      });
      expect(r.status).toBe(200);
    }
    const r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes`);
    const body = r.body as RoomNotesView;
    expect(body.feed).toHaveLength(50);
    // Oldest (`msg 0`) should be gone; newest (`msg 50`) is present.
    expect(body.feed.find((e) => e.body === 'msg 0')).toBeUndefined();
    expect(body.feed[0]?.body).toBe('msg 50');
  });

  it('canDelete is true for author and admin, false otherwise', async () => {
    const { ctx, friendCtx, roomId } = await setupPair();
    await call(friendCtx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'friend post' },
    });
    // Admin sees canDelete = true (admin can delete anyone's).
    const adminView = (await call(ctx, 'GET', `/api/rooms/${roomId}/notes`))
      .body as RoomNotesView;
    expect(adminView.feed[0]?.canDelete).toBe(true);
    // Author sees canDelete = true on own.
    const authorView = (await call(friendCtx, 'GET', `/api/rooms/${roomId}/notes`))
      .body as RoomNotesView;
    expect(authorView.feed[0]?.canDelete).toBe(true);

    // Admin posts; friend (member, not author) should see canDelete=false.
    await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, { body: { body: 'admin post' } });
    const memberView = (await call(friendCtx, 'GET', `/api/rooms/${roomId}/notes`))
      .body as RoomNotesView;
    const adminPost = memberView.feed.find((e) => e.body === 'admin post');
    expect(adminPost?.canDelete).toBe(false);
  });

  it('DELETE: author deletes own; admin deletes any; member cannot delete others', async () => {
    const { ctx, friendCtx, roomId } = await setupPair();
    // Friend posts two entries.
    const post1 = await call(friendCtx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'first' },
    });
    const post2 = await call(friendCtx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'second' },
    });
    const id1 = (post1.body as { noteId: string }).noteId;
    const id2 = (post2.body as { noteId: string }).noteId;

    // Author deletes own.
    const authorDel = await call(friendCtx, 'DELETE', `/api/rooms/${roomId}/notes/${id1}`);
    expect(authorDel.status).toBe(200);

    // Admin posts one; friend (member) can't delete it.
    const adminPost = await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'admin' },
    });
    const adminPostId = (adminPost.body as { noteId: string }).noteId;
    const memberDelOther = await call(friendCtx, 'DELETE', `/api/rooms/${roomId}/notes/${adminPostId}`);
    expect(memberDelOther.status).toBe(403);

    // Admin deletes friend's remaining post.
    const adminDel = await call(ctx, 'DELETE', `/api/rooms/${roomId}/notes/${id2}`);
    expect(adminDel.status).toBe(200);
  });

  it('non-members get 403 on every notes route', async () => {
    const { strangerCtx, roomId, friendRoommateId } = await setupPair();
    const r1 = await call(strangerCtx, 'GET', `/api/rooms/${roomId}/notes`);
    expect(r1.status).toBe(403);
    const r2 = await call(strangerCtx, 'PUT', `/api/rooms/${roomId}/notes/pinned`, {
      body: { body: 'pwned' },
    });
    expect(r2.status).toBe(403);
    const r3 = await call(strangerCtx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'pwned' },
    });
    expect(r3.status).toBe(403);
    const r4 = await call(
      strangerCtx,
      'PUT',
      `/api/rooms/${roomId}/notes/notifications/${friendRoommateId}`,
      { body: { enabled: true } },
    );
    expect(r4.status).toBe(403);
  });

  it('audit: pinned edits write room.pinned_note_edited; feed posts do not', async () => {
    const { ctx, roomId } = await setupPair();
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notes/pinned`, {
      body: { body: 'allergies: tree nuts' },
    });
    await call(ctx, 'POST', `/api/rooms/${roomId}/notes`, { body: { body: 'hi' } });
    const counts = await ctx.env.DB.prepare(
      `SELECT
         SUM(action = 'room.pinned_note_edited') AS pinned,
         SUM(action = 'room.note_deleted') AS deleted,
         (SELECT COUNT(*) FROM audit_log WHERE action = 'room.note_created') AS created
       FROM audit_log`,
    ).first<{ pinned: number; deleted: number; created: number }>();
    expect(counts?.pinned).toBe(1);
    expect(counts?.created).toBe(0);
    expect(counts?.deleted).toBe(0);
  });

  it('audit: delete writes room.note_deleted with author metadata', async () => {
    const { ctx, friendCtx, roomId } = await setupPair();
    const post = await call(friendCtx, 'POST', `/api/rooms/${roomId}/notes`, {
      body: { body: 'gonna get deleted' },
    });
    const noteId = (post.body as { noteId: string }).noteId;
    await call(ctx, 'DELETE', `/api/rooms/${roomId}/notes/${noteId}`);
    const row = await ctx.env.DB.prepare(
      `SELECT metadata_json FROM audit_log WHERE action = 'room.note_deleted'`,
    ).first<{ metadata_json: string }>();
    expect(row?.metadata_json).toContain(`"self":false`);
    expect(row?.metadata_json).toContain(FRIEND);
  });
});

describe('integration: room note notifications (per-source-roommate prefs)', () => {
  it('GET returns one row per OTHER roommate, defaulting enabled=false', async () => {
    const { ctx, friendRoommateId, roomId } = await setupPair();
    const r = await call(ctx, 'GET', `/api/rooms/${roomId}/notes/notifications`);
    expect(r.status).toBe(200);
    const body = r.body as NotePrefsView;
    // Admin sees friend; never sees self.
    expect(body.prefs).toHaveLength(1);
    expect(body.prefs[0]?.sourceRoommateId).toBe(friendRoommateId);
    expect(body.prefs[0]?.enabled).toBe(false);
  });

  it('PUT upserts a toggle; subsequent GET reflects it', async () => {
    const { ctx, friendRoommateId, roomId } = await setupPair();
    const put = await call(
      ctx,
      'PUT',
      `/api/rooms/${roomId}/notes/notifications/${friendRoommateId}`,
      { body: { enabled: true } },
    );
    expect(put.status).toBe(200);
    let view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notes/notifications`))
      .body as NotePrefsView;
    expect(view.prefs[0]?.enabled).toBe(true);

    // Toggle off — upsert path.
    await call(
      ctx,
      'PUT',
      `/api/rooms/${roomId}/notes/notifications/${friendRoommateId}`,
      { body: { enabled: false } },
    );
    view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notes/notifications`))
      .body as NotePrefsView;
    expect(view.prefs[0]?.enabled).toBe(false);
  });

  it('PUT 404s when the source roommate is not in this room', async () => {
    const { ctx, roomId } = await setupPair();
    const r = await call(
      ctx,
      'PUT',
      `/api/rooms/${roomId}/notes/notifications/00000000-0000-0000-0000-deadbeefcafe`,
      { body: { enabled: true } },
    );
    expect(r.status).toBe(404);
  });

  it('prefs are per-recipient: friend sees admin in their list, not themselves', async () => {
    const { friendCtx, adminRoommateId, roomId } = await setupPair();
    const view = (await call(friendCtx, 'GET', `/api/rooms/${roomId}/notes/notifications`))
      .body as NotePrefsView;
    expect(view.prefs).toHaveLength(1);
    expect(view.prefs[0]?.sourceRoommateId).toBe(adminRoommateId);
  });
});
