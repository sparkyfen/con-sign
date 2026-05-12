import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { fetchTelegramAvatar } from '../auth/telegram.js';

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
 *   2. **Per-IP rate limit** on cache misses (AVATAR_RL, 60/60s). A
 *      scraper walking sequential tg user_ids would burn Bot API quota
 *      otherwise. Hotel-NAT-style shared IPs aren't a concern here
 *      because legitimate viewers of the same room hit the cache, not
 *      this fallback.
 */
export const avatarRoutes = new Hono<Env>();

avatarRoutes.get('/tg/:tgUserId{[0-9]+}', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Cache miss: rate-limit by IP before talking to Telegram.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rl = await c.env.AVATAR_RL.limit({ key: `avatar:${ip}` });
  if (!rl.success) throw new HttpError(429, 'avatar_rate_limited');

  const tgUserId = Number(c.req.param('tgUserId'));
  const res = await fetchTelegramAvatar(tgUserId, c.env.TG_BOT_TOKEN);
  if (!res) throw new HttpError(404, 'avatar_not_found');

  // Cache.put consumes the body; clone so we can also return the original.
  // Don't `await` — let the cache write race the response.
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});
