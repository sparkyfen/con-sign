import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import { createBskyClient } from '../auth/bsky/client.js';
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
import { TelegramAuthError, verifyTelegramLogin } from '../auth/telegram.js';
import { upsertIdentity } from '../db/queries.js';

export const authRoutes = new Hono<Env>();

// ─── BlueSky OAuth ─────────────────────────────────────────────────────────

authRoutes.get('/bsky/client-metadata.json', async (c) => {
  const client = await createBskyClient(c.env);
  return c.json(client.clientMetadata);
});

authRoutes.get('/bsky/jwks.json', async (c) => {
  const client = await createBskyClient(c.env);
  return c.json(client.jwks);
});

authRoutes.get('/bsky/start', async (c) => {
  const handle = c.req.query('handle');
  if (!handle) throw new HttpError(400, 'invalid_request', 'handle query param required');

  const client = await createBskyClient(c.env);
  const url = await client.authorize(handle, {
    scope: 'atproto transition:generic',
  });
  return c.redirect(url.toString(), 302);
});

authRoutes.get('/bsky/callback', async (c) => {
  const client = await createBskyClient(c.env);
  const url = new URL(c.req.url);
  const { session: oauthSession } = await client.callback(url.searchParams);

  const did = oauthSession.did;
  // Public AppView returns handle + avatar without needing the user's DPoP-
  // bound access token. Cheaper and keeps DPoP confined to the OAuth flow.
  const profileRes = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
  );
  const profile = profileRes.ok
    ? ((await profileRes.json()) as {
        handle?: string;
        displayName?: string;
        avatar?: string;
      })
    : {};

  const userId = await upsertIdentity(c.env.DB, {
    provider: 'bsky',
    providerId: did,
    handle: profile.handle ?? null,
    avatarUrl: profile.avatar ?? null,
    displayName: profile.displayName || profile.handle || `bsky-${did.slice(-8)}`,
    rawProfile: profile,
  });

  const session = newUserSession(userId);
  const token = await signSession(session, c.env.SESSION_HMAC);
  c.header(
    'Set-Cookie',
    buildCookie(SESSION_COOKIE, token, {
      secure: url.protocol === 'https:',
      maxAgeSec: session.exp - session.iat,
    }),
  );
  return c.redirect('/', 302);
});

// ─── Telegram ──────────────────────────────────────────────────────────────

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
