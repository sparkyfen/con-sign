import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';

/**
 * Set defense-in-depth security headers on every response.
 *
 *   - **HSTS** — pin the cons.social zone to HTTPS for two years; the
 *     2y/includeSubDomains/preload combo is the value Chrome's
 *     hstspreload.org requires if we ever want to submit. Safe because
 *     cons.social is HTTPS-only via Cloudflare's edge anyway.
 *   - **X-Content-Type-Options: nosniff** — kill MIME-sniffing attacks
 *     on JSON / SVG responses.
 *   - **Referrer-Policy: strict-origin-when-cross-origin** — don't leak
 *     path/query info to third-party CDNs (e.g. avatar URLs in error
 *     reports). Default in modern browsers but assert it explicitly.
 *   - **X-Frame-Options: DENY** — the API surface never wants to be
 *     framed; the Pages app sets its own clickjacking policy via CSP.
 *   - **Permissions-Policy** — disable a bundle of unused features
 *     (camera/mic/geolocation/etc.) so a future XSS can't activate them.
 *
 * CSP is intentionally not set here — the Worker mostly serves JSON,
 * which has no DOM and no scripts to govern. The Pages app sets CSP via
 * apps/web/static/_headers because it ships HTML.
 */
export const securityHeaders: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
};
