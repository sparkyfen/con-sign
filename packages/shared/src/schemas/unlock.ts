import { z } from 'zod';

export const unlockRequestSchema = z.object({
  passcode: z.string().min(4).max(64),
  turnstileToken: z.string().optional(),
});
export type UnlockRequest = z.infer<typeof unlockRequestSchema>;

export const unlockResponseSchema = z.object({
  unlockedRoommateIds: z.array(z.string().uuid()),
  matched: z.boolean(),
  turnstileRequired: z.boolean(),
});
export type UnlockResponse = z.infer<typeof unlockResponseSchema>;
