import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import {
  SESSION_COOKIE,
  buildCookie,
  clearCookie,
  newUserSession,
  readCookie,
  revokeSession,
  signSession,
  verifySession,
} from '../auth/session.js';
import { TelegramAuthError, fetchTelegramAvatar, verifyTelegramLogin } from '../auth/telegram.js';
import { upsertIdentity } from '../db/queries.js';

export const authRoutes = new Hono<Env>();

authRoutes.get('/bsky/start', () => {
  throw new HttpError(404, 'not_implemented', 'BlueSky OAuth start — task #8');
});

authRoutes.get('/bsky/callback', () => {
  throw new HttpError(404, 'not_implemented', 'BlueSky OAuth callback — task #8');
});

authRoutes.post('/telegram/callback', async (c) => {
  const body = (await c.req.json()) as unknown;

  let parsed;
  try {
    parsed = await verifyTelegramLogin(body, c.env.TG_BOT_TOKEN);
  } catch (err) {
    if (err instanceof TelegramAuthError) {
      throw new HttpError(401, 'telegram_auth_failed', err.reason);
    }
    throw err;
  }

  const displayName = [parsed.first_name, parsed.last_name].filter(Boolean).join(' ');
  const userId = await upsertIdentity(c.env.DB, {
    provider: 'telegram',
    providerId: String(parsed.id),
    handle: parsed.username ?? null,
    // We don't store the photo_url Telegram gave us — it expires. Avatars
    // are served live via /api/avatar/tg/:id which hits the Bot API.
    avatarUrl: null,
    displayName: displayName || `tg-${parsed.id}`,
    rawProfile: parsed,
  });

  const session = newUserSession(userId);
  const token = await signSession(session, c.env.SESSION_HMAC);
  c.header(
    'Set-Cookie',
    buildCookie(SESSION_COOKIE, token, {
      secure: new URL(c.req.url).protocol === 'https:',
      maxAgeSec: session.exp - session.iat,
    }),
  );
  return c.json({ ok: true, userId });
});


authRoutes.get('/me', requireUser, (c) => {
  // The full /me payload (with identities) lands in task #8/#9 alongside the
  // user-creation flow. For now: just confirm a valid session.
  return c.json({ userId: c.get('userId') });
});

authRoutes.post('/logout', async (c) => {
  const token = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (token) {
    try {
      const payload = await verifySession(token, c.env.SESSION_HMAC);
      if (payload.kind === 'user') {
        await revokeSession(c.env.SESSIONS, payload.jti, payload.exp);
      }
    } catch {
      // Already invalid — nothing to revoke.
    }
  }
  c.header(
    'Set-Cookie',
    clearCookie(SESSION_COOKIE, { secure: new URL(c.req.url).protocol === 'https:' }),
  );
  return c.json({ ok: true });
});
