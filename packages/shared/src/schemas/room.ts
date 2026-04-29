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
