import { z } from 'zod';

/**
 * Privacy tiers, ordered from most-public to most-private.
 *
 * - `guest`    : visible to anyone who scanned the door QR (no passcode needed)
 * - `personal` : visible only to viewers who entered THIS roommate's passcode
 * - `private`  : never returned to any visitor (only the roommate themselves)
 */
export const tierSchema = z.enum(['guest', 'personal', 'private']);
export type Tier = z.infer<typeof tierSchema>;

/**
 * The set of roommate fields whose visibility can be configured. Adding a new
 * field is two steps: add it here and read from it in the projection. No
 * schema migration required.
 */
export const visibleFieldNameSchema = z.enum([
  'fursona_name',
  'fursona_species',
  'pronouns',
  'bsky_handle',
  'telegram_handle',
  'avatar_url',
  'status',
]);
export type VisibleFieldName = z.infer<typeof visibleFieldNameSchema>;

export const fieldVisibilitySchema = z.record(visibleFieldNameSchema, tierSchema);
export type FieldVisibility = z.infer<typeof fieldVisibilitySchema>;

/**
 * Default tier applied when a field has no explicit row in field_visibility.
 * Errs on the side of privacy: nothing is leaked unless the roommate opts in.
 */
export const DEFAULT_TIER: Tier = 'private';

export const updateFieldVisibilitySchema = z.object({
  visibility: fieldVisibilitySchema,
});
export type UpdateFieldVisibility = z.infer<typeof updateFieldVisibilitySchema>;
