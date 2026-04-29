import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import {
  SESSION_COOKIE,
  SessionError,
  isRevoked,
  readCookie,
  verifySession,
} from './session.js';

/**
 * Requires a valid admin/roommate session cookie. Sets `userId` on the Hono
 * context. Throws 401 on missing/expired/revoked.
 */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const token = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'unauthenticated');

  let payload;
  try {
    payload = await verifySession(token, c.env.SESSION_HMAC);
  } catch (err) {
    if (err instanceof SessionError) throw new HttpError(401, 'unauthenticated', err.reason);
    throw err;
  }

  if (payload.kind !== 'user') throw new HttpError(401, 'unauthenticated');
  if (await isRevoked(c.env.SESSIONS, payload.jti)) {
    throw new HttpError(401, 'unauthenticated', 'revoked');
  }
  c.set('userId', payload.sub);
  await next();
};
