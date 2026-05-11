#!/usr/bin/env node
/**
 * Mints an ES256 private JWK for the Bluesky OAuth client_assertion +
 * DPoP signing.
 *
 * Two output modes:
 *   --jwk     (default)  Print a single JWK on stdout. Paste into
 *                        `wrangler secret put BSKY_PRIVATE_JWK` (legacy).
 *   --jwks    Print a 1-element JWKS array. Paste into
 *             `wrangler secret put BSKY_PRIVATE_JWKS` (preferred).
 *
 * Rotation:
 *   1. Run `--jwks` to mint the new key as a JSON array.
 *   2. Read the existing BSKY_PRIVATE_JWKS value, prepend the new key,
 *      and `wrangler secret put` the new array. Deploy.
 *   3. Wait ~24h (ATProto refresh tokens rotate single-use; JWKS cache
 *      is short — 24h is conservative).
 *   4. Drop the old key from the array; deploy.
 *
 * The matching public JWK is derived from the private one at request time
 * (served at /api/auth/bsky/jwks.json), so there is nothing else to copy.
 */
import { generateKeyPair, exportJWK } from 'jose';

const mode = process.argv.includes('--jwks') ? 'jwks' : 'jwk';
const kid = process.env.BSKY_KID ?? new Date().toISOString().slice(0, 10);

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.alg = 'ES256';
jwk.use = 'sig';
jwk.kid = kid;

if (mode === 'jwks') {
  process.stdout.write(JSON.stringify([jwk]) + '\n');
} else {
  process.stdout.write(JSON.stringify(jwk) + '\n');
}
