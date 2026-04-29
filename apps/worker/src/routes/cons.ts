import { Hono } from 'hono';
import { conSearchQuerySchema, type Con } from '@con-sign/shared';
import type { Env } from '../types.js';
import { runIcsSync } from '../cron/ics-sync.js';
import { requireUser } from '../auth/middleware.js';

export const conRoutes = new Hono<Env>();

interface ConRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  location: string | null;
  url: string | null;
}

const rowToCon = (r: ConRow): Con => ({
  id: r.id,
  name: r.name,
  startDate: r.start_date,
  endDate: r.end_date,
  location: r.location,
  url: r.url,
});

conRoutes.get('/', async (c) => {
  const params = conSearchQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

  // Default ordering: upcoming first (end_date >= today), then by start_date.
  const today = new Date().toISOString().slice(0, 10);
  const stmt = params.q
    ? c.env.DB.prepare(
        `SELECT id, name, start_date, end_date, location, url FROM con
          WHERE name LIKE ? AND end_date >= ?
          ORDER BY start_date ASC LIMIT ?`,
      ).bind(`%${params.q}%`, today, params.limit)
    : c.env.DB.prepare(
        `SELECT id, name, start_date, end_date, location, url FROM con
          WHERE end_date >= ?
          ORDER BY start_date ASC LIMIT ?`,
      ).bind(today, params.limit);

  const result = await stmt.all<ConRow>();
  return c.json({ cons: (result.results ?? []).map(rowToCon) });
});

/**
 * Manual ICS resync. Authenticated — no IP- or session-based rate limit on
 * the route; the upstream feed is fine to hit a few times a day.
 */
conRoutes.post('/sync', requireUser, async (c) => {
  const result = await runIcsSync(c.env);
  return c.json(result);
});
