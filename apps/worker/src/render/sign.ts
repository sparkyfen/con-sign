import type { ProjectedRoommate } from '@con-sign/shared';

/**
 * Compute "which day of the con is it" given the con's start date.
 *
 * - Both sides are treated as UTC YYYY-MM-DD dates. A real con spans roughly
 *   a long weekend, so timezone slop on the day boundary is fine for the
 *   "DAY 02" glance UI.
 * - Returns null if the con hasn't started yet, or if startDate is missing.
 * - Day 1 = the start date itself.
 */
export function computeConDay(startDate: string | null, now: Date = new Date()): number | null {
  if (!startDate) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today < start) return null;
  return Math.floor((today - start) / 86_400_000) + 1;
}

/**
 * Lightweight SVG renderer for the e-ink panel. High-contrast, no
 * gradients, large type — what 1-bit panels need.
 *
 * Task #16 will swap this for satori+resvg to emit a true 1-bit PNG. The
 * SVG output here is already enough for any device that can rasterize SVG
 * locally (most modern Pi-class drivers can; some ESP32 firmware can't).
 */
export function renderSignSvg(args: {
  roomName: string;
  roommates: ProjectedRoommate[];
  width: number;
  height: number;
  conDay?: number | null;
}): string {
  const { roomName, roommates, width, height, conDay } = args;
  const padding = 24;
  const headerH = 64;
  const rowH = Math.min(72, Math.floor((height - headerH - padding * 2) / Math.max(1, roommates.length)));

  const dayLabel =
    conDay != null && conDay > 0
      ? `<g transform="translate(${width - padding}, ${padding})">
          <text x="0" y="${headerH * 0.7}" text-anchor="end"
                font-size="${Math.floor(headerH * 0.45)}" font-weight="700"
                font-family="ui-sans-serif, system-ui, sans-serif" fill="black">
            DAY ${String(conDay).padStart(2, '0')}
          </text>
        </g>`
      : '';

  const rows = roommates
    .map((r, i) => {
      const y = headerH + padding + i * rowH;
      const name = r.fursonaName ?? 'Roommate';
      const status = r.status?.label ? ` · ${r.status.label}` : '';
      return `
        <g transform="translate(${padding}, ${y})">
          <text x="0" y="${rowH * 0.6}" font-size="${Math.floor(rowH * 0.5)}"
                font-family="ui-sans-serif, system-ui, sans-serif" fill="black">
            ${escape(name)}${escape(status)}
          </text>
        </g>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <g transform="translate(${padding}, ${padding})">
    <text x="0" y="${headerH * 0.7}" font-size="${Math.floor(headerH * 0.6)}"
          font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" fill="black">
      ${escape(roomName)}
    </text>
  </g>
  ${dayLabel}
  <line x1="${padding}" y1="${headerH + padding / 2}" x2="${width - padding}" y2="${headerH + padding / 2}"
        stroke="black" stroke-width="2"/>
  ${rows}
</svg>`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
