import { describe, expect, it } from 'vitest';
import { parseIcs } from './ics-parse.js';

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//furrycons.com//EN
BEGIN:VEVENT
UID:fc-2026-001
SUMMARY:Furry Convention Example
DTSTART;VALUE=DATE:20260115
DTEND;VALUE=DATE:20260118
LOCATION:Springfield Hilton\\, Hall A
URL:https://example.com/fc
END:VEVENT
BEGIN:VEVENT
UID:fc-2026-002
SUMMARY:Cancelled Con
DTSTART;VALUE=DATE:20260301
DTEND;VALUE=DATE:20260303
END:VEVENT
END:VCALENDAR`;

describe('parseIcs', () => {
  it('extracts the basic VEVENT fields', () => {
    const events = parseIcs(SAMPLE);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      uid: 'fc-2026-001',
      summary: 'Furry Convention Example',
      startDate: '2026-01-15',
      endDate: '2026-01-18',
      location: 'Springfield Hilton, Hall A',
      url: 'https://example.com/fc',
    });
  });

  it('handles missing optional fields', () => {
    const events = parseIcs(SAMPLE);
    expect(events[1]?.location).toBeNull();
    expect(events[1]?.url).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const events = parseIcs(SAMPLE.replace(/\n/g, '\r\n'));
    expect(events).toHaveLength(2);
  });

  it('unfolds continued lines', () => {
    const folded = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:x
SUMMARY:Long name that
  is folded across lines
DTSTART;VALUE=DATE:20260101
DTEND;VALUE=DATE:20260102
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(folded);
    expect(events[0]?.summary).toBe('Long name that is folded across lines');
  });

  it('handles DATE-TIME DTSTART/DTEND', () => {
    const dt = `BEGIN:VEVENT
UID:dt
SUMMARY:S
DTSTART:20260115T120000Z
DTEND:20260116T120000Z
END:VEVENT`;
    const events = parseIcs(dt);
    expect(events[0]?.startDate).toBe('2026-01-15');
  });

  it('skips events missing required fields', () => {
    const broken = `BEGIN:VEVENT
SUMMARY:no uid
DTSTART;VALUE=DATE:20260101
DTEND;VALUE=DATE:20260102
END:VEVENT`;
    expect(parseIcs(broken)).toHaveLength(0);
  });
});
