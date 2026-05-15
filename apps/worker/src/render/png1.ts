/**
 * Encode an RGBA pixel buffer (from resvg) as a 1-bit grayscale PNG —
 * the format TRMNL firmware ≥1.5.2 wants for the panel.
 *
 * resvg-wasm's `asPng()` produces 8-bit RGBA, which TRMNL firmware
 * either rejects outright or renders as garbage. The fix is to take
 * resvg's raw pixel array (`render().pixels()`), threshold each pixel
 * to monochrome, pack 8 pixels per byte, and frame it as a PNG with
 * `color_type=0` (grayscale) and `bit_depth=1`.
 *
 * No new wasm deps: zlib comes from Workers' built-in
 * `CompressionStream('deflate')`. CRC32 is a 20-line table-based
 * implementation. Output is ~3-5 KB for our sparse text layout (the
 * RGBA version was ~10-12 KB), which matters at 12-15 polls/hour over
 * a battery-powered Wi-Fi link.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode a single PNG chunk: [length(4) | type(4) | data(n) | crc(4)] */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * Threshold an RGBA pixel to 0 (black) or 1 (white) based on luminance.
 * Standard Rec.709 weights; the constant offset rounds-to-nearest.
 *
 * For pixels with reduced alpha (anti-aliased text edges), we still
 * threshold against the original luminance — the SVG renders at full
 * alpha for non-edge pixels, so anti-alias fringes naturally land
 * close to the threshold either way.
 */
function isWhite(r: number, g: number, b: number): boolean {
  // Luminance (Rec.709): 0.2126R + 0.7152G + 0.0722B, scaled by 1000
  // to stay in integers. Threshold at 128 * 1000 = 128000.
  return 213 * r + 715 * g + 72 * b > 128000;
}

/**
 * Convert width*height*4 RGBA bytes into raw 1-bit-grayscale PNG
 * scanlines: each row is prefixed with a filter byte (0 = none), then
 * the row's pixels packed 8 to a byte, MSB-first. Returns the
 * scanline buffer ready to be zlib-deflated.
 */
function packScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(height * (1 + bytesPerRow));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + bytesPerRow);
    out[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      if (isWhite(r, g, b)) {
        const byteIdx = rowStart + 1 + (x >> 3);
        const bit = 7 - (x & 7);
        out[byteIdx] = (out[byteIdx]! | (1 << bit)) & 0xff;
      }
    }
  }
  return out;
}

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') produces RFC1950 zlib framing
  // (2-byte header + deflate stream + 4-byte adler32) which is what
  // PNG IDAT expects.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // CompressionStream wants a BufferSource; cast through Uint8Array
  // explicitly to satisfy TS's broader BufferSource union.
  await writer.write(input);
  await writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build the full PNG byte stream: signature + IHDR + IDAT + IEND.
 *
 * IHDR for 1-bit grayscale:
 *   width (4) | height (4) | bit_depth (1=1)
 *   | color_type (1=0 grayscale) | compression (1=0)
 *   | filter (1=0) | interlace (1=0)
 */
export async function encodePng1Bit(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (rgba.length < width * height * 4) {
    throw new Error(`encodePng1Bit: rgba shorter than width*height*4 (${rgba.length})`);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 1; // bit_depth
  ihdr[9] = 0; // color_type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: standard
  ihdr[12] = 0; // interlace: none

  const scanlines = packScanlines(rgba, width, height);
  const idatData = await deflate(scanlines);

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', idatData);
  const iendChunk = chunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let off = 0;
  out.set(PNG_SIGNATURE, off); off += PNG_SIGNATURE.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}
