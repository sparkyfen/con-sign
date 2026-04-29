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

export const inviteResponseSchema = z.object({
  inviteUrl: z.string().url(),
  expiresAt: z.string(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

export const deviceTokenIssuedSchema = z.object({
  token: z.string(),
});
export type DeviceTokenIssued = z.infer<typeof deviceTokenIssuedSchema>;

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
});
export type RoomMembership = z.infer<typeof roomMembershipSchema>;
