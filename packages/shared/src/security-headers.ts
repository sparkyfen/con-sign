/**
 * Single source of truth for the defense-in-depth response headers
 * con-sign sets on every response. Three call sites import these:
 *
 *   - `apps/worker/src/auth/security-headers.ts` — Hono middleware on
 *     every Worker response (no CSP; the API mostly serves JSON).
 *   - `apps/web/src/hooks.server.ts` — SvelteKit hook on every server-
 *     rendered response (BASE_HEADERS + CSP_HEADER).
 *   - `apps/web/_headers` — Cloudflare Pages static-asset header file.
 *     Hand-edited; the unit test in `security-headers.test.ts` reads it
 *     back and asserts it matches what's exported here.
 *
 * Anything that ships on cons.social must end up with this set. If you
 * adjust policy, bump the constants here — the test catches the file.
 */

export const BASE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Frame-Options', 'DENY'],
  [
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  ],
];

/**
 * CSP for HTML responses. `style-src 'unsafe-inline'` is required by
 * SvelteKit's hydration-time inline styles; tightening would require
 * SSR-nonce plumbing. Fonts are loaded from Google's CDN.
 */
export const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
