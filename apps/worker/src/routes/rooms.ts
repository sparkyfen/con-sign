import { Hono, type Context } from 'hono';
import {
  claimDeviceSchema,
  createRoomSchema,
  deviceListSchema,
  inviteResponseSchema,
  type DeviceList,
  type DeviceSummary,
  type InviteResponse,
  type MemberSummary,
  type Roommate,
  type RoomDetail,
  type RoomList,
  type RoomListItem,
  roomListSchema,
  type RoomMembership,
  updateFieldVisibilitySchema,
  updateRoomSchema,
  updateRoommateSchema,
  roleChangeSchema,
} from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import { generatePasscode, hashPasscode } from '../auth/passcode.js';
import { buildShareArtifacts } from '../auth/share.js';
import { InviteError, consumeInviteToken, createInviteToken } from '../auth/invites.js';
import {
  addRoommate,
  claimDevice,
  createRoomWithAdmin,
  deleteRoommate,
  getRoom,
  getRoomDetail,
  getRoommate,
  getRoommateForUser,
  getVisibility,
  listDevicesForRoom,
  listRoomsForUser,
  listRoommatesForRoom,
  revokeDevice,
  rotateRoommatePasscode,
  roommateRowToApi,
  setRoommateRole,
  setVisibility,
  updateRoomName,
  updateRoommateProfile,
} from '../db/queries.js';
import { consumePairCode } from '../auth/pair-code.js';
import { auditRowToEntry, decodeCursor, listAuditForRoom, recordAudit } from '../db/audit.js';
import { auditQuerySchema, type AuditList } from '@con-sign/shared';

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

/**
 * Reject role-changes / removals that would leave a room with zero
 * admins. The same guard is used by both the role-change endpoint
 * (demoting the last admin) and the delete-roommate endpoint
 * (removing the last admin).
 */
async function assertNotLastAdmin(
  db: D1Database,
  roomId: string,
  excludeRoommateId: string,
): Promise<void> {
  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM roommate WHERE room_id = ? AND role = 'admin' AND id != ?`,
    )
    .bind(roomId, excludeRoommateId)
    .first<{ n: number }>();
  if (!remaining || remaining.n < 1) {
    throw new HttpError(409, 'last_admin');
  }
}

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

  await recordAudit(c.env.DB, {
    actorUserId: userId,
    roomId,
    action: 'room.create',
    targetId: roomId,
    metadata: { name: body.name, conId: body.conId },
  });

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

// ─── GET /api/rooms ───────────────────────────────────────────────────────
// Every room the caller is a member of. Powers the dashboard sidebar.

roomRoutes.get('/', requireUser, async (c) => {
  const userId = c.get('userId')!;
  const rows = await listRoomsForUser(c.env.DB, userId);
  const rooms: RoomListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    qrSlug: r.qr_slug,
    role: r.role,
    conId: r.con_id,
    conName: r.con_name,
    conStartDate: r.con_start_date,
    conEndDate: r.con_end_date,
  }));
  const body: RoomList = roomListSchema.parse({ rooms });
  return c.json(body);
});

// ─── GET /api/rooms/:id ───────────────────────────────────────────────────
// Header data for any in-room dashboard view. Member-only.

roomRoutes.get('/:id', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireRoommate(c, roomId);
  const row = await getRoomDetail(c.env.DB, roomId);
  if (!row) throw new HttpError(404, 'room_not_found');
  const body: RoomDetail = {
    room: {
      id: row.id,
      conId: row.con_id,
      name: row.name,
      qrSlug: row.qr_slug,
      createdAt: row.created_at,
    },
    con: {
      id: row.con_id,
      name: row.con_name,
      startDate: row.con_start_date,
      endDate: row.con_end_date,
      location: row.con_location,
      url: row.con_url,
    },
    myRole: me.role,
  };
  return c.json(body);
});

// ─── GET /api/rooms/:id/roommates/:rid ────────────────────────────────────
// Self can read own row; admin can read anyone in the same room. No privacy
// projection — this is the admin-side fetch that backs the editor UI.

roomRoutes.get('/:id/roommates/:rid', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireRoommate(c, roomId);
  const target = await getRoommate(c.env.DB, rid);
  if (!target || target.room_id !== roomId) throw new HttpError(404, 'roommate_not_found');
  if (target.id !== me.roommateId && me.role !== 'admin') {
    throw new HttpError(403, 'self_or_admin_only');
  }

  // Avatar follows the target user's most-recently-updated identity.
  const identity = await c.env.DB.prepare(
    `SELECT avatar_url FROM identity WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(target.user_id)
    .first<{ avatar_url: string | null }>();

  const body: Roommate = roommateRowToApi(target, identity?.avatar_url ?? null);
  return c.json(body);
});

// ─── GET /api/rooms/:id/audit ─────────────────────────────────────────────
// Audit trail for the room. Member-readable so non-admin members can see
// who let in / removed roommates and managed shared resources. Admin-only
// would hide too much from people who legitimately need to know.

roomRoutes.get('/:id/audit', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireRoommate(c, roomId);
  const q = auditQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const page = await listAuditForRoom(c.env.DB, roomId, { limit: q.limit, cursor });
  const body: AuditList = {
    entries: page.rows.map(auditRowToEntry),
    nextCursor: page.nextCursor,
  };
  return c.json(body);
});

// ─── PATCH /api/rooms/:id ─────────────────────────────────────────────────

