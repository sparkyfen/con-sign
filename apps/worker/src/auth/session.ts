/**
 * Session tokens — minimal HS256 JWT-ish using Web Crypto.
 *
 * Two flavors of payload travel through the same machinery:
 *
 *  - Admin/roommate session: { kind: 'user', sub, jti, iat, exp }
 *    Cookie: `cs_session`. 30-day expiry. KV-revocable by jti.
 *
 *  - Visitor unlock: { kind: 'unlock', roomId, unlocked: [{ id, rot }], iat, exp }
 *    Cookie: `cs_unlock_{roomId}`. 24-hour expiry. Each unlocked roommate has
 *    their `passcode_rotated_at` snapshot baked into the cookie; if the
 *    server's stored timestamp is newer, that roommate is dropped from the
 *    effective unlocked set on the next request (forces a re-unlock).
 *
 *  We use a hand-rolled HS256 instead of pulling a JWT lib because Workers'
 *  Web Crypto is enough and the dep would be ~200KB of bundle for the bits
 *  of RFC7519 we actually use.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const UNLOCK_TTL_SEC = 24 * 60 * 60;

export const SESSION_COOKIE = 'cs_session';
export const unlockCookieName = (roomId: string): string => `cs_unlock_${roomId}`;

export interface UserSessionPayload {
  kind: 'user';
  sub: string; // user_id
  jti: string;
  iat: number;
  exp: number;
}

export interface UnlockedRoommateRef {
  id: string;
  /** ISO timestamp from `roommate.passcode_rotated_at` at unlock time. */
  rot: string;
}

export interface UnlockSessionPayload {
  kind: 'unlock';
  roomId: string;
  unlocked: UnlockedRoommateRef[];
  iat: number;
  exp: number;
}

export type SessionPayload = UserSessionPayload | UnlockSessionPayload;

export class SessionError extends Error {
  constructor(public readonly reason: 'malformed' | 'bad_sig' | 'expired') {
    super(reason);
  }
}

// ─── encoding ──────────────────────────────────────────────────────────────

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const b64urlEncodeJson = (obj: unknown): string =>
  b64urlEncode(ENCODER.encode(JSON.stringify(obj)));

const b64urlDecodeJson = <T>(s: string): T => JSON.parse(DECODER.decode(b64urlDecode(s))) as T;

// ─── HMAC ──────────────────────────────────────────────────────────────────

const importKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

const HEADER_HS256 = b64urlEncodeJson({ alg: 'HS256', typ: 'JWT' });

// ─── public API ────────────────────────────────────────────────────────────

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64urlEncodeJson(payload);
  const data = `${HEADER_HS256}.${body}`;
  const key = await importKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionError('malformed');
  const [h, b, s] = parts as [string, string, string];
  if (h !== HEADER_HS256) throw new SessionError('malformed');

  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(s),
    ENCODER.encode(`${h}.${b}`),
  );
  if (!ok) throw new SessionError('bad_sig');

  let payload: SessionPayload;
  try {
    payload = b64urlDecodeJson<SessionPayload>(b);
  } catch {
    throw new SessionError('malformed');
  }
  if (payload.exp < now) throw new SessionError('expired');
  return payload;
}

// ─── builders ──────────────────────────────────────────────────────────────

export function newUserSession(userId: string, now = Math.floor(Date.now() / 1000)): UserSessionPayload {
  return {
    kind: 'user',
    sub: userId,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + SESSION_TTL_SEC,
  };
}

export function newUnlockSession(
  roomId: string,
  unlocked: UnlockedRoommateRef[],
  now = Math.floor(Date.now() / 1000),
): UnlockSessionPayload {
  return {
    kind: 'unlock',
    roomId,
    unlocked,
    iat: now,
    exp: now + UNLOCK_TTL_SEC,
  };
}

// ─── revocation (admin sessions only) ──────────────────────────────────────

const REVOKE_KEY = (jti: string): string => `session:revoked:${jti}`;

export async function revokeSession(kv: KVNamespace, jti: string, expSec: number): Promise<void> {
  const ttl = Math.max(60, expSec - Math.floor(Date.now() / 1000));
  await kv.put(REVOKE_KEY(jti), '1', { expirationTtl: ttl });
}

export async function isRevoked(kv: KVNamespace, jti: string): Promise<boolean> {
  return (await kv.get(REVOKE_KEY(jti))) !== null;
}

// ─── cookie helpers ────────────────────────────────────────────────────────

export interface CookieOptions {
  /** True in production (https). False under local wrangler dev. */
  secure: boolean;
  maxAgeSec: number;
  /** Optional path scope. Default '/'. */
  path?: string;
}

export function buildCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${opts.maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, opts: Pick<CookieOptions, 'secure' | 'path'>): string {
  return buildCookie(name, '', { ...opts, maxAgeSec: 0 });
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}
