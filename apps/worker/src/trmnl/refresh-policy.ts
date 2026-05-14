/**
 * Pick how long a TRMNL device should sleep between polls, based on
 * how close we are to the room's con. Returned in seconds; the value
 * goes into the `refresh_rate` field of the TRMNL display envelope.
 *
 * The split is deliberately coarse — battery panels want to sleep
 * aggressively outside the con window, but a freshly-updated status
 * during the con should reach the panel quickly enough that
 * "where's so-and-so" actually answers itself.
 *
 *   During con    (start_date ≤ today ≤ end_date) ........ 300s (5min)
 *   Adjacent     (within 7 days before or after)  ........ 3600s (1h)
 *   Otherwise   .......................................... 86400s (24h)
 *   No con (unpaired, no room) ........................... 300s (5min)
 *
 * "Adjacent" exists because the room's roommates are likely tweaking
 * profiles in the days leading up to the con; we want the panel to
 * pick up changes without forcing an admin to wait a day.
 *
 * Returns a single integer; the caller passes it straight through to
 * TRMNL.
 */

const SECONDS_5_MIN = 300;
const SECONDS_1_HOUR = 3600;
const SECONDS_24_HOUR = 86400;
const ADJACENT_DAYS = 7;
const DAY_MS = 86_400_000;

export interface ConDates {
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD
}

export function nextRefreshSec(con: ConDates | null, now: Date = new Date()): number {
  if (!con || !con.startDate || !con.endDate) return SECONDS_5_MIN;

  const start = Date.parse(`${con.startDate}T00:00:00Z`);
  // End-of-day boundary: a con ending on the 4th should still be "during"
  // through midnight UTC at the end of the 4th.
  const end = Date.parse(`${con.endDate}T23:59:59Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return SECONDS_5_MIN;

  const t = now.getTime();
  if (t >= start && t <= end) return SECONDS_5_MIN;

  const adjacentWindowMs = ADJACENT_DAYS * DAY_MS;
  if (t < start && start - t <= adjacentWindowMs) return SECONDS_1_HOUR;
  if (t > end && t - end <= adjacentWindowMs) return SECONDS_1_HOUR;

  return SECONDS_24_HOUR;
}
