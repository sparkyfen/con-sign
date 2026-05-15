import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STALE_DEVICE_DAYS,
  runIcsSync,
  runStaleDeviceCleanup,
} from '../../src/cron/ics-sync.js';
import { createTestBindings } from '../doubles.js';

const FEED = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-001
SUMMARY:Test Con One
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260604
LOCATION:Springfield
URL:https://example.com/1
END:VEVENT
BEGIN:VEVENT
UID:test-002
SUMMARY:Test Con Two
DTSTART;VALUE=DATE:20260801
DTEND;VALUE=DATE:20260804
END:VEVENT
END:VCALENDAR`;

describe('integration: ICS sync', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response(FEED, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('upserts events from the feed into the con table', async () => {
    const env = createTestBindings();
    const result = await runIcsSync(env);
    expect(result.ingested).toBe(2);

    const all = await env.DB.prepare('SELECT ics_uid, name FROM con ORDER BY ics_uid').all<{
      ics_uid: string;
      name: string;
    }>();
    expect(all.results.map((r) => r.ics_uid)).toEqual(['test-001', 'test-002']);
  });

  it('is idempotent — running twice does not duplicate', async () => {
    const env = createTestBindings();
    await runIcsSync(env);
    await runIcsSync(env);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM con').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('stale-device cleanup deletes devices older than the cutoff', async () => {
    const env = createTestBindings();
    const dayMs = 86_400_000;
    const now = new Date('2026-06-01T00:00:00Z');
    const fresh = new Date(now.getTime() - 10 * dayMs).toISOString();
    const stale = new Date(now.getTime() - (STALE_DEVICE_DAYS + 5) * dayMs).toISOString();
    const created = new Date(now.getTime() - (STALE_DEVICE_DAYS + 1) * dayMs).toISOString();

    // Three rows: one fresh (last_seen recent), one stale (last_seen old),
    // one never-paired (no last_seen, just an old created_at).
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO device (id, last_seen_at, created_at) VALUES (?, ?, ?)`,
      ).bind('fresh-device', fresh, fresh),
      env.DB.prepare(
        `INSERT INTO device (id, last_seen_at, created_at) VALUES (?, ?, ?)`,
      ).bind('stale-device', stale, stale),
      env.DB.prepare(
        `INSERT INTO device (id, last_seen_at, created_at) VALUES (?, NULL, ?)`,
      ).bind('never-paired', created),
    ]);

    const { deleted } = await runStaleDeviceCleanup(env, now);
    expect(deleted).toBe(2);

    const remaining = await env.DB.prepare('SELECT id FROM device').all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(['fresh-device']);
  });

  it('derives con.timezone from location during sync, only filling NULLs', async () => {
    const env = createTestBindings();
    // First sync: feed with a real location → timezone gets derived.
    const feedWithTz = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:tz-001
SUMMARY:AnthroTales
DTSTART;VALUE=DATE:20260514
DTEND;VALUE=DATE:20260518
LOCATION:Van der Valk Hotel\\, Mons\\, Belgium
END:VEVENT
END:VCALENDAR`;
    globalThis.fetch = vi.fn(
      async () => new Response(feedWithTz, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await runIcsSync(env);
    const after1 = await env.DB.prepare('SELECT timezone FROM con WHERE ics_uid = ?')
      .bind('tz-001')
      .first<{ timezone: string }>();
    expect(after1?.timezone).toBe('Europe/Brussels');

    // Manual override: admin pins a different tz.
    await env.DB.prepare('UPDATE con SET timezone = ? WHERE ics_uid = ?')
      .bind('America/New_York', 'tz-001')
      .run();

    // Second sync with the same (Belgium) feed must NOT clobber the
    // manual override. COALESCE on the conflict update path is the guard.
    await runIcsSync(env);
    const after2 = await env.DB.prepare('SELECT timezone FROM con WHERE ics_uid = ?')
      .bind('tz-001')
      .first<{ timezone: string }>();
    expect(after2?.timezone).toBe('America/New_York');
  });

  it('leaves timezone NULL when the location is unrecognised, retrying on the next sync', async () => {
    const env = createTestBindings();
    const unknownFeed = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:tz-002
SUMMARY:Unknown Con
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260604
LOCATION:TBA
END:VEVENT
END:VCALENDAR`;
    globalThis.fetch = vi.fn(
      async () => new Response(unknownFeed, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await runIcsSync(env);
    const after1 = await env.DB.prepare('SELECT timezone FROM con WHERE ics_uid = ?')
      .bind('tz-002')
      .first<{ timezone: string | null }>();
    expect(after1?.timezone).toBeNull();

    // Feed later resolves the venue → next sync fills it in.
    const resolvedFeed = unknownFeed.replace('LOCATION:TBA', 'LOCATION:Hotel\\, Austin\\, TX');
    globalThis.fetch = vi.fn(
      async () => new Response(resolvedFeed, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await runIcsSync(env);
    const after2 = await env.DB.prepare('SELECT timezone FROM con WHERE ics_uid = ?')
      .bind('tz-002')
      .first<{ timezone: string | null }>();
    expect(after2?.timezone).toBe('America/Chicago');
  });

  it('updates an existing entry when the feed changes the SUMMARY', async () => {
    const env = createTestBindings();
    await runIcsSync(env);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(FEED.replace('Test Con One', 'Test Con One (Renamed)'), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await runIcsSync(env);
    const row = await env.DB.prepare('SELECT name FROM con WHERE ics_uid = ?')
      .bind('test-001')
      .first<{ name: string }>();
    expect(row?.name).toBe('Test Con One (Renamed)');
  });
});
