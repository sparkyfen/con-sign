/**
 * Minimal ICS parser. We don't need recurrence, alarms, or any of the
 * RFC5545 complexity — furrycons.com publishes simple non-recurring VEVENTs
 * with UID/SUMMARY/DTSTART/DTEND/LOCATION/URL.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  location: string | null;
  url: string | null;
}

/**
 * Unfold ICS line continuations (RFC5545 §3.1: lines starting with a space
 * or tab are a continuation of the previous line).
 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Parse a DTSTART/DTEND value (DATE or DATE-TIME) into YYYY-MM-DD. */
function toDateOnly(value: string): string {
  // Strip params and just take the value portion.
  const v = value.includes(':') ? value.split(':').slice(1).join(':') : value;
  // VALUE=DATE: 20260115; VALUE=DATE-TIME: 20260115T100000Z
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  if (!m) throw new Error(`unparseable date: ${value}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function unescape(value: string): string {
  return value
    .replaceAll('\\n', '\n')
    .replaceAll('\\,', ',')
    .replaceAll('\\;', ';')
    .replaceAll('\\\\', '\\');
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;

  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (raw === 'END:VEVENT') {
      if (current && current.uid && current.summary && current.startDate && current.endDate) {
        events.push({
          uid: current.uid,
          summary: current.summary,
          startDate: current.startDate,
          endDate: current.endDate,
          location: current.location ?? null,
          url: current.url ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    // Property name + optional ;params, then ':' value.
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const head = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    const [name] = head.split(';');

    switch (name) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescape(value);
        break;
      case 'DTSTART':
        try {
          current.startDate = toDateOnly(raw);
        } catch {
          // skip malformed
        }
        break;
      case 'DTEND':
        try {
          current.endDate = toDateOnly(raw);
        } catch {
          // skip
        }
        break;
      case 'LOCATION':
        current.location = unescape(value) || null;
        break;
      case 'URL':
        current.url = value || null;
        break;
      default:
        break;
    }
  }
  return events;
}