roomRoutes.patch('/:id', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireAdmin(c, roomId);
  const patch = updateRoomSchema.parse(await c.req.json());
  if (patch.name !== undefined) {
    const before = await getRoom(c.env.DB, roomId);
    await updateRoomName(c.env.DB, roomId, patch.name);
    await recordAudit(c.env.DB, {
      actorUserId: me.userId,
      roomId,
      action: 'room.rename',
      targetId: roomId,
      metadata: { from: before?.name, to: patch.name },
    });
  }
  return c.json({ ok: true });
});

// ─── POST /api/rooms/:id/invite ───────────────────────────────────────────

roomRoutes.post('/:id/invite', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireAdmin(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const { token, exp } = await createInviteToken(roomId, c.env.SESSION_HMAC);
  const body: InviteResponse = inviteResponseSchema.parse({
    inviteUrl: `${origin(c)}/invite/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.invite_created',
    metadata: { expiresAt: body.expiresAt },
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
  await recordAudit(c.env.DB, {
    actorUserId: userId,
    roomId,
    action: 'room.member_joined',
    targetId: roommateId,
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
    await assertNotLastAdmin(c.env.DB, roomId, rid);
  }

  await deleteRoommate(c.env.DB, rid);
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.member_removed',
    targetId: rid,
    metadata: { self: isSelf, removedRole: target.role },
  });
  return c.json({ ok: true });
});

// ─── POST /api/rooms/:id/roommates/:rid/role ──────────────────────────────
// Admin only. Promote a member → admin, or demote admin → member. The
// last admin can't demote themselves; the server returns 409 instead
// of leaving a room with zero admins.

roomRoutes.post('/:id/roommates/:rid/role', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const rid = c.req.param('rid');
  const me = await requireAdmin(c, roomId);

  const target = await getRoommate(c.env.DB, rid);
  if (!target || target.room_id !== roomId) throw new HttpError(404, 'roommate_not_found');

  const { role: newRole } = roleChangeSchema.parse(await c.req.json());
  const oldRole = target.role;

  // No-op when the role isn't changing — short-circuit before the
  // guard so a redundant click doesn't false-trip last_admin.
  if (oldRole === newRole) return c.json({ ok: true, role: newRole });

  // Demoting an admin: make sure another admin remains.
  if (oldRole === 'admin' && newRole === 'member') {
    await assertNotLastAdmin(c.env.DB, roomId, rid);
  }

  await setRoommateRole(c.env.DB, rid, newRole);
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'roommate.role_changed',
    targetId: rid,
    metadata: { from: oldRole, to: newRole },
  });
  return c.json({ ok: true, role: newRole });
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
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'roommate.visibility_changed',
    targetId: rid,
    metadata: { fields: Object.keys(body.visibility) },
  });
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
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'roommate.passcode_rotated',
    targetId: rid,
  });
  return c.json(share);
});

// ─── Device pairing ───────────────────────────────────────────────────────
//
// Replaces the v0 `device-token` flow. The unpaired panel displays a
// rotating 6-char OTP code; an admin enters that code into the dashboard,
// the server reverse-resolves it to the device's persistent UUID, and
// inserts a `device` row binding the device to this room.

roomRoutes.post('/:id/devices/claim', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireAdmin(c, roomId);

  // Per-user cap. Brute-forcing the 32^6 ≈ 10^9 pair-code keyspace would
  // need millions of requests/sec; 30/min stops that cold while letting a
  // legitimate admin retype a mistyped code.
  const rl = await c.env.CLAIM_RL.limit({ key: `claim:${me.userId}` });
  if (!rl.success) throw new HttpError(429, 'claim_rate_limited');

  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const body = claimDeviceSchema.parse(await c.req.json());
  const deviceId = await consumePairCode(c.env.SESSIONS, body.code);
  if (!deviceId) throw new HttpError(404, 'pair_code_unknown_or_expired');

  // claimDevice mints a fresh api_key bound to the deviceId and opens
  // a short pending window during which the device's next /setup poll
  // can pick it up without already holding an Access-Token. The key
  // itself is delivered to the firmware via /setup, not echoed back
  // here — keeping it out of the admin's network log + browser cache.
  const apiKey = await claimDevice(c.env.DB, { deviceId, roomId });
  if (!apiKey) throw new HttpError(409, 'device_already_claimed');
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'device.claim',
    targetId: deviceId,
  });
  return c.json({ deviceId });
});

roomRoutes.get('/:id/devices', requireUser, async (c) => {
  const roomId = c.req.param('id');
  await requireRoommate(c, roomId);
  const rows = await listDevicesForRoom(c.env.DB, roomId);
  const devices: DeviceSummary[] = rows.map((d) => ({
    id: d.id,
    pairedAt: d.paired_at,
    lastSeenAt: d.last_seen_at,
  }));
  const body: DeviceList = deviceListSchema.parse({ devices });
  return c.json(body);
});

roomRoutes.delete('/:id/devices/:deviceId', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const deviceId = c.req.param('deviceId');
  const me = await requireAdmin(c, roomId);

  // Single round-trip: cross-tenancy check happens in the UPDATE's
  // WHERE clause, so a stranger room's admin can't revoke this device.
  const updated = await revokeDevice(c.env.DB, roomId, deviceId);
  if (!updated) throw new HttpError(404, 'device_not_found');
  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'device.revoke',
    targetId: deviceId,
  });
  return c.json({ ok: true });
});
