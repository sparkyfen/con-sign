import { describe, expect, it } from 'vitest';
import { projectRoommate } from './privacy.js';
import type { Roommate } from './schemas/roommate.js';
import type { FieldVisibility, VisibleFieldName } from './schemas/visibility.js';

const ROOMMATE_A_ID = '00000000-0000-0000-0000-000000000001';
const ROOMMATE_B_ID = '00000000-0000-0000-0000-000000000002';

const fullRoommate = (id: string): Roommate => ({
  id,
  roomId: '00000000-0000-0000-0000-0000000000aa',
  userId: '00000000-0000-0000-0000-0000000000bb',
  role: 'member',
  fursonaName: 'Fenrir',
  fursonaSpecies: 'wolf',
  pronouns: 'he/him',
  bskyHandle: 'fenrir.bsky.social',
  telegramHandle: 'fenrir',
  avatarUrl: 'https://example.com/a.png',
  status: { kind: 'preset', preset: 'lobby' },
  statusUpdatedAt: '2026-04-28T10:00:00Z',
  createdAt: '2026-04-01T00:00:00Z',
});

const ALL_FIELDS: VisibleFieldName[] = [
  'fursona_name',
  'fursona_species',
  'pronouns',
  'bsky_handle',
  'telegram_handle',
  'avatar_url',
  'status',
];

const allAtTier = (tier: 'guest' | 'personal' | 'private'): FieldVisibility =>
  Object.fromEntries(ALL_FIELDS.map((f) => [f, tier])) as FieldVisibility;

describe('projectRoommate', () => {
  it('strips everything when no fields are configured (default = private)', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const projected = projectRoommate(r, {}, []);
    expect(projected).toEqual({ id: ROOMMATE_A_ID, role: 'member' });
  });

  it('shows guest fields to a guest viewer', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const v: FieldVisibility = { fursona_name: 'guest', pronouns: 'guest' };
    const projected = projectRoommate(r, v, []);
    expect(projected.fursonaName).toBe('Fenrir');
    expect(projected.pronouns).toBe('he/him');
    expect(projected.fursonaSpecies).toBeUndefined();
    expect(projected.bskyHandle).toBeUndefined();
  });

  it('hides personal fields from a guest viewer', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const v: FieldVisibility = { fursona_name: 'guest', bsky_handle: 'personal' };
    const projected = projectRoommate(r, v, []);
    expect(projected.fursonaName).toBe('Fenrir');
    expect(projected.bskyHandle).toBeUndefined();
  });

  it('reveals personal fields once the viewer has unlocked this roommate', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const v: FieldVisibility = {
      fursona_name: 'guest',
      bsky_handle: 'personal',
      pronouns: 'personal',
    };
    const projected = projectRoommate(r, v, [ROOMMATE_A_ID]);
    expect(projected.fursonaName).toBe('Fenrir');
    expect(projected.bskyHandle).toBe('fenrir.bsky.social');
    expect(projected.pronouns).toBe('he/him');
  });

  it('does NOT reveal personal fields when only a DIFFERENT roommate is unlocked', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const v: FieldVisibility = { bsky_handle: 'personal' };
    const projected = projectRoommate(r, v, [ROOMMATE_B_ID]);
    expect(projected.bskyHandle).toBeUndefined();
  });

  it('NEVER reveals private fields, even when the viewer has unlocked this roommate', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const v: FieldVisibility = allAtTier('private');
    const projected = projectRoommate(r, v, [ROOMMATE_A_ID]);
    expect(projected).toEqual({ id: ROOMMATE_A_ID, role: 'member' });
  });

  it('omits null/missing source fields entirely', () => {
    const r: Roommate = {
      ...fullRoommate(ROOMMATE_A_ID),
      bskyHandle: null,
      telegramHandle: null,
      status: null,
      statusUpdatedAt: null,
    };
    const v = allAtTier('guest');
    const projected = projectRoommate(r, v, []);
    expect(projected.bskyHandle).toBeUndefined();
    expect(projected.telegramHandle).toBeUndefined();
    expect(projected.status).toBeUndefined();
  });

  it('formats preset status to the preset label', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const projected = projectRoommate(r, { status: 'guest' }, []);
    expect(projected.status).toEqual({ label: 'lobby', updatedAt: '2026-04-28T10:00:00Z' });
  });

  it('formats custom status to the custom text', () => {
    const r: Roommate = {
      ...fullRoommate(ROOMMATE_A_ID),
      status: { kind: 'custom', text: 'getting boba' },
    };
    const projected = projectRoommate(r, { status: 'guest' }, []);
    expect(projected.status?.label).toBe('getting boba');
  });

  it('matrix: every (viewerTier, fieldMinTier) cell behaves as documented', () => {
    const cases: Array<{
      label: string;
      unlocked: string[];
      tier: 'guest' | 'personal' | 'private';
      expectVisible: boolean;
    }> = [
      { label: 'guest viewer + guest field',     unlocked: [],               tier: 'guest',    expectVisible: true },
      { label: 'guest viewer + personal field',  unlocked: [],               tier: 'personal', expectVisible: false },
      { label: 'guest viewer + private field',   unlocked: [],               tier: 'private',  expectVisible: false },
      { label: 'personal viewer + guest field',  unlocked: [ROOMMATE_A_ID], tier: 'guest',    expectVisible: true },
      { label: 'personal viewer + personal field', unlocked: [ROOMMATE_A_ID], tier: 'personal', expectVisible: true },
      { label: 'personal viewer + private field', unlocked: [ROOMMATE_A_ID], tier: 'private',  expectVisible: false },
    ];
    for (const c of cases) {
      const r = fullRoommate(ROOMMATE_A_ID);
      const projected = projectRoommate(r, { fursona_name: c.tier }, c.unlocked);
      const actuallyVisible = projected.fursonaName !== undefined;
      expect(actuallyVisible, c.label).toBe(c.expectVisible);
    }
  });

  it('accepts a Set as unlockedRoommateIds', () => {
    const r = fullRoommate(ROOMMATE_A_ID);
    const projected = projectRoommate(r, { fursona_name: 'personal' }, new Set([ROOMMATE_A_ID]));
    expect(projected.fursonaName).toBe('Fenrir');
  });
});
