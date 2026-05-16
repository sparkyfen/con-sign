import type { MiddlewareHandler } from 'hono';
import { BASE_HEADERS } from '@con-sign/shared';
import type { Env } from '../types.js';

/**
 * Defense-in-depth response headers on every Worker response. The
 * canonical list lives in `packages/shared/src/security-headers.ts`;
 * see that file for the rationale per header. CSP is intentionally
 * not set here — the Worker mostly serves JSON, which has no DOM.
 * The Pages app sets CSP on HTML responses via its own hooks.
 */
export const securityHeaders: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  for (const [name, value] of BASE_HEADERS) {
    c.header(name, value);
  }
};
