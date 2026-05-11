// Side-effect: must run before importing @atproto/oauth-client.
import './fetch-shim.js';

import { XrpcHandleResolver } from '@atproto-labs/handle-resolver';
import { JoseKey } from '@atproto/jwk-jose';
import {
  OAuthClient,
  type DigestAlgorithm,
  type InternalStateData,
  type Key,
  type Session,
} from '@atproto/oauth-client';
import type { JWK } from 'jose';
import type { Bindings } from '../../types.js';

/**
 * Production base URL — matches our zone. The OAuth client_id is the URL of
 * the metadata document, so this string is part of our public identity to
 * Bluesky's authorization servers.
 */
const BASE_URL = 'https://cons.social';

/**
 * `client_id` is the absolute URL where we serve client_metadata.json. The
 * metadata URL itself is the identifier — that's how AT Protocol OAuth works.
 */
export const CLIENT_METADATA_URL = `${BASE_URL}/api/auth/bsky/client-metadata.json`;
const JWKS_URL = `${BASE_URL}/api/auth/bsky/jwks.json`;
const REDIRECT_URI = `${BASE_URL}/api/auth/bsky/callback`;

const STATE_PREFIX = 'bsky:state:';
const SESSION_PREFIX = 'bsky:session:';

const handleResolver = new XrpcHandleResolver('https://bsky.social');

type SerializedState = Omit<InternalStateData, 'dpopKey'> & {
  dpopKey: Record<string, unknown> | undefined;
};

type SerializedSession = Omit<Session, 'dpopKey'> & {
  dpopKey: Record<string, unknown>;
};

/**
 * Load every signing key the Worker should publish.
 *
 * Accepts two secret shapes for backwards compat with the original deploy:
 *   - `BSKY_PRIVATE_JWKS`: JSON array of private JWKs (preferred). The
 *     first entry signs; all entries publish.
 *   - `BSKY_PRIVATE_JWK`: single JSON-encoded private JWK (legacy). Used
 *     iff BSKY_PRIVATE_JWKS is unset.
 *
 * Rotation procedure:
 *   1. Mint a new key with `pnpm run keygen:bsky`.
 *   2. Prepend it to the existing JWKS array; deploy. New tokens sign with
 *      the new key, the AS still verifies tokens issued with the old key
 *      via /jwks.json.
 *   3. Wait long enough for in-flight refresh tokens to be exchanged
 *      (~24h is wildly conservative; ATProto refresh tokens are
 *      single-use and rotate per call, JWKS cache is short).
 *   4. Drop the old key on the next deploy.
 */
async function loadKeyset(env: Bindings): Promise<JoseKey[]> {
  const raw = env.BSKY_PRIVATE_JWKS ?? (env.BSKY_PRIVATE_JWK ? `[${env.BSKY_PRIVATE_JWK}]` : null);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as JWK[];
  if (!Array.isArray(parsed)) {
    throw new Error('BSKY_PRIVATE_JWKS must decode to an array of JWKs');
  }
  return Promise.all(
    parsed.map((jwk, i) =>
      JoseKey.fromJWK(withAlg(jwk) as unknown as Record<string, unknown>, jwk.kid ?? String(i)),
    ),
  );
}

function withAlg(jwk: JWK): JWK {
  if (jwk.alg) return jwk;
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return { ...jwk, alg: 'ES256' };
  if (jwk.kty === 'EC' && jwk.crv === 'P-384') return { ...jwk, alg: 'ES384' };
  if (jwk.kty === 'EC' && jwk.crv === 'P-521') return { ...jwk, alg: 'ES512' };
  if (jwk.kty === 'RSA') return { ...jwk, alg: 'RS256' };
  throw new Error(`Cannot infer alg for jwk kty=${jwk.kty} crv=${jwk.crv}`);
}

/**
 * Build the OAuth client. Call once per request — the OAuth library itself is
 * stateless; persistence lives in the KV stores we wire here.
 *
 * `BSKY_PRIVATE_JWK` is a JSON-encoded private JWK (ES256). Generated once
 * via `pnpm --filter @con-sign/worker run keygen:bsky` and pasted into
 * `wrangler secret put BSKY_PRIVATE_JWK`.
 */
export async function createBskyClient(env: Bindings): Promise<OAuthClient> {
  const keyset = await loadKeyset(env);
  if (keyset.length === 0) {
    throw new Error('No BSKY signing key configured (set BSKY_PRIVATE_JWKS or BSKY_PRIVATE_JWK)');
  }

  return new OAuthClient({
    fetch: globalThis.fetch,
    responseMode: 'query',
    handleResolver,

    runtimeImplementation: {
      async createKey(algs: string[]): Promise<Key> {
        const key = await JoseKey.generate(algs);
        return key;
      },
      getRandomValues: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
      async digest(data: Uint8Array, { name }: DigestAlgorithm): Promise<Uint8Array> {
        if (name !== 'sha256' && name !== 'sha384' && name !== 'sha512') {
          throw new Error(`Unsupported digest: ${name}`);
        }
        const buf = await crypto.subtle.digest(`SHA-${name.slice(3)}`, data);
        return new Uint8Array(buf);
      },
    },

    clientMetadata: {
      client_id: CLIENT_METADATA_URL,
      client_name: 'con-sign',
      client_uri: BASE_URL,
      redirect_uris: [REDIRECT_URI],
      scope: 'atproto transition:generic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      dpop_bound_access_tokens: true,
      jwks_uri: JWKS_URL,
    },

    // First key in the array signs new client_assertion JWTs and DPoP
    // proofs. The remaining keys are still published on /jwks.json so that
    // any access tokens minted with the previous key (within the AS's JWKS
    // cache window) continue to verify.
    keyset,

    stateStore: {
      async set(key, value) {
        const ser: SerializedState = {
          ...value,
          dpopKey: value.dpopKey.privateJwk as Record<string, unknown>,
        };
        // 10 minute TTL: state is only needed across the redirect roundtrip.
        await env.SESSIONS.put(STATE_PREFIX + key, JSON.stringify(ser), {
          expirationTtl: 600,
        });
      },
      async get(key) {
        const raw = await env.SESSIONS.get<SerializedState>(STATE_PREFIX + key, 'json');
        if (!raw || !raw.dpopKey) return undefined;
        return { ...raw, dpopKey: await JoseKey.fromJWK(raw.dpopKey) };
      },
      async del(key) {
        await env.SESSIONS.delete(STATE_PREFIX + key);
      },
    },

    sessionStore: {
      async set(sub, session) {
        const ser: SerializedSession = {
          ...session,
          dpopKey: session.dpopKey.privateJwk as Record<string, unknown>,
        };
        await env.SESSIONS.put(SESSION_PREFIX + sub, JSON.stringify(ser));
      },
      async get(sub) {
        const raw = await env.SESSIONS.get<SerializedSession>(SESSION_PREFIX + sub, 'json');
        if (!raw) return undefined;
        return {
          ...raw,
          dpopKey: await JoseKey.fromJWK(raw.dpopKey),
        } as unknown as Session;
      },
      async del(sub) {
        await env.SESSIONS.delete(SESSION_PREFIX + sub);
      },
    },
  });
}
