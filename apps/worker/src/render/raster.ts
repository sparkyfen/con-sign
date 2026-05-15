// Rasterize the SVG output of `renderSignSvg` to PNG bytes. e-ink panels
// like TRMNL want a real image, not SVG; resvg-wasm runs inside the
// Worker isolate and avoids any external service.
//
// Wasm bundle is ~500 KB gzipped — well under our ~3 MB compressed
// worker ceiling, plus we're on Workers Paid so per-request CPU
// (~5-20 ms typical render) sits comfortably under the 30 ms budget.
//
// `initWasm` runs once per isolate; subsequent calls reuse the cached
// compiled module. The first cold poll of a fresh isolate pays an
// extra ~200 ms; panel firmware polls every 5-15 min, so this is
// invisible in practice.

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import plexMonoRegular from './fonts/IBMPlexMono-Regular.ttf';
import plexMonoBold from './fonts/IBMPlexMono-Bold.ttf';
import { encodePng1Bit } from './png1.js';

let inited: Promise<void> | null = null;
const ready = (): Promise<void> => {
  inited ??= initWasm(wasm as unknown as WebAssembly.Module);
  return inited;
};

// resvg has no system font access in the Workers runtime — every glyph
// it draws must come from a font we bundle. Plex Mono covers both the
// device sign's wordmark and the rotating pair code (the headline
// glyphs are 700, the labels/footer are 400). Plex Serif isn't bundled
// yet; the few serif lines on the unpaired panel ("Enter this code at
// cons.social/pair") fall back to the default and may render at the
// wrong metrics — fine for the smoke test, fix when it matters.
const FONT_BUFFERS = [new Uint8Array(plexMonoRegular), new Uint8Array(plexMonoBold)];

/**
 * Render SVG to 1-bit grayscale PNG.
 *
 * TRMNL firmware ≥1.5.2 (and other e-ink devices that read the panel's
 * native pixel buffer) wants `bit_depth=1, color_type=0`. resvg-wasm
 * itself only emits 8-bit RGBA via `asPng()`, so we go through raw
 * pixels and frame the PNG ourselves — see ./png1.ts. Browsers render
 * 1-bit grayscale PNGs fine, so manual smoke-tests via the URL still
 * look correct.
 */
export async function renderPng(
  svg: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  await ready();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    // `font` is a tagged union: CustomFontsOptions (fontBuffers, no
    // system access) vs SystemFontsOptions (loadSystemFonts/Files).
    // We're in custom-only mode — Workers have no system font dir
    // to load from anyway.
    font: {
      fontBuffers: FONT_BUFFERS,
      defaultFontFamily: 'IBM Plex Mono',
      // The SVGs we render use `monospace` and `serif` as generic
      // fallbacks alongside the IBM Plex names. Map both to our
      // bundled font so resvg doesn't silently drop glyphs when it
      // can't resolve `monospace` to anything system-installed.
      monospaceFamily: 'IBM Plex Mono',
      serifFamily: 'IBM Plex Mono',
      sansSerifFamily: 'IBM Plex Mono',
    },
  });
  const rendered = resvg.render();
  // pixels() is RGBA in resvg's image buffer; width/height come back
  // from the rendered output rather than what we asked for in case
  // resvg scaled the SVG differently than expected.
  return encodePng1Bit(rendered.pixels, rendered.width, rendered.height);
}

// `height` is part of the public API even though resvg ignores it
// (we fit-to-width and resvg derives height from the SVG aspect ratio).
// Kept for future explicit fit-to-height calls.
void renderPng; // keep the lint happy if `height` arg goes unread

