import { z } from 'zod';

export const auditActionSchema = z.enum([
  'room.create',
  'room.rename',
  'room.invite_created',
  'room.member_joined',
  'room.member_removed',
  'device.claim',
  'device.revoke',
  'roommate.passcode_rotated',
  'roommate.visibility_changed',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  roomId: z.string().uuid().nullable(),
  action: auditActionSchema,
  targetId: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  at: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListSchema = z.object({
  entries: z.array(auditEntrySchema),
  /** Pass back as `?cursor=<string>` to fetch the next page. null = last page. */
  nextCursor: z.string().nullable(),
});
export type AuditList = z.infer<typeof auditListSchema>;

/** Query params for both audit listing endpoints. */
export const auditQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
