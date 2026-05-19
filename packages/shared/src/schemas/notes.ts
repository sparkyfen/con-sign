import { z } from 'zod';

/**
 * Shared schemas for `/api/rooms/:id/notes/*` (the in-room notes
 * surface) and the read/write API for per-(recipient, source-roommate)
 * notification preferences on the Notes page.
 *
 * Caps mirror the design lock in PLAN.md:
 *   - pinned blob body ≤ 1 KB
 *   - feed entry body ≤ 280 chars
 *   - feed capped at 50 entries per room (oldest TTLs out at the DB)
 */

const PINNED_MAX = 1024;
const ENTRY_MAX = 280;

export const pinnedNoteSchema = z.object({
  body: z.string(),
  updatedByUserId: z.string().uuid().nullable(),
  updatedByDisplayName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type PinnedNote = z.infer<typeof pinnedNoteSchema>;

export const roomNoteEntrySchema = z.object({
  id: z.string().uuid(),
  authorUserId: z.string().uuid(),
  authorDisplayName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** True when the calling user is allowed to delete this entry
   * (author or room admin). UI hides the menu item otherwise. */
  canDelete: z.boolean(),
});
export type RoomNoteEntry = z.infer<typeof roomNoteEntrySchema>;

export const roomNotesViewSchema = z.object({
  pinned: pinnedNoteSchema,
  feed: z.array(roomNoteEntrySchema),
  /** The current feed cap; surfaced so the UI's "N of 50" label
   * doesn't have to be hard-coded client-side. */
  feedCap: z.number().int().positive(),
});
export type RoomNotesView = z.infer<typeof roomNotesViewSchema>;

export const pinnedNoteUpdateSchema = z.object({
  body: z.string().max(PINNED_MAX),
});
export type PinnedNoteUpdate = z.infer<typeof pinnedNoteUpdateSchema>;

export const roomNoteCreateSchema = z.object({
  body: z.string().min(1).max(ENTRY_MAX),
});
export type RoomNoteCreate = z.infer<typeof roomNoteCreateSchema>;

/**
 * One row from the calling roommate's notification toggles list on
 * the Notes page. `sourceRoommateId` identifies whose posts these
 * pings would be about.
 */
export const notePrefEntrySchema = z.object({
  sourceRoommateId: z.string().uuid(),
  sourceDisplayName: z.string(),
  enabled: z.boolean(),
});
export type NotePrefEntry = z.infer<typeof notePrefEntrySchema>;

export const notePrefsViewSchema = z.object({
  prefs: z.array(notePrefEntrySchema),
});
export type NotePrefsView = z.infer<typeof notePrefsViewSchema>;

export const notePrefUpdateSchema = z.object({
  enabled: z.boolean(),
});
export type NotePrefUpdate = z.infer<typeof notePrefUpdateSchema>;
