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

export async function renderPng(
  svg: string,
  width: number,
  _height: number,
): Promise<Uint8Array> {
  await ready();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontBuffers: FONT_BUFFERS,
      // Fall back to Plex Mono for any family the SVG asks for that we
      // don't have bundled (e.g. ui-serif). Resvg picks this name from
      // the font table of the buffers above.
      defaultFontFamily: 'IBM Plex Mono',
      loadSystemFonts: false,
    },
  });
  return resvg.render().asPng();
}
