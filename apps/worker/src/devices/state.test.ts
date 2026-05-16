import { describe, expect, it } from 'vitest';
import { classifyDeviceState, envelopeStateFromRender } from './state.js';
import type { DeviceRow } from '../db/queries.js';

function row(overrides: Partial<DeviceRow>): DeviceRow {
  return {
    id: 'd1',
    room_id: null,
    revoked_at: null,
    last_seen_at: null,
    paired_at: null,
    created_at: '2026-01-01',
    mac_address: null,
    battery_voltage: null,
    percent_charged: null,
    rssi: null,
    fw_version: null,
    model: null,
    ...overrides,
  };
}

describe('classifyDeviceState', () => {
  it('null device → unpaired (no row yet)', () => {
    expect(classifyDeviceState(null)).toBe('unpaired');
  });

  it('row with no room and no revoke → unpaired', () => {
    expect(classifyDeviceState(row({}))).toBe('unpaired');
  });

  it('row with room and no revoke → paired', () => {
    expect(classifyDeviceState(row({ room_id: 'r1' }))).toBe('paired');
  });

  it('revoke + last_seen_at NULL → revoked-notice (show once)', () => {
    expect(classifyDeviceState(row({ revoked_at: '2026-05-15T00:00:00Z' }))).toBe(
      'revoked-notice',
    );
  });

  it('revoke + last_seen_at set → self-healed (notice already shown)', () => {
    expect(
      classifyDeviceState(
        row({ revoked_at: '2026-05-15T00:00:00Z', last_seen_at: '2026-05-15T00:05:00Z' }),
      ),
    ).toBe('self-healed');
  });

  it('a revoke beats a stale room_id', () => {
    // revokeDevice clears room_id but a buggy migration might leave it
    // set alongside revoked_at; assert revoke takes precedence so the
    // panel never renders a stale paired view.
    expect(
      classifyDeviceState(row({ room_id: 'r1', revoked_at: '2026-05-15T00:00:00Z' })),
    ).toBe('revoked-notice');
  });
});

describe('envelopeStateFromRender', () => {
  it('collapses self-healed into unpaired so the cache key matches the rendered screen', () => {
    expect(envelopeStateFromRender('self-healed')).toBe('unpaired');
    expect(envelopeStateFromRender('unpaired')).toBe('unpaired');
  });

  it('passes paired and revoked-notice through (with revoked-notice → revoked)', () => {
    expect(envelopeStateFromRender('paired')).toBe('paired');
    expect(envelopeStateFromRender('revoked-notice')).toBe('revoked');
  });
});
