import { describe, expect, it } from 'vitest';
import { generatePasscode, hashPasscode, verifyPasscode } from './passcode.js';

describe('passcode hashing', () => {
  it('round-trips a hash', async () => {
    const stored = await hashPasscode('OPEN-SESAME');
    expect(await verifyPasscode('OPEN-SESAME', stored)).toBe(true);
  });

  it('rejects the wrong passcode', async () => {
    const stored = await hashPasscode('right');
    expect(await verifyPasscode('wrong', stored)).toBe(false);
  });

  it('produces a different hash on each call (random salt)', async () => {
    const a = await hashPasscode('same');
    const b = await hashPasscode('same');
    expect(a).not.toBe(b);
    expect(await verifyPasscode('same', a)).toBe(true);
    expect(await verifyPasscode('same', b)).toBe(true);
  });

  it('returns false (does not throw) for a malformed stored hash', async () => {
    expect(await verifyPasscode('x', 'not-a-hash')).toBe(false);
    expect(await verifyPasscode('x', 'pbkdf2-sha256$100000$bad')).toBe(false);
    expect(await verifyPasscode('x', '')).toBe(false);
  });
});

describe('generatePasscode', () => {
  it('produces 8-character codes from the safe alphabet', () => {
    const code = generatePasscode();
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
  });

  it('produces different codes each call (probabilistically)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePasscode()));
    expect(codes.size).toBeGreaterThan(45); // collisions extremely unlikely
  });
});
