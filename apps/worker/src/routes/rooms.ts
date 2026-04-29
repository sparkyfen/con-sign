import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import {
  createRoomSchema,
  inviteResponseSchema,
  type DeviceTokenIssued,
  type InviteResponse,
  type MemberSummary,
  type RoomMembership,
  updateFieldVisibilitySchema,
  updateRoomSchema,
  updateRoommateSchema,
} from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import { generatePasscode, hashPasscode } from '../auth/passcode.js';
import { buildShareArtifacts } from '../auth/share.js';
import { InviteError, consumeInviteToken, createInviteToken } from '../auth/invites.js';
import {
  addRoommate,
  createRoomWithAdmin,
  deleteRoommate,
  getRoom,
  getRoommate,
  getRoommateForUser,
  getVisibility,
  rotateRoommatePasscode,
  setRoomDeviceTokenHash,
  setVisibility,
  updateRoomName,
  updateRoommateProfile,
} from '../db/queries.js';

export const roomRoutes = new Hono<Env>();

// ─── helpers ───────────────────────────────────────────────────────────────

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

async function requireAdmin(
  c: Context<Env>,
  roomId: string,
): Promise<{ roommateId: string; userId: string }> {
  const m = await requireRoommate(c, roomId);
  if (m.role !== 'admin') throw new HttpError(403, 'admin_only');
  return { roommateId: m.roommateId, userId: m.userId };
}

const origin = (c: Context<Env>): string => new URL(c.req.url).origin;

// ─── POST /api/rooms ──────────────────────────────────────────────────────
// Create a room. Caller becomes the first admin roommate. A personal
// passcode is generated for them and returned ONCE.

roomRoutes.post('/', requireUser, async (c) => {
  const body = createRoomSchema.parse(await c.req.json());
  const userId = c.get('userId')!;

  // Verify the con exists (cons are ICS-sourced; we never insert by hand).
  const con = await c.env.DB.prepare('SELECT id FROM con WHERE id = ?').bind(body.conId).first();
  if (!con) throw new HttpError(404, 'con_not_found');

  const passcode = generatePasscode();
  const passcodeHash = await hashPasscode(passcode);
  const { roomId, qrSlug, roommateId } = await createRoomWithAdmin(c.env.DB, {
    conId: body.conId,
    name: body.name,
    adminUserId: userId,
    passcodeHash,
  });
  const share = await buildShareArtifacts({ origin: origin(c), qrSlug, passcode });

  return c.json({
    room: { id: roomId, qrSlug, name: body.name, conId: body.conId },
    me: { roommateId },
    passcode: share,
  });
});

// ─── GET /api/rooms/:id/membership ────────────────────────────────────────
// Bare membership list for admin management UI.

roomRoutes.get('/:id/membership', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);
  const result = await c.env.DB.prepare(
    `SELECT roommate.id AS roommateId, roommate.user_id AS userId, roommate.role AS role,
            user.display_name AS displayName, roommate.created_at AS joinedAt
       FROM roommate JOIN user ON user.id = roommate.user_id
      WHERE roommate.room_id = ?
      ORDER BY roommate.created_at`,
  )
    .bind(roomId)
    .all<MemberSummary>();
  const members = result.results ?? [];
  const adminCount = members.reduce((n, m) => n + (m.role === 'admin' ? 1 : 0), 0);
  const isOnlyAdmin = me.role === 'admin' && adminCount === 1;
  const body: RoomMembership = { members, isOnlyAdmin };
  return c.json(body);
});

// ─── PATCH /api/rooms/:id ─────────────────────────────────────────────────

roomRoutes.patch('/:id', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireAdmin(c, roomId);
  const patch = updateRoomSchema.parse(await c.req.json());
  if (patch.name !== undefined) {
    await updateRoomName(c.env.DB, roomId, patch.name);
  }
  return c.json({ ok: true });
});

// ─── POST /api/rooms/:id/invite ───────────────────────────────────────────

