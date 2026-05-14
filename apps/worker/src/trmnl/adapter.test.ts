import { describe, expect, it } from 'vitest';
import { buildDisplayEnvelope } from './adapter.js';

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = new Date('2026-07-05T12:00:00Z'); // mid-con per the test fixture
const CON = { startDate: '2026-07-04', endDate: '2026-07-07' };

describe('buildDisplayEnvelope', () => {
  it('points image_url at the generic device endpoint with the bearer', () => {
    const env = buildDisplayEnvelope({
      deviceId: DEVICE,
      origin: 'https://cons.social',
      con: CON,
      now: NOW,
    });
    expect(env.image_url).toContain('https://cons.social/api/device/sign.png');
    expect(env.image_url).toContain(`d=${DEVICE}`);
    expect(env.image_url).toContain('fmt=png');
    expect(env.image_url).toContain('w=800');
    expect(env.image_url).toContain('h=480');
  });

  it('returns the refresh interval from policy', () => {
    const env = buildDisplayEnvelope({
      deviceId: DEVICE,
      origin: 'https://cons.social',
      con: CON,
      now: NOW,
    });
    expect(env.refresh_rate).toBe(300); // during-con
  });

  it('uses the unpaired (5-min) cadence when con is null', () => {
    const env = buildDisplayEnvelope({
      deviceId: DEVICE,
      origin: 'https://cons.social',
      con: null,
      now: NOW,
    });
    expect(env.refresh_rate).toBe(300);
  });

  it('filename buckets by refresh window so cache-busts on rotation', () => {
    const t0 = new Date('2026-07-05T12:00:00Z');
    const t1 = new Date('2026-07-05T12:04:59Z'); // same 5-min bucket
    const t2 = new Date('2026-07-05T12:05:01Z'); // next 5-min bucket

    const a = buildDisplayEnvelope({ deviceId: DEVICE, origin: 'https://cons.social', con: CON, now: t0 }).filename;
    const b = buildDisplayEnvelope({ deviceId: DEVICE, origin: 'https://cons.social', con: CON, now: t1 }).filename;
    const c = buildDisplayEnvelope({ deviceId: DEVICE, origin: 'https://cons.social', con: CON, now: t2 }).filename;

    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('respects custom panel dimensions', () => {
    const env = buildDisplayEnvelope({
      deviceId: DEVICE,
      origin: 'https://cons.social',
      con: CON,
      now: NOW,
      width: 960,
      height: 540,
    });
    expect(env.image_url).toContain('w=960');
    expect(env.image_url).toContain('h=540');
  });
});
