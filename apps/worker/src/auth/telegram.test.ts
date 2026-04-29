import { describe, expect, it } from 'vitest';
import { TelegramAuthError, verifyTelegramLogin } from './telegram.js';

const BOT_TOKEN = '123456:abcdef-test-token';

const signedPayload = async (
  fields: Record<string, string | number>,
  botToken: string,
): Promise<Record<string, unknown>> => {
  const enc = new TextEncoder();
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString)),
  );
  const hash = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  return { ...fields, hash };
};

describe('verifyTelegramLogin', () => {
  it('accepts a properly signed payload', async () => {
    const auth_date = Math.floor(Date.now() / 1000);
    const payload = await signedPayload(
      { id: 12345, first_name: 'Sparky', username: 'sparky', auth_date },
      BOT_TOKEN,
    );
    const result = await verifyTelegramLogin(payload, BOT_TOKEN);
    expect(result.id).toBe(12345);
    expect(result.username).toBe('sparky');
  });

  it('rejects a payload signed with a different bot token', async () => {
    const auth_date = Math.floor(Date.now() / 1000);
    const payload = await signedPayload(
      { id: 1, first_name: 'F', auth_date },
      'other-token',
    );
    await expect(verifyTelegramLogin(payload, BOT_TOKEN)).rejects.toMatchObject({
      reason: 'bad_hash',
    });
  });

  it('rejects a tampered payload (wrong username)', async () => {
    const auth_date = Math.floor(Date.now() / 1000);
    const payload = await signedPayload(
      { id: 1, first_name: 'F', username: 'real', auth_date },
      BOT_TOKEN,
    );
    payload['username'] = 'fake';
    await expect(verifyTelegramLogin(payload, BOT_TOKEN)).rejects.toMatchObject({
      reason: 'bad_hash',
    });
  });

  it('rejects an auth_date older than 24 hours', async () => {
    const auth_date = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    const payload = await signedPayload(
      { id: 1, first_name: 'F', auth_date },
      BOT_TOKEN,
    );
    await expect(verifyTelegramLogin(payload, BOT_TOKEN)).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('rejects a missing required field via zod', async () => {
    await expect(verifyTelegramLogin({ id: 1, hash: 'x' }, BOT_TOKEN)).rejects.not.toBeInstanceOf(
      TelegramAuthError,
    );
  });
});