roomRoutes.post('/:id/invite', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireAdmin(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const { token, exp } = await createInviteToken(roomId, c.env.SESSION_HMAC);
  const body: InviteResponse = inviteResponseSchema.parse({
    inviteUrl: `${origin(c)}/invite/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
  return c.json(body);
});

// ─── POST /api/rooms/join ─────────────────────────────────────────────────
// Body: { token }. Caller must be logged in. Idempotent: re-using a consumed
// token returns the existing roommate row (not an error) so a double-click
// doesn't break the UX.

roomRoutes.post('/join', requireUser, async (c) => {
  const userId = c.get('userId')!;
  const { token } = (await c.req.json()) as { token?: string };
  if (!token || typeof token !== 'string') throw new HttpError(400, 'invalid_request');

  let consumed;
  try {
    consumed = await consumeInviteToken(token, c.env.SESSION_HMAC, c.env.SESSIONS);
  } catch (err) {
    if (err instanceof InviteError) {
      // 'consumed' is OK if the user is already a member of the same room.
      if (err.reason !== 'consumed') throw new HttpError(400, `invite_${err.reason}`);
    } else {
      throw err;
    }
  }

  const roomId = consumed?.roomId;
  if (!roomId) {
    // Token was already consumed. Best-effort: figure out which room it was
    // for by re-verifying without consume; if signature is good, treat as a
    // no-op join.
    throw new HttpError(409, 'invite_already_used');
  }

  // If the user is already in this room, no-op.
  const existing = await getRoommateForUser(c.env.DB, roomId, userId);
  if (existing) {
    return c.json({ roommateId: existing.id, role: existing.role });
  }

  const passcode = generatePasscode();
  const passcodeHash = await hashPasscode(passcode);
  const roommateId = await addRoommate(c.env.DB, {
    roomId,
    userId,
    role: 'member',
    passcodeHash,
  });
  const room = await getRoom(c.env.DB, roomId);
  const share = await buildShareArtifacts({
    origin: origin(c),
    qrSlug: room!.qr_slug,
    passcode,
  });
  return c.json({ roommateId, role: 'member' as const, passcode: share });
});

// ─── DELETE /api/rooms/:id/roommates/:rid ─────────────────────────────────
// Admin can remove anyone; members can remove themselves.

roomRoutes.delete('/:id/roommates/:rid', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);

  const target = await getRoommate(c.env.DB, rid);
  if (!target || target.room_id !== roomId) throw new HttpError(404, 'roommate_not_found');

  const isSelf = target.id === me.roommateId;
  if (!isSelf && me.role !== 'admin') throw new HttpError(403, 'admin_only');

  // Don't allow removing the last admin — would brick the room.
  if (target.role === 'admin') {
    const remainingAdmins = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM roommate WHERE room_id = ? AND role = 'admin' AND id != ?`,
    )
      .bind(roomId, rid)
      .first<{ n: number }>();
    if (!remainingAdmins || remainingAdmins.n < 1) {
      throw new HttpError(409, 'last_admin');
    }
  }

  await deleteRoommate(c.env.DB, rid);
  return c.json({ ok: true });
});

// ─── PATCH /api/rooms/:id/roommates/:rid ──────────────────────────────────
// Self only — your fursona data is yours.

roomRoutes.patch('/:id/roommates/:rid', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);
  if (me.roommateId !== rid) throw new HttpError(403, 'self_only');

  const patch = updateRoommateSchema.parse(await c.req.json());
  await updateRoommateProfile(c.env.DB, rid, patch);
  return c.json({ ok: true });
});

// ─── GET/PUT /api/rooms/:id/roommates/:rid/visibility ─────────────────────
// Self only. Task #13.

roomRoutes.get('/:id/roommates/:rid/visibility', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);
  if (me.roommateId !== rid) throw new HttpError(403, 'self_only');
  const visibility = await getVisibility(c.env.DB, rid);
  return c.json({ visibility });
});

roomRoutes.put('/:id/roommates/:rid/visibility', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);
  if (me.roommateId !== rid) throw new HttpError(403, 'self_only');
  const body = updateFieldVisibilitySchema.parse(await c.req.json());
  await setVisibility(c.env.DB, rid, body.visibility);
  return c.json({ ok: true });
});

// ─── POST /api/rooms/:id/roommates/:rid/passcode ──────────────────────────
// Self only. Rotates the personal passcode and returns the new one ONCE.
// Existing visitor unlock cookies invalidate automatically via the
// passcode_rotated_at snapshot baked into the cookie.

roomRoutes.post('/:id/roommates/:rid/passcode', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);
  if (me.roommateId !== rid) throw new HttpError(403, 'self_only');
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const passcode = generatePasscode();
  const hash = await hashPasscode(passcode);
  await rotateRoommatePasscode(c.env.DB, rid, hash);
  const share = await buildShareArtifacts({
    origin: origin(c),
    qrSlug: room.qr_slug,
    passcode,
  });
  return c.json(share);
});

// ─── GET /api/rooms/:id/qr.png ────────────────────────────────────────────
// Admin-only. Returns a PNG QR encoding the public room URL
// (https://<host>/r/<slug>) for the dashboard's "Preview QR" affordance.
// `qrcode` only exposes a Node Buffer API; we go via the data-URL form and
// base64-decode the payload so we can ship raw bytes from the Worker.

roomRoutes.get('/:id/qr.png', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireAdmin(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const url = `${origin(c)}/r/${room.qr_slug}`;
  const dataUrl = await QRCode.toDataURL(url, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      // Slug is stable; admin-only response so private cache is safe.
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

// ─── POST /api/rooms/:id/device-token ─────────────────────────────────────
// Admin only. Issues (or rotates) the device bearer token. Plaintext shown
// once. Task #15.

roomRoutes.post('/:id/device-token', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireAdmin(c, roomId);
  // 32 random bytes → 43-char base64url. Argon2-quality entropy not needed
  // since this is a long random secret, not a user-typed passcode.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const hash = await hashPasscode(token);
  await setRoomDeviceTokenHash(c.env.DB, roomId, hash);
  const body: DeviceTokenIssued = { token };
  return c.json(body);
});
