import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { fetchTelegramAvatar } from '../auth/telegram.js';

/**
 * Public avatar proxy. Telegram avatars require a bot-token URL we don't want
 * to expose; we stream the bytes through the Worker. BlueSky avatars are
 * already public CDN URLs and are referenced directly — no proxy needed.
 */
export const avatarRoutes = new Hono<Env>();

avatarRoutes.get('/tg/:tgUserId{[0-9]+}', async (c) => {
  const tgUserId = Number(c.req.param('tgUserId'));
  const res = await fetchTelegramAvatar(tgUserId, c.env.TG_BOT_TOKEN);
  if (!res) throw new HttpError(404, 'avatar_not_found');
  return res;
});
