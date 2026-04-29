import { Hono, type Context } from 'hono';
import {
  projectRoommate,
  unlockRequestSchema,
  type UnlockResponse,
  type VisitorRoomView,
} from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import {
  buildCookie,
  newUnlockSession,
  readCookie,
  signSession,
  unlockCookieName,
  verifySession,
  type UnlockedRoommateRef,
} from '../auth/session.js';
import { verifyPasscode } from '../auth/passcode.js';
import { verifyTurnstile } from '../auth/turnstile.js';
import { getVisibility, listRoommatesForRoom, roommateRowToApi } from '../db/queries.js';

export const visitorRoutes = new Hono<Env>();

const VISITOR_ID_COOKIE = 'cs_visitor';
const VISITOR_ID_TTL_SEC = 90 * 24 * 60 * 60; // 90 days
const TURNSTILE_THRESHOLD = 3;
const FAIL_COUNTER_TTL_SEC = 60 * 60; // 1h sliding window

const failKey = (slug: string): string => `unlock:fail:${slug}`;

async function getOrSetVisitorId(c: Context<Env>): Promise<{
  id: string;
  setCookie: string | null;
}> {
  const existing = readCookie(c.req.header('Cookie'), VISITOR_ID_COOKIE);
  if (existing && /^[a-zA-Z0-9_-]{8,128}$/.test(existing)) {
    return { id: existing, setCookie: null };
  }
  const id = crypto.randomUUID();
  return {
    id,
    setCookie: buildCookie(VISITOR_ID_COOKIE, id, {
      secure: new URL(c.req.url).protocol === 'https:',
      maxAgeSec: VISITOR_ID_TTL_SEC,
    }),
  };
}

interface RoomLookup {
  id: string;
  conId: string;
  conName: string;
  name: string;
  qrSlug: string;
}

async function fetchRoomBySlug(db: D1Database, slug: string): Promise<RoomLookup | null> {
  return db
    .prepare(
      `SELECT room.id AS id, room.con_id AS conId, room.name AS name, room.qr_slug AS qrSlug,
              con.name AS conName
         FROM room JOIN con ON con.id = room.con_id
        WHERE room.qr_slug = ?`,
    )
    .bind(slug)
    .first<RoomLookup>();
}

async function readUnlockCookie(
  c: Context<Env>,
  roomId: string,
): Promise<UnlockedRoommateRef[]> {
  const raw = readCookie(c.req.header('Cookie'), unlockCookieName(roomId));
  if (!raw) return [];
  try {
    const payload = await verifySession(raw, c.env.SESSION_HMAC);
    if (payload.kind !== 'unlock' || payload.roomId !== roomId) return [];
    return payload.unlocked;
  } catch {
    return [];
  }
}

/**
 * Filter unlock-cookie entries down to roommates whose stored
 * passcode_rotated_at still matches the cookie's snapshot. A rotation
 * silently invalidates the entry without forcing a logout for the rest.
 */
function filterFreshUnlocks(
  cookieRefs: UnlockedRoommateRef[],
  rows: { row: { id: string; passcode_rotated_at: string } }[],
): string[] {
  const liveRot = new Map(rows.map(({ row }) => [row.id, row.passcode_rotated_at]));
  return cookieRefs.filter((r) => liveRot.get(r.id) === r.rot).map((r) => r.id);
}

// ─── GET /api/r/:slug ─────────────────────────────────────────────────────

visitorRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const room = await fetchRoomBySlug(c.env.DB, slug);
  if (!room) throw new HttpError(404, 'room_not_found');

  const { setCookie } = await getOrSetVisitorId(c);
  const cookieRefs = await readUnlockCookie(c, room.id);

  const rows = await listRoommatesForRoom(c.env.DB, room.id);
  const unlockedIds = filterFreshUnlocks(cookieRefs, rows);

  const projected = await Promise.all(
    rows.map(async ({ row, avatarUrl }) => {
      const visibility = await getVisibility(c.env.DB, row.id);
      const r = roommateRowToApi(row, avatarUrl);
      return projectRoommate(r, visibility, unlockedIds);
    }),
  );

  const failCount = Number((await c.env.SESSIONS.get(failKey(slug))) ?? '0');
  const view: VisitorRoomView = {
    room: {
      id: room.id,
      name: room.name,
      qrSlug: room.qrSlug,
      con: { id: room.conId, name: room.conName },
    },
    roommates: projected,
    unlockedRoommateIds: unlockedIds,
    turnstileRequired: failCount >= TURNSTILE_THRESHOLD,
  };
  if (setCookie) c.header('Set-Cookie', setCookie);
  return c.json(view);
});

