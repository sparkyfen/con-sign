/**
 * Fetch a roommate avatar from BSky/Telegram and return it as an inline
 * `data:` URI so resvg can rasterize it without itself reaching out to
 * the network during render.
 *
 * Caching: edge cache keyed by the upstream URL. BSky CDN URLs embed a
 * blob CID, so rotating the avatar rotates the URL — natural cache
 * invalidation. Telegram t.me URLs are content-addressed similarly.
 *
 * Failure modes (404, non-image content-type, network error) all return
 * null silently. The caller falls back to a text-only row. We never want
 * a missing avatar to break the whole panel.
 */
export async function fetchAvatarDataUri(url: string): Promise<string | null> {
  // BSky CDN defaults to image/webp, which resvg-wasm can't decode. The
  // CDN supports format coercion via an `@<fmt>` suffix on the blob CID;
  // forcing @jpeg gives us something resvg's image-jpeg feature does
  // know how to read.
  const fetchUrl = coerceBskyJpeg(url);

  let cached: Response | null = null;
  const haveCache = typeof caches !== 'undefined';
  const cacheKey = haveCache ? new Request(fetchUrl, { method: 'GET' }) : null;
  if (haveCache && cacheKey) {
    cached = (await caches.default.match(cacheKey)) ?? null;
  }

  let res: Response;
  try {
    res = cached ?? (await fetch(fetchUrl, { cf: { cacheTtl: 86400, cacheEverything: true } }));
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) return null;

  // Stash the fetched bytes in the edge cache (clone first — body is a stream).
  if (!cached && haveCache && cacheKey) {
    try {
      await caches.default.put(cacheKey, res.clone());
    } catch {
      // Cache put can fail (vary headers, etc) — non-fatal.
    }
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  // btoa on a binary string. Chunked to stay under V8 arg-length limits
  // for large blobs.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(bin)}`;
}

function coerceBskyJpeg(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== 'cdn.bsky.app') return url;
  // BSky paths look like /img/avatar/plain/<did>/<cid>[@<fmt>]. If a
  // format suffix is already present, respect it; otherwise pin to jpeg.
  if (/@[a-z]+$/i.test(parsed.pathname)) return url;
  parsed.pathname = `${parsed.pathname}@jpeg`;
  return parsed.toString();
}
