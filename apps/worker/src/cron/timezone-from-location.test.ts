import { describe, expect, it } from 'vitest';
import { inferTimezoneFromLocation } from './timezone-from-location.js';

describe('inferTimezoneFromLocation', () => {
  it('returns null for null / empty / whitespace', () => {
    expect(inferTimezoneFromLocation(null)).toBeNull();
    expect(inferTimezoneFromLocation('')).toBeNull();
    expect(inferTimezoneFromLocation('   ,  ,  ')).toBeNull();
  });

  it('maps US state codes via the tail', () => {
    expect(inferTimezoneFromLocation('Holiday Inn, Austin, TX')).toBe('America/Chicago');
    expect(inferTimezoneFromLocation('Marriott, Detroit, MI')).toBe('America/Detroit');
    expect(inferTimezoneFromLocation('Some Hotel, San Diego, CA')).toBe('America/Los_Angeles');
    expect(inferTimezoneFromLocation('Seaside Center, Seaside, OR')).toBe('America/Los_Angeles');
  });

  it('maps single-timezone countries case-insensitively', () => {
    expect(inferTimezoneFromLocation('Venue, City, Germany')).toBe('Europe/Berlin');
    expect(inferTimezoneFromLocation('Venue, Tokyo, Japan')).toBe('Asia/Tokyo');
    expect(inferTimezoneFromLocation('Venue, Glasgow, UK')).toBe('Europe/London');
    expect(inferTimezoneFromLocation('Hotel, Prague, Czech Republic')).toBe('Europe/Prague');
    expect(inferTimezoneFromLocation('Venue, City, czechia')).toBe('Europe/Prague');
  });

  it('uses regional disambiguation for multi-tz countries', () => {
    expect(inferTimezoneFromLocation('Novotel Melbourne Preston, Preston, Victoria, Australia')).toBe(
      'Australia/Melbourne',
    );
    expect(inferTimezoneFromLocation('Hotel, Sydney, NSW, Australia')).toBe('Australia/Sydney');
    expect(inferTimezoneFromLocation('Venue, Perth, Western Australia, Australia')).toBe(
      'Australia/Perth',
    );
    expect(inferTimezoneFromLocation('Centre, Toronto, ON, Canada')).toBe('America/Toronto');
    expect(inferTimezoneFromLocation('Hotel, Vancouver, BC, Canada')).toBe('America/Vancouver');
    expect(inferTimezoneFromLocation('Camp, Franco da Rocha, SP, Brazil')).toBe('America/Sao_Paulo');
  });

  it('falls back to the multi-tz country default when the region is unknown', () => {
    expect(inferTimezoneFromLocation('Some Venue, City, Australia')).toBe('Australia/Sydney');
    expect(inferTimezoneFromLocation('Hotel, City, Canada')).toBe('America/Toronto');
  });

  it('returns null when the tail is unrecognised', () => {
    expect(inferTimezoneFromLocation('Venue, City, Mars')).toBeNull();
    expect(inferTimezoneFromLocation('Online')).toBeNull();
    expect(inferTimezoneFromLocation('TBA')).toBeNull();
  });

  it('handles trailing/leading whitespace and empty inner tokens', () => {
    expect(inferTimezoneFromLocation('  Hotel  ,  ,  Austin , TX ')).toBe('America/Chicago');
  });
});
