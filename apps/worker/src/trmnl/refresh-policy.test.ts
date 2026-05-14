import { describe, expect, it } from 'vitest';
import { nextRefreshSec } from './refresh-policy.js';

const con = { startDate: '2026-07-04', endDate: '2026-07-07' };

describe('nextRefreshSec', () => {
  it('returns 5min during the con', () => {
    expect(nextRefreshSec(con, new Date('2026-07-05T12:00:00Z'))).toBe(300);
  });

  it('treats the start date itself as during', () => {
    expect(nextRefreshSec(con, new Date('2026-07-04T00:00:01Z'))).toBe(300);
  });

  it('treats the end date itself as during, through 23:59:59 UTC', () => {
    expect(nextRefreshSec(con, new Date('2026-07-07T23:00:00Z'))).toBe(300);
  });

  it('returns 1h in the 7-day window before the con', () => {
    expect(nextRefreshSec(con, new Date('2026-06-28T12:00:00Z'))).toBe(3600);
    expect(nextRefreshSec(con, new Date('2026-07-03T23:59:00Z'))).toBe(3600);
  });

  it('returns 1h in the 7-day window after the con', () => {
    expect(nextRefreshSec(con, new Date('2026-07-08T01:00:00Z'))).toBe(3600);
    expect(nextRefreshSec(con, new Date('2026-07-14T22:00:00Z'))).toBe(3600);
  });

  it('returns 24h far before the con', () => {
    expect(nextRefreshSec(con, new Date('2026-01-01T12:00:00Z'))).toBe(86400);
  });

  it('returns 24h far after the con', () => {
    expect(nextRefreshSec(con, new Date('2026-09-01T12:00:00Z'))).toBe(86400);
  });

  it('returns 5min when the device has no con (unpaired)', () => {
    expect(nextRefreshSec(null, new Date('2026-07-05T12:00:00Z'))).toBe(300);
  });

  it('returns 5min on a malformed con (defensive)', () => {
    expect(nextRefreshSec({ startDate: 'nope', endDate: 'nope' })).toBe(300);
    expect(nextRefreshSec({ startDate: null, endDate: '2026-07-07' })).toBe(300);
  });
});
