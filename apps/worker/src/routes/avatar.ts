import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { fetchTelegramAvatar } from '../auth/telegram.js';
import { VISITOR_ID_COOKIE, readCookie } from '../auth/session.js';

/**
 * Public avatar proxy. Telegram avatars require a bot-token URL we don't want
 * to expose; we stream the bytes through the Worker. BlueSky avatars are
 * already public CDN URLs and are referenced directly — no proxy needed.
 *
 * Two layers of abuse defense:
 *   1. **Edge cache** via `caches.default`. The vast majority of requests
 *      for a paired room's avatars hit the cache and never touch the Bot
 *      API. `cache.put` runs via executionCtx.waitUntil so it doesn't
 *      block the cold response.
 *   2. **Per-visitor rate limit** on cache misses (AVATAR_RL). Keyed
 *      on the `cs_visitor` cookie minted by `/api/r/:slug`, falling
 *      back to `CF-Connecting-IP` for direct API hits without a
 *      cookie. Per-visitor keying is the NAT-safe choice — hundreds
 *      of attendees on the same hotel Wi-Fi each get their own
 *      bucket instead of collectively saturating the venue IP's
 *      bucket on cold start. The unauth/no-cookie path falls through
 *      to IP, which retains the original Bot-API-quota guard.
 */
export const avatarRoutes = new Hono<Env>();

avatarRoutes.get('/tg/:tgUserId{[0-9]+}', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Cache miss: rate-limit before talking to Telegram. Prefer the
  // per-visitor cookie key; fall through to IP only when no cookie
  // is present (direct API hits, bots, etc.) so a single venue's
  // attendees don't share one bucket.
  const visitorId = readCookie(c.req.header('Cookie'), VISITOR_ID_COOKIE);
  const rlKey = visitorId
    ? `avatar:v:${visitorId}`
    : `avatar:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  const rl = await c.env.AVATAR_RL.limit({ key: rlKey });
  if (!rl.success) throw new HttpError(429, 'avatar_rate_limited');

  const tgUserId = Number(c.req.param('tgUserId'));
  const res = await fetchTelegramAvatar(tgUserId, c.env.TG_BOT_TOKEN);
  if (!res) throw new HttpError(404, 'avatar_not_found');

  // Cache.put consumes the body; clone so we can also return the original.
  // Don't `await` — let the cache write race the response.
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});
