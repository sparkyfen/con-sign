import { z } from 'zod';

export const statusPresetSchema = z.enum([
  'room',
  'lobby',
  'dealers',
  'panels',
  'out',
  'asleep',
]);
export type StatusPreset = z.infer<typeof statusPresetSchema>;

export const statusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), preset: statusPresetSchema }),
  z.object({ kind: z.literal('custom'), text: z.string().min(1).max(140) }),
]);
export type Status = z.infer<typeof statusSchema>;

/**
 * The full roommate record as held server-side. The visitor view never sees
 * this directly — it goes through `projectRoommate` first.
 */
export const roommateSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member']),

  fursonaName: z.string().nullable(),
  fursonaSpecies: z.string().nullable(),
  pronouns: z.string().nullable(),
  bskyHandle: z.string().nullable(),
  telegramHandle: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),

  status: statusSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),

  createdAt: z.string(),
});
export type Roommate = z.infer<typeof roommateSchema>;

/**
 * Update payload for a roommate's own profile. All fields optional; nullable
 * to allow clearing.
 */
export const updateRoommateSchema = roommateSchema
  .pick({
    fursonaName: true,
    fursonaSpecies: true,
    pronouns: true,
    bskyHandle: true,
    telegramHandle: true,
  })
  .partial()
  .extend({
    status: statusSchema.nullable().optional(),
  });
export type UpdateRoommate = z.infer<typeof updateRoommateSchema>;

/**
 * Returned exactly once when a passcode is generated or rotated. After this
 * response the plaintext is unrecoverable.
 *
 * `qrDataUrl` is a Cloudflare-Worker-friendly SVG data URL (no Buffer / no
 * pngjs); the frontend can render it directly with <img src=...>.
 */
export const passcodeIssuedSchema = z.object({
  passcode: z.string(),
  shareUrl: z.string().url(),
  qrDataUrl: z.string(),
});
export type PasscodeIssued = z.infer<typeof passcodeIssuedSchema>;
