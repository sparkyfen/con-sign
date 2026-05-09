import { z } from 'zod';
import { roommateSchema } from './roommate.js';

export const roomSchema = z.object({
  id: z.string().uuid(),
  conId: z.string().uuid(),
  name: z.string(),
  qrSlug: z.string(),
  createdAt: z.string(),
});
export type Room = z.infer<typeof roomSchema>;

export const createRoomSchema = z.object({
  conId: z.string().uuid(),
  name: z.string().min(1).max(100),
});
export type CreateRoom = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});
export type UpdateRoom = z.infer<typeof updateRoomSchema>;

/**
 * Visitor-facing projected view of a room. Each roommate has been passed
 * through `projectRoommate` already, so fields the viewer is not authorized
 * to see are simply absent (not present-as-null).
 */
export const projectedRoommateSchema = roommateSchema
  .pick({ id: true, role: true })
  .extend({
    fursonaName: z.string().optional(),
    fursonaSpecies: z.string().optional(),
    pronouns: z.string().optional(),
    bskyHandle: z.string().optional(),
    telegramHandle: z.string().optional(),
    avatarUrl: z.string().url().optional(),
    status: z
      .object({ label: z.string(), updatedAt: z.string().optional() })
      .optional(),
  });
export type ProjectedRoommate = z.infer<typeof projectedRoommateSchema>;

export const visitorRoomViewSchema = z.object({
  room: z.object({
    id: z.string().uuid(),
    name: z.string(),
    qrSlug: z.string(),
    con: z.object({ id: z.string().uuid(), name: z.string() }),
  }),
  roommates: z.array(projectedRoommateSchema),
  unlockedRoommateIds: z.array(z.string().uuid()),
  turnstileRequired: z.boolean(),
});
export type VisitorRoomView = z.infer<typeof visitorRoomViewSchema>;

/** A row in the dashboard's room list. Joins con + caller's role. */
export const roomListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  qrSlug: z.string(),
  role: z.enum(['admin', 'member']),
  conId: z.string().uuid(),
  conName: z.string(),
  conStartDate: z.string().nullable(),
  conEndDate: z.string().nullable(),
});
export type RoomListItem = z.infer<typeof roomListItemSchema>;

export const roomListSchema = z.object({
  rooms: z.array(roomListItemSchema),
});
export type RoomList = z.infer<typeof roomListSchema>;

/** Single room detail — header data for any in-room dashboard view. */
export const roomDetailSchema = z.object({
  room: roomSchema,
  con: z.object({
    id: z.string().uuid(),
    name: z.string(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string().url().nullable(),
  }),
  myRole: z.enum(['admin', 'member']),
});
export type RoomDetail = z.infer<typeof roomDetailSchema>;

export const inviteResponseSchema = z.object({
  inviteUrl: z.string().url(),
  expiresAt: z.string(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

// ─── devices ──────────────────────────────────────────────────────────────

/** Admin-entered code from the unpaired panel. Accepts spaces / lowercase;
 *  the server normalizes. Six alphanumeric chars, ambiguity-safe alphabet. */
export const claimDeviceSchema = z.object({
  code: z.string().min(6).max(20),
});
export type ClaimDevice = z.infer<typeof claimDeviceSchema>;

export const deviceSummarySchema = z.object({
  id: z.string(),
  pairedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceListSchema = z.object({
  devices: z.array(deviceSummarySchema),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

/**
 * Bare membership row used for admin management UI. Always returned for all
 * roommates regardless of their per-field visibility — admins need to know
 * who is in the room to manage them, but they see only identity, not fursona
 * data.
 */
export const memberSummarySchema = z.object({
  roommateId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member']),
  displayName: z.string(),
  joinedAt: z.string(),
});
export type MemberSummary = z.infer<typeof memberSummarySchema>;

export const roomMembershipSchema = z.object({
  members: z.array(memberSummarySchema),
  // True iff the requesting user is an admin AND no other admin exists in
  // the room. Lets the UI pre-disable Leave/Remove instead of letting the
  // last-admin guard fail at click time.
  isOnlyAdmin: z.boolean(),
});
export type RoomMembership = z.infer<typeof roomMembershipSchema>;
