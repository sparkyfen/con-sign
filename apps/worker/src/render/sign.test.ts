import { describe, expect, it } from 'vitest';
import { computeConDay, renderSignSvg } from './sign.js';
import type { ProjectedRoommate } from '@con-sign/shared';

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

describe('renderSignSvg DAY label', () => {
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

function baseRoom(extra: Partial<ProjectedRoommate> = {}): ProjectedRoommate {
  return {
    id: 'r1',
    role: 'admin',
    fursonaName: 'Sparky',
    ...extra,
  };
}

function renderWith(status: ProjectedRoommate['status'], now = '2026-05-14T12:00:00Z'): string {
  // The renderer reads the wall clock for duration. Patch Date temporarily.
  const RealDate = Date;
  const fixed = new RealDate(now).getTime();
  class FixedDate extends RealDate {
    constructor() {
      super(fixed);
    }
    static override now(): number {
      return fixed;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
  try {
    return renderSignSvg({
      roomName: 'R',
      roommates: [baseRoom({ status })],
      width: 800,
      height: 480,
    });
  } finally {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  }
}

describe('renderSignSvg status pill', () => {
  it('renders the "room" preset as a filled black pill with white text', () => {
    const svg = renderWith({ label: 'room', updatedAt: '2026-05-14T11:55:00Z' });
    expect(svg).toContain('fill="black"'); // pill background
    expect(svg).toContain('fill="white">ROOM');
  });

  it('renders mid-energy presets (lobby/dealers/panels) as outlined', () => {
    const svg = renderWith({ label: 'lobby', updatedAt: '2026-05-14T11:50:00Z' });
    expect(svg).toContain('stroke="black"');
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).toContain('>LOBBY');
  });

  it('renders away presets (out/asleep) with a dashed border', () => {
    const svg = renderWith({ label: 'asleep', updatedAt: '2026-05-14T10:00:00Z' });
    expect(svg).toContain('stroke-dasharray="3 2"');
    expect(svg).toContain('>ASLEEP');
  });

  it('falls back to outlined for custom statuses', () => {
    const svg = renderWith({ label: 'grabbing tea', updatedAt: '2026-05-14T11:30:00Z' });
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).toContain('GRABBING TEA');
  });

  it('appends an elapsed-time duration when updatedAt is recent', () => {
    const svg = renderWith({ label: 'asleep', updatedAt: '2026-05-14T09:46:00Z' });
    expect(svg).toMatch(/ASLEEP · 2h14m/);
  });

  it('omits the pill entirely once the status is older than 24h', () => {
    const svg = renderWith({ label: 'asleep', updatedAt: '2026-05-13T11:00:00Z' });
    expect(svg).not.toContain('ASLEEP');
  });

  it('renders the pill without a duration when updatedAt is missing', () => {
    const svg = renderWith({ label: 'room' });
    expect(svg).toContain('>ROOM<');
    expect(svg).not.toMatch(/ROOM · /);
  });
});
