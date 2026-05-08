#!/usr/bin/env node
/**
 * Mints an ES256 private JWK for the Bluesky OAuth client_assertion +
 * DPoP signing. Prints the private JWK as a single-line JSON string —
 * paste it into `wrangler secret put BSKY_PRIVATE_JWK`.
 *
 * The matching public JWK is derived from the private one at request time
 * (served at /api/auth/bsky/jwks.json), so there is nothing else to copy.
 *
 * Usage:
 *   pnpm --filter @con-sign/worker run keygen:bsky
 */
import { generateKeyPair, exportJWK } from 'jose';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.alg = 'ES256';
jwk.use = 'sig';
jwk.kid = '0';

process.stdout.write(JSON.stringify(jwk) + '\n');
