import { Hono, type Context } from 'hono';
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
import {
  IdentityCollisionError,
  getUserDisplayName,
  listIdentitiesForUser,
  upsertIdentity,
} from '../db/queries.js';
import type { SessionUser } from '@con-sign/shared';

export const authRoutes = new Hono<Env>();

/**
 * If the request already carries a valid `cs_session` cookie, return that
 * user_id so an OAuth/Telegram callback knows it's a "link this identity
 * to my existing account" flow rather than a fresh login. Returns null on
 * missing/invalid/revoked.
 */
async function readActiveUserId(c: Context<Env>): Promise<string | null> {
  const token = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (!token) return null;
  try {
    const payload = await verifySession(token, c.env.SESSION_HMAC);
    return payload.kind === 'user' ? payload.sub : null;
  } catch {
    return null;
  }
}

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

  // client.callback() throws on expired state, replayed code, AS network
  // blip, malformed redirect, etc. Without this catch the user lands on
  // the generic 500 page with no actionable message; the frontend can't
  // distinguish "your login expired, click to retry" from "we're broken."
  // Convert all of those into a single 400 the UI can render as a
  // "Bluesky sign-in didn't complete — try again" page.
  let oauthSession;
  try {
    ({ session: oauthSession } = await client.callback(url.searchParams));
  } catch (err) {
    console.error('bsky callback failed', err);
    throw new HttpError(
      400,
      'bsky_callback_failed',
      'Bluesky sign-in could not complete. Start over from the login page.',
    );
  }

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

  const linkToUserId = (await readActiveUserId(c)) ?? undefined;
  let userId: string;
  try {
    userId = await upsertIdentity(c.env.DB, {
      provider: 'bsky',
      providerId: did,
      handle: profile.handle ?? null,
      avatarUrl: profile.avatar ?? null,
      displayName: profile.displayName || profile.handle || `bsky-${did.slice(-8)}`,
      rawProfile: profile,
      linkToUserId,
    });
  } catch (err) {
    if (err instanceof IdentityCollisionError) {
      throw new HttpError(
        409,
        'identity_already_linked',
        'This Bluesky account is already linked to a different con-sign user. Log out first to switch.',
      );
    }
    throw err;
  }

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
  const linkToUserId = (await readActiveUserId(c)) ?? undefined;
  let userId: string;
  try {
    userId = await upsertIdentity(c.env.DB, {
      provider: 'telegram',
      providerId: String(parsed.id),
      handle: parsed.username ?? null,
      // We don't store the photo_url Telegram gave us — it expires. Avatars
      // are served live via /api/avatar/tg/:id which hits the Bot API.
      avatarUrl: null,
      displayName: displayName || `tg-${parsed.id}`,
      rawProfile: parsed,
      linkToUserId,
    });
  } catch (err) {
    if (err instanceof IdentityCollisionError) {
      throw new HttpError(
        409,
        'identity_already_linked',
        'This Telegram account is already linked to a different con-sign user. Log out first to switch.',
      );
    }
    throw err;
  }

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


authRoutes.get('/me', requireUser, async (c) => {
  const userId = c.get('userId')!;
  const [displayName, identities] = await Promise.all([
    getUserDisplayName(c.env.DB, userId),
    listIdentitiesForUser(c.env.DB, userId),
  ]);
  const body: SessionUser = {
    userId,
    displayName: displayName ?? '',
    identities: identities.map((i) => ({
      provider: i.provider,
      handle: i.handle,
      avatarUrl: i.avatar_url,
    })),
  };
  return c.json(body);
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
