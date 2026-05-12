import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser } from '../auth/middleware.js';
import { decodeCursor, listAuditForUser, type AuditRow } from '../db/audit.js';
import { auditQuerySchema, type AuditEntry, type AuditList } from '@con-sign/shared';

export const meRoutes = new Hono<Env>();

const rowToEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  actorUserId: r.actor_user_id,
  roomId: r.room_id,
  action: r.action as AuditEntry['action'],
  targetId: r.target_id,
  metadata: r.metadata_json
    ? (JSON.parse(r.metadata_json) as Record<string, unknown>)
    : null,
  at: r.at,
});

// Per-user audit trail: actions the caller themselves performed, across
// every room they're in. Useful for "did I really change this last week?"
// and for cross-room recall on power users.
meRoutes.get('/audit', requireUser, async (c) => {
  const q = auditQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const page = await listAuditForUser(c.env.DB, c.get('userId')!, { limit: q.limit, cursor });
  const body: AuditList = { entries: page.rows.map(rowToEntry), nextCursor: page.nextCursor };
  return c.json(body);
});
