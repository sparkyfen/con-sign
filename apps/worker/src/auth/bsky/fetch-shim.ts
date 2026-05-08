/**
 * Cloudflare Workers compatibility shims for @atproto/oauth-client.
 *
 * The library uses two RequestInit fields the Workers runtime rejects:
 *   - `cache`             — not implemented (we drop it; the OAuth flow
 *                           doesn't actually rely on browser cache semantics).
 *   - `redirect: 'error'` — not implemented (we remap to 'manual', which is
 *                           equally safe for our use: we never want the OAuth
 *                           library to follow redirects implicitly).
 *
 * These shims patch globalThis.Request and globalThis.fetch the first time
 * this module is imported. Import it once, before importing anything from
 * @atproto/oauth-client.
 *
 * Source pattern: https://gist.github.com/kaytwo/d5e553a6fce20e28f6d5573a520fb525
 */

const OriginalRequest = globalThis.Request;

class WorkerRequest extends OriginalRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, sanitize(init));
  }
}

function sanitize(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return init;
  // `cache` is a DOM RequestInit field — Workers' RequestInit type omits it,
  // but library callers (including @atproto's) still set it. Cast to drop.
  const { cache: _cache, redirect, ...rest } = init as RequestInit & { cache?: unknown };
  void _cache;
  if (redirect === 'error') {
    (rest as RequestInit).redirect = 'manual';
  } else if (redirect) {
    (rest as RequestInit).redirect = redirect;
  }
  return rest;
}

globalThis.Request = WorkerRequest as unknown as typeof Request;

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.redirect === 'error') {
    init = { ...init, redirect: 'manual' };
  }
  return originalFetch(input, init);
}) as typeof fetch;
