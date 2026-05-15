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
  it('omits DAY label when conDay is null', async () => {
    const svg = await renderSignSvg({
      roomName: 'Room 1842',
      roommates: [],
      width: 800,
      height: 480,
      conDay: null,
    });
    expect(svg).not.toContain('DAY');
  });

  it('renders DAY 0N zero-padded for single-digit days', async () => {
    const svg = await renderSignSvg({
      roomName: 'Room 1842',
      roommates: [],
      width: 800,
      height: 480,
      conDay: 2,
    });
    expect(svg).toContain('DAY 02');
  });

  it('does not zero-pad two-digit days', async () => {
    const svg = await renderSignSvg({
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

async function renderWith(
  status: ProjectedRoommate['status'],
  now = '2026-05-14T12:00:00Z',
): Promise<string> {
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
    return await renderSignSvg({
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
  it('renders the "room" preset as a filled black pill with white text', async () => {
    const svg = await renderWith({ label: 'room', updatedAt: '2026-05-14T11:55:00Z' });
    expect(svg).toContain('fill="black"'); // pill background
    expect(svg).toContain('fill="white">ROOM');
  });

  it('renders mid-energy presets (lobby/dealers/panels) as outlined', async () => {
    const svg = await renderWith({ label: 'lobby', updatedAt: '2026-05-14T11:50:00Z' });
    expect(svg).toContain('stroke="black"');
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).toContain('>LOBBY');
  });

  it('renders away presets (out/asleep) with a dashed border', async () => {
    const svg = await renderWith({ label: 'asleep', updatedAt: '2026-05-14T10:00:00Z' });
    expect(svg).toContain('stroke-dasharray="3 2"');
    expect(svg).toContain('>ASLEEP');
  });

  it('falls back to outlined for custom statuses', async () => {
    const svg = await renderWith({ label: 'grabbing tea', updatedAt: '2026-05-14T11:30:00Z' });
    expect(svg).not.toContain('stroke-dasharray');
    expect(svg).toContain('GRABBING TEA');
  });

  it('appends an elapsed-time duration when updatedAt is recent', async () => {
    const svg = await renderWith({ label: 'asleep', updatedAt: '2026-05-14T09:46:00Z' });
    expect(svg).toMatch(/ASLEEP · 2h14m/);
  });

  it('omits the pill entirely once the status is older than 24h', async () => {
    const svg = await renderWith({ label: 'asleep', updatedAt: '2026-05-13T11:00:00Z' });
    expect(svg).not.toContain('ASLEEP');
  });

  it('renders the pill without a duration when updatedAt is missing', async () => {
    const svg = await renderWith({ label: 'room' });
    expect(svg).toContain('>ROOM<');
    expect(svg).not.toMatch(/ROOM · /);
  });
});

describe('renderSignSvg avatars', () => {
  it('embeds an inline <image> tag and shifts text right when the fetcher returns a data URI', async () => {
    const dataUri = 'data:image/png;base64,AAAA';
    const svg = await renderSignSvg({
      roomName: 'R',
      roommates: [
        {
          id: 'r1',
          role: 'admin',
          fursonaName: 'Sparky',
          avatarUrl: 'https://cdn.bsky.app/img/avatar/plain/did/x@jpeg',
        },
      ],
      width: 800,
      height: 480,
      fetchAvatar: async () => dataUri,
    });
    expect(svg).toContain(`href="${dataUri}"`);
    // Text shifts to padding (24) + avatarSize (56) + gap (8) = 88.
    expect(svg).toMatch(/<text x="88"[^>]*>Sparky</);
  });

  it('omits <image> and keeps text at the default left margin when the fetcher returns null', async () => {
    const svg = await renderSignSvg({
      roomName: 'R',
      roommates: [
        {
          id: 'r1',
          role: 'admin',
          fursonaName: 'Sparky',
          avatarUrl: 'https://cdn.bsky.app/img/missing.jpg',
        },
      ],
      width: 800,
      height: 480,
      fetchAvatar: async () => null,
    });
    expect(svg).not.toContain('<image');
    expect(svg).toMatch(/<text x="24"[^>]*>Sparky</);
  });

  it('does not invoke the fetcher when the roommate has no avatarUrl', async () => {
    let calls = 0;
    const svg = await renderSignSvg({
      roomName: 'R',
      roommates: [{ id: 'r1', role: 'admin', fursonaName: 'Sparky' }],
      width: 800,
      height: 480,
      fetchAvatar: async () => {
        calls++;
        return null;
      },
    });
    expect(calls).toBe(0);
    expect(svg).not.toContain('<image');
  });
});
