import type { DeviceRow } from '../db/queries.js';

/**
 * What screen the device should render on its next poll. The classifier
 * is shared between `/api/device/sign.png` (which dispatches the actual
 * render) and the `/api/trmnl/display` adapter (which embeds the same
 * decision into the envelope's `filename` so the panel's cache-bust
 * agrees with what we'll actually serve next).
 *
 *   - `unpaired`       — no `device` row, or the row exists with no
 *                        room and no recent revoke. Render the rotating
 *                        pair-code screen.
 *   - `paired`         — bound to a room with no active revoke. Render
 *                        the room sign.
 *   - `revoked-notice` — revoked and the panel hasn't seen the notice
 *                        yet (`last_seen_at IS NULL`). Show the
 *                        "PANEL UNPAIRED" screen exactly once.
 *   - `self-healed`    — revoked but the panel has already polled
 *                        since (notice shown). Treat as `unpaired`
 *                        for rendering; keeps `revoked_at` for audit.
 *
 * `revokeDevice` clears `last_seen_at` to NULL on revoke; the first
 * post-revoke poll renders the notice and `touchDevice` repopulates
 * the column, so subsequent polls fall into `self-healed`.
 */
export type DeviceRenderState =
  | 'unpaired'
  | 'paired'
  | 'revoked-notice'
  | 'self-healed';

export function classifyDeviceState(device: DeviceRow | null): DeviceRenderState {
  if (!device) return 'unpaired';
  if (device.revoked_at) {
    return device.last_seen_at == null ? 'revoked-notice' : 'self-healed';
  }
  if (device.room_id) return 'paired';
  return 'unpaired';
}

/**
 * Collapse the four render states into the three the TRMNL adapter's
 * `filename` cache key cares about. `self-healed` shares the
 * `unpaired` tag because it produces the same screen (pair code), so
 * a freshly-unpaired and a self-healed device get the same cached
 * frame.
 */
export function envelopeStateFromRender(
  s: DeviceRenderState,
): 'paired' | 'revoked' | 'unpaired' {
  if (s === 'paired') return 'paired';
  if (s === 'revoked-notice') return 'revoked';
  return 'unpaired';
}
