/**
 * Room invite tokens. One-shot consumption is enforced by storing the jti in
 * KV under `invite:consumed:{jti}` after a successful join.
 */

import { JwtError, signJwt, verifyJwt } from './jwt.js';

const INVITE_TTL_SEC = 7 * 24 * 60 * 60;

interface InvitePayload {
  kind: 'invite';
  roomId: string;
  jti: string;
  iat: number;
  exp: number;
}

const INVITE_CONSUMED = (jti: string): string => `invite:consumed:${jti}`;

export async function createInviteToken(
  roomId: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ token: string; jti: string; exp: number }> {
  const payload: InvitePayload = {
    kind: 'invite',
    roomId,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + INVITE_TTL_SEC,
  };
  const token = await signJwt(payload, secret);
  return { token, jti: payload.jti, exp: payload.exp };
}

export class InviteError extends Error {
  constructor(public readonly reason: 'invalid' | 'expired' | 'consumed') {
    super(reason);
  }
}

export async function consumeInviteToken(
  token: string,
  secret: string,
  kv: KVNamespace,
): Promise<{ roomId: string }> {
  let payload: InvitePayload;
  try {
    payload = await verifyJwt<InvitePayload>(token, secret);
  } catch (err) {
    if (err instanceof JwtError) {
      throw new InviteError(err.reason === 'expired' ? 'expired' : 'invalid');
    }
    throw err;
  }
  if (payload.kind !== 'invite') throw new InviteError('invalid');

  const already = await kv.get(INVITE_CONSUMED(payload.jti));
  if (already) throw new InviteError('consumed');

  await kv.put(INVITE_CONSUMED(payload.jti), '1', {
    expirationTtl: Math.max(60, payload.exp - Math.floor(Date.now() / 1000)),
  });
  return { roomId: payload.roomId };
}
