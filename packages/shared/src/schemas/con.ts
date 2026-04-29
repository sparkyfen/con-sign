import { z } from 'zod';

export const conSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  location: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type Con = z.infer<typeof conSchema>;

export const conSearchQuerySchema = z.object({
  q: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ConSearchQuery = z.infer<typeof conSearchQuerySchema>;
