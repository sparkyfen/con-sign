import { z } from 'zod';

export const sessionUserSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  identities: z.array(
    z.object({
      provider: z.enum(['bsky', 'telegram']),
      handle: z.string().nullable(),
      avatarUrl: z.string().url().nullable(),
    }),
  ),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Payload posted by the Telegram Login Widget. The full set is hashed
 * (sans `hash`) with the bot token to verify on the server.
 */
export const telegramLoginPayloadSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().url().optional(),
  auth_date: z.number(),
  hash: z.string(),
});
export type TelegramLoginPayload = z.infer<typeof telegramLoginPayloadSchema>;
