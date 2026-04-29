import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIcsSync } from '../../src/cron/ics-sync.js';
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
