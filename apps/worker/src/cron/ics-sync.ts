import type { Bindings } from '../types.js';
import { parseIcs, type IcsEvent } from './ics-parse.js';

/**
 * Daily ICS sync. Fetches the furrycons.com calendar, parses VEVENTs, and
 * upserts into `con` keyed by VEVENT UID. Idempotent.
 */
export async function runIcsSync(env: Bindings): Promise<{ ingested: number }> {
  const res = await fetch(env.ICS_FEED_URL, {
    headers: { 'User-Agent': 'con-sign/0.1 (+https://github.com/sparkyfen/con-sign)' },
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
