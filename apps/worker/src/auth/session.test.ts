import { describe, expect, it } from 'vitest';
import {
  SessionError,
  buildCookie,
  clearCookie,
  newUnlockSession,
  newUserSession,
  readCookie,
  signSession,
  verifySession,
} from './session.js';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('session sign/verify', () => {
  it('round-trips a user session', async () => {
    const payload = newUserSession('user-123');
    const token = await signSession(payload, SECRET);
    const parsed = await verifySession(token, SECRET);
    expect(parsed).toEqual(payload);
  });

  it('round-trips an unlock session', async () => {
    const payload = newUnlockSession('room-1', [
      { id: 'rm-a', rot: '2026-04-28T00:00:00Z' },
    ]);
    const token = await signSession(payload, SECRET);
    const parsed = await verifySession(token, SECRET);
    expect(parsed).toEqual(payload);
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession(newUserSession('u'), SECRET);
    const [h, b] = token.split('.');
    const tampered = `${h}.${b}.aaaaaaaaaaaa`;
    await expect(verifySession(tampered, SECRET)).rejects.toBeInstanceOf(SessionError);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(newUserSession('u'), 'secret-A');
    await expect(verifySession(token, 'secret-B')).rejects.toBeInstanceOf(SessionError);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { ...newUserSession('u', now - 60 * 60), exp: now - 1 };
    const token = await signSession(payload, SECRET);
    await expect(verifySession(token, SECRET)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('rejects a malformed token', async () => {
    await expect(verifySession('not-a-token', SECRET)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });
});

describe('cookie helpers', () => {
  it('builds a secure HttpOnly cookie with SameSite=Lax', () => {
    const c = buildCookie('cs_session', 'v', { secure: true, maxAgeSec: 60 });
    expect(c).toBe('cs_session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
  });

  it('omits Secure for local dev', () => {
    const c = buildCookie('cs_session', 'v', { secure: false, maxAgeSec: 60 });
    expect(c).not.toContain('Secure');
  });

  it('clearCookie sets Max-Age=0', () => {
    const c = clearCookie('cs_session', { secure: true });
    expect(c).toContain('Max-Age=0');
  });

  it('readCookie pulls a named cookie out of a header', () => {
    const header = 'foo=1; cs_session=abc.def.ghi; bar=2';
    expect(readCookie(header, 'cs_session')).toBe('abc.def.ghi');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(null, 'cs_session')).toBeNull();
  });
});
