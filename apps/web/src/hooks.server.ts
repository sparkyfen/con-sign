import type { Handle } from '@sveltejs/kit';

/**
 * Defense-in-depth response headers for every SvelteKit-rendered page.
 *
 * Cloudflare Pages' static `_headers` file only applies to static
 * responses (assets, prerendered pages). Pages routed through the
 * SvelteKit worker shim (adapter-cloudflare's `_worker.js`) bypass it.
 * Setting the headers here means both code paths return the same
 * defense-in-depth set, keeping the splash and any future dynamic
 * pages consistent with the static files served from `_headers`.
 *
 * The values mirror `apps/web/_headers` and `apps/worker/src/auth/
 * security-headers.ts`. Bump all three together when adjusting policy.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const h = response.headers;
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  h.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  );
  return response;
};
