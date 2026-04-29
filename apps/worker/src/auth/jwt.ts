/**
 * Minimal HS256 sign/verify over arbitrary JSON payloads. Sessions, invites,
 * and any future signed-token feature share this machinery.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const b64urlEncodeJson = (obj: unknown): string =>
  b64urlEncode(ENCODER.encode(JSON.stringify(obj)));

const b64urlDecodeJson = <T>(s: string): T => JSON.parse(DECODER.decode(b64urlDecode(s))) as T;

const HEADER = b64urlEncodeJson({ alg: 'HS256', typ: 'JWT' });

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

export class JwtError extends Error {
  constructor(public readonly reason: 'malformed' | 'bad_sig' | 'expired') {
    super(reason);
  }
}

/** Payloads signed with this helper must include an `exp` (unix seconds). */
export interface SignedPayloadShape {
  exp: number;
}

export async function signJwt<T extends SignedPayloadShape>(
  payload: T,
  secret: string,
): Promise<string> {
  const body = b64urlEncodeJson(payload);
  const data = `${HEADER}.${body}`;
  const key = await importKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJwt<T extends SignedPayloadShape>(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<T> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  const [h, b, s] = parts as [string, string, string];
  if (h !== HEADER) throw new JwtError('malformed');

  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(s),
    ENCODER.encode(`${h}.${b}`),
  );
  if (!ok) throw new JwtError('bad_sig');

  let payload: T;
  try {
    payload = b64urlDecodeJson<T>(b);
  } catch {
    throw new JwtError('malformed');
  }
  if (payload.exp < now) throw new JwtError('expired');
  return payload;
}
