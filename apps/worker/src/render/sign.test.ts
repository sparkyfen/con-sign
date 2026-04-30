import { describe, expect, it } from 'vitest';
import { computeConDay, renderSignSvg } from './sign.js';

describe('computeConDay', () => {
  it('returns null when startDate is missing or invalid', () => {
    expect(computeConDay(null)).toBeNull();
    expect(computeConDay('')).toBeNull();
    expect(computeConDay('not-a-date')).toBeNull();
  });

  it('returns null when today is before the con starts', () => {
    expect(computeConDay('2026-06-01', new Date('2026-05-31T23:59:00Z'))).toBeNull();
  });

  it('returns 1 on the start date itself', () => {
    expect(computeConDay('2026-06-01', new Date('2026-06-01T00:00:00Z'))).toBe(1);
    expect(computeConDay('2026-06-01', new Date('2026-06-01T23:00:00Z'))).toBe(1);
  });

  it('counts subsequent days correctly', () => {
    expect(computeConDay('2026-06-01', new Date('2026-06-02T08:00:00Z'))).toBe(2);
    expect(computeConDay('2026-06-01', new Date('2026-06-04T12:00:00Z'))).toBe(4);
  });

  it('still returns a number after the con ends — caller decides whether to show it', () => {
    // Rooms presumably get torn down post-con; we don't clamp here.
    expect(computeConDay('2026-06-01', new Date('2026-06-30T00:00:00Z'))).toBe(30);
  });
});

describe('renderSignSvg', () => {
  it('omits DAY label when conDay is null', () => {
    const svg = renderSignSvg({
      roomName: 'Room 1842',
      roommates: [],
      width: 800,
      height: 480,
      conDay: null,
    });
    expect(svg).not.toContain('DAY');
  });

  it('renders DAY 0N zero-padded for single-digit days', () => {
    const svg = renderSignSvg({
      roomName: 'Room 1842',
      roommates: [],
      width: 800,
      height: 480,
      conDay: 2,
    });
    expect(svg).toContain('DAY 02');
  });

  it('does not zero-pad two-digit days', () => {
    const svg = renderSignSvg({
      roomName: 'Room 1842',
      roommates: [],
      width: 800,
      height: 480,
      conDay: 12,
    });
    expect(svg).toContain('DAY 12');
  });
});