// ─── POST /api/r/:slug/unlock ─────────────────────────────────────────────

visitorRoutes.post('/:slug/unlock', async (c) => {
  const slug = c.req.param('slug');
  const room = await fetchRoomBySlug(c.env.DB, slug);
  if (!room) throw new HttpError(404, 'room_not_found');

  const { id: visitorId, setCookie: setVisitorCookie } = await getOrSetVisitorId(c);

  // Per-cookie soft cap (Workers Rate Limiting binding).
  const rl = await c.env.UNLOCK_RL.limit({ key: `unlock:${visitorId}:${slug}` });
  if (!rl.success) throw new HttpError(429, 'rate_limited');

  const body = unlockRequestSchema.parse(await c.req.json());

  const failCount = Number((await c.env.SESSIONS.get(failKey(slug))) ?? '0');
  const turnstileRequired = failCount >= TURNSTILE_THRESHOLD;
  if (turnstileRequired) {
    const ok = await verifyTurnstile(
      body.turnstileToken,
      c.env.TURNSTILE_SECRET,
      c.req.header('CF-Connecting-IP') ?? undefined,
    );
    if (!ok) throw new HttpError(429, 'turnstile_required');
  }

  const rows = await listRoommatesForRoom(c.env.DB, room.id);
  let matchedId: string | null = null;
  let matchedRot: string | null = null;
  // Verify against every roommate so timing leaks nothing about how many
  // matched. PBKDF2 is fast enough that 5–10 verifies is well under 200ms.
  for (const { row } of rows) {
    if (await verifyPasscode(body.passcode, row.passcode_hash)) {
      matchedId = row.id;
      matchedRot = row.passcode_rotated_at;
      // Keep iterating to keep total work constant.
    }
  }

  const headers: string[] = [];
  if (setVisitorCookie) headers.push(setVisitorCookie);

  if (!matchedId) {
    const next = failCount + 1;
    await c.env.SESSIONS.put(failKey(slug), String(next), {
      expirationTtl: FAIL_COUNTER_TTL_SEC,
    });
    for (const h of headers) c.header('Set-Cookie', h, { append: true });
    const resp: UnlockResponse = {
      unlockedRoommateIds: [],
      matched: false,
      turnstileRequired: next >= TURNSTILE_THRESHOLD,
    };
    return c.json(resp, 401);
  }

  // Match: merge with existing cookie, refresh, clear the slug fail counter.
  const existing = await readUnlockCookie(c, room.id);
  const merged = new Map<string, UnlockedRoommateRef>();
  for (const r of existing) merged.set(r.id, r);
  merged.set(matchedId, { id: matchedId, rot: matchedRot! });

  // Drop any entries that have since rotated — same logic as the GET path.
  const liveIds = new Set(filterFreshUnlocks(Array.from(merged.values()), rows));
  const refs = Array.from(merged.values()).filter((r) => liveIds.has(r.id));

  const session = newUnlockSession(room.id, refs);
  const token = await signSession(session, c.env.SESSION_HMAC);
  headers.push(
    buildCookie(unlockCookieName(room.id), token, {
      secure: new URL(c.req.url).protocol === 'https:',
      maxAgeSec: session.exp - session.iat,
      path: `/api/r/${slug}`,
    }),
  );
  await c.env.SESSIONS.delete(failKey(slug));

  for (const h of headers) c.header('Set-Cookie', h, { append: true });
  const resp: UnlockResponse = {
    unlockedRoommateIds: refs.map((r) => r.id),
    matched: true,
    turnstileRequired: false,
  };
  return c.json(resp);
});
