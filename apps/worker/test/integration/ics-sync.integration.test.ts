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
