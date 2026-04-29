import type { ProjectedRoommate } from './schemas/room.js';
import type { Roommate } from './schemas/roommate.js';
import type { FieldVisibility, Tier, VisibleFieldName } from './schemas/visibility.js';
import { DEFAULT_TIER } from './schemas/visibility.js';

/**
 * Privacy projection. The ONLY function authorized to decide what a visitor
 * sees of a roommate. Both the visitor API (server-side filtering) and the
 * admin "preview as guest" UI must call this — never re-implement the logic.
 *
 * @param roommate           The full server-side roommate record.
 * @param visibility         Per-field tier settings owned by the roommate.
 *                           Fields without an explicit entry default to
 *                           {@link DEFAULT_TIER} ('private').
 * @param unlockedRoommateIds The set of roommate IDs whose passcode the
 *                           viewer has entered in this session. The viewer is
 *                           at the 'personal' tier for `roommate` iff
 *                           `roommate.id` is in this set; otherwise 'guest'.
 *                           'private' is never reachable by any visitor.
 *
 * Returns a {@link ProjectedRoommate}: fields the viewer can't see are
 * absent, NOT present-as-null. (Network noise / type narrowing both benefit.)
 */
export function projectRoommate(
  roommate: Roommate,
  visibility: FieldVisibility,
  unlockedRoommateIds: ReadonlySet<string> | readonly string[],
): ProjectedRoommate {
  const unlocked =
    unlockedRoommateIds instanceof Set
      ? unlockedRoommateIds
      : new Set(unlockedRoommateIds);
  const viewerTier: Tier = unlocked.has(roommate.id) ? 'personal' : 'guest';

  const out: ProjectedRoommate = {
    id: roommate.id,
    role: roommate.role,
  };

  const include = (field: VisibleFieldName): boolean =>
    canSee(viewerTier, visibility[field] ?? DEFAULT_TIER);

  if (roommate.fursonaName != null && include('fursona_name')) {
    out.fursonaName = roommate.fursonaName;
  }
  if (roommate.fursonaSpecies != null && include('fursona_species')) {
    out.fursonaSpecies = roommate.fursonaSpecies;
  }
  if (roommate.pronouns != null && include('pronouns')) {
    out.pronouns = roommate.pronouns;
  }
  if (roommate.bskyHandle != null && include('bsky_handle')) {
    out.bskyHandle = roommate.bskyHandle;
  }
  if (roommate.telegramHandle != null && include('telegram_handle')) {
    out.telegramHandle = roommate.telegramHandle;
  }
  if (roommate.avatarUrl != null && include('avatar_url')) {
    out.avatarUrl = roommate.avatarUrl;
  }

  if (roommate.status && include('status')) {
    const label =
      roommate.status.kind === 'preset' ? roommate.status.preset : roommate.status.text;
    out.status = roommate.statusUpdatedAt
      ? { label, updatedAt: roommate.statusUpdatedAt }
      : { label };
  }

  return out;
}

/**
 * Tier comparison: can a viewer at `viewerTier` see a field whose minimum
 * required tier is `fieldMinTier`? `private` fields are never visible to any
 * visitor (only the roommate themselves, which is a separate code path that
 * does not call this function).
 */
function canSee(viewerTier: Tier, fieldMinTier: Tier): boolean {
  if (fieldMinTier === 'private') return false;
  if (fieldMinTier === 'guest') return true;
  // fieldMinTier === 'personal'
  return viewerTier === 'personal';
}
