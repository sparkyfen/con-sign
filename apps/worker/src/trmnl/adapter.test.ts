import { describe, expect, it } from 'vitest';
import { buildDisplayEnvelope, type BuildEnvelopeArgs } from './adapter.js';

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const API_KEY = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-07-05T12:00:00Z');
const CON = { startDate: '2026-07-04', endDate: '2026-07-07' };

const base = (overrides: Partial<BuildEnvelopeArgs> = {}): BuildEnvelopeArgs => ({
  deviceId: DEVICE,
  apiKey: API_KEY,
  origin: 'https://cons.social',
  con: CON,
  state: 'paired',
  now: NOW,
  ...overrides,
});

describe('buildDisplayEnvelope', () => {
  it('points image_url at the generic device endpoint with the api_key as the URL bearer', () => {
    const env = buildDisplayEnvelope(base());
    expect(env.image_url).toContain('https://cons.social/api/device/sign.png');
    expect(env.image_url).toContain(`d=${API_KEY}`);
    expect(env.image_url).not.toContain(DEVICE); // device.id never leaks to firmware
    expect(env.image_url).toContain('fmt=png');
    expect(env.image_url).toContain('w=800');
    expect(env.image_url).toContain('h=480');
  });

  it('returns the refresh interval from policy', () => {
    expect(buildDisplayEnvelope(base()).refresh_rate).toBe(300);
  });

  it('uses the unpaired (5-min) cadence when con is null', () => {
    expect(
      buildDisplayEnvelope(base({ con: null, state: 'unpaired' })).refresh_rate,
    ).toBe(300);
  });

  it('filename buckets by refresh window so cache-busts on rotation', () => {
    const t0 = new Date('2026-07-05T12:00:00Z');
    const t1 = new Date('2026-07-05T12:04:59Z'); // same 5-min bucket
    const t2 = new Date('2026-07-05T12:05:01Z'); // next 5-min bucket

    const a = buildDisplayEnvelope(base({ now: t0 })).filename;
    const b = buildDisplayEnvelope(base({ now: t1 })).filename;
    const c = buildDisplayEnvelope(base({ now: t2 })).filename;

    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('filename changes across render-state transitions in the same bucket', () => {
    const same = (s: 'paired' | 'revoked' | 'unpaired') =>
      buildDisplayEnvelope(base({ state: s })).filename;
    expect(new Set([same('paired'), same('revoked'), same('unpaired')]).size).toBe(3);
  });

  it('filename namespaces by device.id (not api_key) so two devices can never share a frame', () => {
    const a = buildDisplayEnvelope(base({ deviceId: DEVICE })).filename;
    const b = buildDisplayEnvelope(
      base({ deviceId: 'ffffffff-0000-0000-0000-000000000000' }),
    ).filename;
    expect(a).not.toBe(b);
  });

  it('respects custom panel dimensions', () => {
    const env = buildDisplayEnvelope(base({ width: 960, height: 540 }));
    expect(env.image_url).toContain('w=960');
    expect(env.image_url).toContain('h=540');
  });
});
