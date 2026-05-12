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

let inited: Promise<void> | null = null;
const ready = (): Promise<void> => {
  inited ??= initWasm(wasm as unknown as WebAssembly.Module);
  return inited;
};

export async function renderPng(
  svg: string,
  width: number,
  _height: number,
): Promise<Uint8Array> {
  await ready();
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  return resvg.render().asPng();
}
