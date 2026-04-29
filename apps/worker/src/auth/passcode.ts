/**
 * Passcode hashing.
 *
 * For our threat model (online attacks against 8-char base32 passcodes,
 * gated by Workers Rate Limiting + Cloudflare Rate Limiting Rules +
 * Turnstile after 3 failures), PBKDF2-SHA256 is ample. We chose it over
 * argon2 for two reasons:
 *
 *  1. It's native Web Crypto — no wasm payload added to the Worker bundle.
 *  2. The unlock endpoint verifies the submitted passcode against *every*
 *     roommate in the room (additive unlock model). Argon2 at ~100ms × N
 *     roommates would add visible latency; PBKDF2 stays well under that.
 *
 * Storage format is versioned: `pbkdf2-sha256$<iter>$<salt-b64url>$<hash-b64url>`
 * so we can rotate algorithms in the future without ambiguity.
 */

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const VERSION = 'pbkdf2-sha256';

const enc = new TextEncoder();

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function deriveBytes(
  passcode: string,
  salt: Uint8Array,
  iterations: number,
  bytes: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passcode),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const buf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    bytes * 8,
  );
  return new Uint8Array(buf);
}

export async function hashPasscode(passcode: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBytes(passcode, salt, ITERATIONS, HASH_BYTES);
  return `${VERSION}$${ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

/**
 * Constant-time verify against a stored hash. Returns false rather than
 * throwing on a malformed stored hash so a bad row in the DB can't crash
 * the unlock loop.
 */
export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  const iter = Number(parts[1]);
  if (!Number.isInteger(iter) || iter < 1 || iter > 10_000_000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64urlDecode(parts[2]!);
    expected = b64urlDecode(parts[3]!);
  } catch {
    return false;
  }

  const candidate = await deriveBytes(passcode, salt, iter, expected.length);
  return constantTimeEqualBytes(candidate, expected);
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ─── generation ────────────────────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // Crockford-ish, no I/L/O/U/0/1
const PASSCODE_LEN = 8;

/**
 * Generate a random 8-character passcode. ~40 bits of entropy. Safe to
 * display to users — humans can read and type it without confusion.
 */
export function generatePasscode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSCODE_LEN));
  let out = '';
  for (let i = 0; i < PASSCODE_LEN; i++) {
    out += BASE32_ALPHABET[(bytes[i] ?? 0) % BASE32_ALPHABET.length];
  }
  return out;
}
