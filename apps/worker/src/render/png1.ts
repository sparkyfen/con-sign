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
 * Floyd–Steinberg error diffusion. Produces a `width*height` byte array
 * with 1 = white, 0 = black, distributing each pixel's quantization
 * error to the right and bottom neighbors:
 *
 *           [  *  7/16 ]
 *   [ 3/16  5/16  1/16 ]
 *
 * This gives photo content a proper stippled appearance on 1-bit panels
 * instead of the dark blob you get from flat thresholding. The cost is
 * that crisp text/UI edges pick up a little dither noise too — if that
 * becomes a problem we'll need to mask non-photo regions.
 *
 * Float32 luminance buffer (1.5 MB at 800×480) sits well inside the
 * Workers memory ceiling.
 */
function floydSteinberg(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const lum = new Float32Array(width * height);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    lum[p] = (213 * (rgba[i] ?? 0) + 715 * (rgba[i + 1] ?? 0) + 72 * (rgba[i + 2] ?? 0)) / 1000;
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = lum[idx]!;
      const next = old > 128 ? 255 : 0;
      out[idx] = next === 255 ? 1 : 0;
      const err = old - next;
      if (x + 1 < width) lum[idx + 1] = lum[idx + 1]! + (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[idx + width - 1] = lum[idx + width - 1]! + (err * 3) / 16;
        lum[idx + width] = lum[idx + width]! + (err * 5) / 16;
        if (x + 1 < width) lum[idx + width + 1] = lum[idx + width + 1]! + (err * 1) / 16;
      }
    }
  }
  return out;
}

/**
 * Take a width*height byte array of binary pixels (1=white, 0=black)
 * and emit PNG scanlines: filter byte per row (0 = none) + pixels
 * packed 8 to a byte, MSB-first.
 */
function packScanlines(bits: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(height * (1 + bytesPerRow));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + bytesPerRow);
    out[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) {
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

  const bits = floydSteinberg(rgba, width, height);
  const scanlines = packScanlines(bits, width, height);
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
