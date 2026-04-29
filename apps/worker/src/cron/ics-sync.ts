import type { Bindings } from '../types.js';

/**
 * Daily ICS sync. Fetches the furrycons.com calendar, parses VEVENTs, and
 * upserts into `con` keyed by VEVENT UID. Idempotent: re-running is a no-op.
 *
 * Implemented in task #17.
 */
export async function runIcsSync(_env: Bindings): Promise<void> {
  // task #17
}
