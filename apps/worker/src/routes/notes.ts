/**
 * `/api/rooms/:id/notes/*` — the in-room notes surface.
 *
 * Two surfaces per room (see PLAN.md "Roommate-to-roommate notes"):
 *   - Pinned blob (wiki-style, last-edit-wins) — at most one per room.
 *   - Feed of transient entries — capped at 50, oldest TTLs out.
 *
 * Plus per-(recipient, source-roommate) notification toggles for the
 * "ping me when X posts" preferences. The DM pipe doesn't fire yet
 * (it ships with the broader Admin-Notifications work); these routes
 * persist the prefs so the UI is functional from day one.
 *
 * All routes require the caller to be a roommate of the room
 * (`requireRoommate`). Visitors never reach this surface.
 */

import { Hono, type Context } from 'hono';
import {
  notePrefUpdateSchema,
  pinnedNoteUpdateSchema,
  roomNoteCreateSchema,
  type NotePrefEntry,
  type NotePrefsView,
  type RoomNoteEntry,
  type RoomNotesView,
} from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import {
  FEED_CAP,
  createRoomNote,
  deleteRoomNote,
  getPinnedNote,
  getRoom,
  getRoomNote,
  getRoommateForUser,
  listRoomNotePrefs,
  listRoomNotes,
  listRoommatesForRoom,
  setPinnedNote,
  upsertNotePref,
} from '../db/queries.js';
import { recordAudit } from '../db/audit.js';

export const noteRoutes = new Hono<Env>();

async function requireRoommate(
  c: Context<Env>,
  roomId: string,
): Promise<{ roommateId: string; role: 'admin' | 'member'; userId: string }> {
  const userId = c.get('userId');
  if (!userId) throw new HttpError(401, 'unauthenticated');
  const me = await getRoommateForUser(c.env.DB, roomId, userId);
  if (!me) throw new HttpError(403, 'not_a_member');
  return { roommateId: me.id, role: me.role, userId };
}

// ─── GET /api/rooms/:id/notes ──────────────────────────────────────────────
// Pinned blob + feed in one shot. Newest-first feed, capped at FEED_CAP.

noteRoutes.get('/:id/notes', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);

  const [pinned, feedRows] = await Promise.all([
    getPinnedNote(c.env.DB, roomId),
    listRoomNotes(c.env.DB, roomId),
  ]);
  if (!pinned) throw new HttpError(404, 'room_not_found');

  const feed: RoomNoteEntry[] = feedRows.map((r) => ({
    id: r.id,
    authorUserId: r.author_user_id,
    authorDisplayName: r.author_display_name,
    body: r.body,
    createdAt: r.created_at,
    // Author or admin can delete. UI uses this to gate the ⋯ menu item.
    canDelete: r.author_user_id === me.userId || me.role === 'admin',
  }));

  const body: RoomNotesView = {
    pinned: {
      body: pinned.body ?? '',
      updatedByUserId: pinned.updated_by_user_id,
      updatedByDisplayName: pinned.updated_by_display_name,
      updatedAt: pinned.updated_at,
    },
    feed,
    feedCap: FEED_CAP,
  };
  return c.json(body);
});

// ─── PUT /api/rooms/:id/notes/pinned ───────────────────────────────────────
// Last-edit-wins on the pinned blob. Any roommate can edit.

noteRoutes.put('/:id/notes/pinned', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const patch = pinnedNoteUpdateSchema.parse(await c.req.json());
  await setPinnedNote(c.env.DB, { roomId, userId: me.userId, body: patch.body });

  // Audit-worthy: pinned info tends to encode shared trust (Wi-Fi
  // password, allergies). Keep the trail without recording the body.
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.pinned_note_edited',
    metadata: { length: patch.body.length },
  });
  return c.json({ ok: true });
});

// ─── POST /api/rooms/:id/notes ─────────────────────────────────────────────
// Append a feed entry; DB-side batch also TTLs the oldest beyond FEED_CAP.

noteRoutes.post('/:id/notes', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const { body } = roomNoteCreateSchema.parse(await c.req.json());
  const noteId = await createRoomNote(c.env.DB, {
    roomId,
    authorUserId: me.userId,
    body,
  });
  // Deliberately NOT audit-logged: feed entries are conversational and
  // would drown the audit table during a busy con weekend.
  return c.json({ ok: true, noteId });
});

// ─── DELETE /api/rooms/:id/notes/:noteId ───────────────────────────────────
// Author or room admin only.

noteRoutes.delete('/:id/notes/:noteId', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const noteId = c.req.param('noteId');
  const me = await requireRoommate(c, roomId);

  const note = await getRoomNote(c.env.DB, noteId);
  if (!note || note.room_id !== roomId) throw new HttpError(404, 'note_not_found');

  const isAuthor = note.author_user_id === me.userId;
  if (!isAuthor && me.role !== 'admin') throw new HttpError(403, 'forbidden');

  await deleteRoomNote(c.env.DB, noteId);
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.note_deleted',
    targetId: noteId,
    metadata: { self: isAuthor, authorUserId: note.author_user_id },
  });
  return c.json({ ok: true });
});

// ─── GET /api/rooms/:id/notes/notifications ────────────────────────────────
// Per-source-roommate toggle list for the calling roommate. Always
// returns one row per OTHER roommate in the room (defaulting enabled=false
// when no pref row exists yet) so the UI can render the full set without
// special-casing "missing pref" client-side.

noteRoutes.get('/:id/notes/notifications', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);

  const [members, existing] = await Promise.all([
    listRoommatesForRoom(c.env.DB, roomId),
    listRoomNotePrefs(c.env.DB, { recipientUserId: me.userId, roomId }),
  ]);

  const enabledBySourceRoommate = new Map<string, boolean>();
  for (const row of existing) {
    if (row.source_roommate_id) {
      enabledBySourceRoommate.set(row.source_roommate_id, row.enabled === 1);
    }
  }

  const prefs: NotePrefEntry[] = members
    .filter(({ row }) => row.user_id !== me.userId) // never list yourself
    .map(({ row }) => ({
      sourceRoommateId: row.id,
      sourceDisplayName: row.fursona_name ?? 'Roommate',
      enabled: enabledBySourceRoommate.get(row.id) ?? false,
    }));

  const body: NotePrefsView = { prefs };
  return c.json(body);
});

// ─── PUT /api/rooms/:id/notes/notifications/:sourceRoommateId ──────────────
// Upsert one toggle. Caller must be a member of the room AND the source
// roommate must also be in the room (cross-room prefs are nonsense and
// would let one room's member persist rows for another room).

noteRoutes.put('/:id/notes/notifications/:sourceRoommateId', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const sourceRoommateId = c.req.param('sourceRoommateId');
  const me = await requireRoommate(c, roomId);

  // Validate that source belongs to this room. Cheap one-row lookup;
  // the listRoommatesForRoom helper would over-fetch here.
  const source = await c.env.DB.prepare(
    'SELECT id FROM roommate WHERE id = ? AND room_id = ?',
  )
    .bind(sourceRoommateId, roomId)
    .first<{ id: string }>();
  if (!source) throw new HttpError(404, 'source_roommate_not_in_room');

  const { enabled } = notePrefUpdateSchema.parse(await c.req.json());
  await upsertNotePref(c.env.DB, {
    recipientUserId: me.userId,
    roomId,
    sourceRoommateId,
    enabled,
  });
  // No audit row — notification prefs are personal, change frequently,
  // and would just noise up the audit table.
  return c.json({ ok: true });
});
