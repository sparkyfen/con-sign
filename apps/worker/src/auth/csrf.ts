import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

/**
 * CSRF defense via the `Origin` header.
 *
 * `cs_session` is `SameSite=Lax`, which blocks most cross-origin form posts
 * but does not block top-level navigations to body-bearing requests in
 * every browser version. To close that gap, every state-changing method
 * must arrive with an `Origin` header that matches the request's own host.
 *
 * Browsers include `Origin` automatically on cross-origin requests with
 * bodies; same-origin POSTs from our own UI also include it. The only
 * realistic case where `Origin` is missing on a body-bearing request is
 * a non-browser client (curl, server-to-server). Those don't represent
 * a CSRF risk per se, but we fail closed to keep the rule simple — if
 * a future endpoint needs to be reachable without an Origin (e.g. a
 * server-to-server webhook), it can opt out individually.
 *
 * GET/HEAD/OPTIONS are skipped: they're either side-effect-free
 * (Bluesky's OAuth callback is GET) or preflight machinery.
 *
 * Device-adapter routes under /api/<device>/* are also skipped: they're
 * server-to-device, never browser-driven, and auth via their own bearer
 * header (e.g. TRMNL's Access-Token). Embedded devices don't send
 * Origin and the CSRF threat model doesn't apply to them.
 */
const DEVICE_ADAPTER_EXEMPT_PATHS = new Set([
  '/api/log', // TRMNL firmware's hardcoded log path (root alias)
]);
const DEVICE_ADAPTER_EXEMPT_PREFIXES = [
  '/api/trmnl/', // explicit TRMNL adapter namespace
];

export const csrfOriginCheck: MiddlewareHandler<Env> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }

  const path = new URL(c.req.url).pathname;
  if (
    DEVICE_ADAPTER_EXEMPT_PATHS.has(path) ||
    DEVICE_ADAPTER_EXEMPT_PREFIXES.some((p) => path.startsWith(p))
  ) {
    await next();
    return;
  }

  const origin = c.req.header('Origin');
  if (!origin) {
    throw new HttpError(403, 'origin_required');
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'origin_invalid');
  }

  const requestHost = new URL(c.req.url).host;
  if (originHost !== requestHost) {
    throw new HttpError(403, 'origin_mismatch');
  }

  await next();
};
