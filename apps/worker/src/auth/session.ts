/**
 * Session tokens — sign/verify built on the generic jwt.ts helper.
 *
 *  - Admin/roommate session: { kind: 'user', sub, jti, iat, exp }
 *    Cookie: `cs_session`. 30-day expiry. KV-revocable by jti.
 *
 *  - Visitor unlock: { kind: 'unlock', roomId, unlocked: [{ id, rot }], iat, exp }
 *    Cookie: `cs_unlock_{roomId}`. 24-hour expiry. Each unlocked roommate has
 *    their `passcode_rotated_at` snapshot baked into the cookie; if the
 *    server's stored timestamp is newer, that roommate is dropped from the
 *    effective unlocked set on the next request (forces a re-unlock).
 */

import { JwtError, signJwt, verifyJwt } from './jwt.js';

const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const UNLOCK_TTL_SEC = 24 * 60 * 60;

export const SESSION_COOKIE = 'cs_session';
export const unlockCookieName = (roomId: string): string => `cs_unlock_${roomId}`;

export interface UserSessionPayload {
  kind: 'user';
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface UnlockedRoommateRef {
  id: string;
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

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  return signJwt(payload, secret);
}

export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload> {
  try {
    return await verifyJwt<SessionPayload>(token, secret, now);
  } catch (err) {
    if (err instanceof JwtError) throw new SessionError(err.reason);
    throw err;
  }
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
  secure: boolean;
  maxAgeSec: number;
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
