import type { ProjectedRoommate } from '@con-sign/shared';

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
}): string {
  const { roomName, roommates, width, height } = args;
  const padding = 24;
  const headerH = 64;
  const rowH = Math.min(72, Math.floor((height - headerH - padding * 2) / Math.max(1, roommates.length)));

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
