import { z } from 'zod';

export const partySchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  name: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  telegramLink: z.string().url().nullable(),
  capacity: z.number().int().positive().nullable(),
  notes: z.string().nullable(),
});
export type Party = z.infer<typeof partySchema>;

export const createPartySchema = partySchema
  .omit({ id: true, roomId: true })
  .partial({ endsAt: true, telegramLink: true, capacity: true, notes: true });
export type CreateParty = z.infer<typeof createPartySchema>;

export const updatePartySchema = createPartySchema.partial();
export type UpdateParty = z.infer<typeof updatePartySchema>;
