import { describe, expect, it } from 'vitest';
import {
  consumePairCode,
  generatePairCode,
  getOrCreatePairCode,
  normalizePairCode,
} from './pair-code.js';

// Tiny in-memory KV stub. Doesn't honor TTL — the unit test only exercises
// behavior within a single window; TTL semantics live in real Workers KV.
function createKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe('generatePairCode', () => {
  it('returns 6 ambiguity-safe chars', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

describe('normalizePairCode', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizePairCode('k 9 t m 4 x')).toBe('K9TM4X');
    expect(normalizePairCode('K9TM4X')).toBe('K9TM4X');
    expect(normalizePairCode('  K9TM-4X  ')).toBe('K9TM4X');
  });
});

describe('getOrCreatePairCode', () => {
  it('mints a code and is idempotent within the TTL', async () => {
    const kv = createKV();
    const code1 = await getOrCreatePairCode(kv, 'device-A');
    const code2 = await getOrCreatePairCode(kv, 'device-A');
    expect(code1).toBe(code2);
  });

  it('mints distinct codes for different devices', async () => {
    const kv = createKV();
    const a = await getOrCreatePairCode(kv, 'device-A');
    const b = await getOrCreatePairCode(kv, 'device-B');
    expect(a).not.toBe(b);
  });
});

describe('consumePairCode', () => {
  it('returns the device_id and invalidates both keys', async () => {
    const kv = createKV();
    const code = await getOrCreatePairCode(kv, 'device-X');
    const got = await consumePairCode(kv, code);
    expect(got).toBe('device-X');
    // Reusing the same code now fails.
    expect(await consumePairCode(kv, code)).toBeNull();
    // Polling again mints a fresh code (the device-side key was also cleared).
    const next = await getOrCreatePairCode(kv, 'device-X');
    expect(next).not.toBe(code);
  });

  it('accepts spaces and lowercase from the admin form', async () => {
    const kv = createKV();
    const code = await getOrCreatePairCode(kv, 'device-Y');
    const formatted = code.split('').join(' ').toLowerCase();
    expect(await consumePairCode(kv, formatted)).toBe('device-Y');
  });

  it('returns null for unknown or malformed codes', async () => {
    const kv = createKV();
    expect(await consumePairCode(kv, 'NOPE12')).toBeNull();
    expect(await consumePairCode(kv, 'too-short')).toBeNull();
  });
});
