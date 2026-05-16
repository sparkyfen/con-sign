import type { Handle } from '@sveltejs/kit';
import { BASE_HEADERS, CSP_HEADER } from '@con-sign/shared';

/**
 * Defense-in-depth headers for every SvelteKit-rendered page. The
 * canonical values live in `packages/shared/src/security-headers.ts`
 * and the same set is mirrored on the Worker (`apps/worker/src/auth/
 * security-headers.ts`) and on the static `_headers` file
 * (`apps/web/_headers`, asserted by a unit test in shared).
 *
 * Cloudflare Pages' static `_headers` file only applies to static
 * responses (assets, prerendered pages). Pages routed through
 * adapter-cloudflare's `_worker.js` bypass it; this hook covers them.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const h = response.headers;
  for (const [name, value] of BASE_HEADERS) {
    h.set(name, value);
  }
  h.set('Content-Security-Policy', CSP_HEADER);
  return response;
};
