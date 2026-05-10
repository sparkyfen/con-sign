import type { Bindings } from '../types.js';
import { deleteStaleDevices } from '../db/queries.js';
import { parseIcs, type IcsEvent } from './ics-parse.js';

/** Devices silent past this many days are deleted by the daily cron. */
export const STALE_DEVICE_DAYS = 90;

/**
 * Daily ICS sync. Fetches the furrycons.com calendar, parses VEVENTs, and
 * upserts into `con` keyed by VEVENT UID. Idempotent.
 */
export async function runIcsSync(env: Bindings): Promise<{ ingested: number }> {
  const res = await fetch(env.ICS_FEED_URL, {
    // furrycons.com is fronted by Cloudflare bot management and 403s any UA
    // that includes a github.com URL. Identify with our public site instead.
    headers: { 'User-Agent': 'con-sign/0.1 (+https://cons.social)' },
  });
  if (!res.ok) {
    console.error(`ics-sync: fetch ${res.status}`);
    return { ingested: 0 };
  }
  const text = await res.text();
  const events = parseIcs(text);
  const now = new Date().toISOString();

  // Batch in chunks so we don't blow the SQL statement count limit.
  const chunkSize = 50;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    await env.DB.batch(chunk.map((e) => upsertStatement(env.DB, e, now)));
  }
  return { ingested: events.length };
}

/**
 * Delete `device` rows that haven't been seen in STALE_DEVICE_DAYS. Catches
 * abandoned panels (paired but went silent) and devices that were created
 * by an admin's claim but never polled afterward (judged by `created_at`
 * via `COALESCE(last_seen_at, created_at)` in the query).
 */
export async function runStaleDeviceCleanup(
  env: Bindings,
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - STALE_DEVICE_DAYS * 86_400_000).toISOString();
  const deleted = await deleteStaleDevices(env.DB, cutoff);
  if (deleted > 0) console.log(`stale-device-cleanup: deleted ${deleted}`);
  return { deleted };
}

function upsertStatement(db: D1Database, e: IcsEvent, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO con (id, ics_uid, name, start_date, end_date, location, url, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ics_uid) DO UPDATE SET
         name = excluded.name,
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         location = excluded.location,
         url = excluded.url,
         source_updated_at = excluded.source_updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      e.uid,
      e.summary,
      e.startDate,
      e.endDate,
      e.location,
      e.url,
      now,
    );
}
