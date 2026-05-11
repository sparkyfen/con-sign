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
});
export type AuditList = z.infer<typeof auditListSchema>;
