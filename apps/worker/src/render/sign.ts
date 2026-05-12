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
  conName?: string | null;
  roommates: ProjectedRoommate[];
  width: number;
  height: number;
  conDay?: number | null;
}): string {
  const { roomName, conName, roommates, width, height, conDay } = args;
  const padding = 24;
  // Stacked header: large room name, then a smaller con line if present.
  // Coords below assume baselines at fixed offsets so the two never overlap.
  const roomNameFontSize = 40;
  const roomNameBaselineY = padding + roomNameFontSize; // ~64
  const conLineFontSize = 22;
  const conLineGap = 8;
  const conLineBaselineY = roomNameBaselineY + conLineGap + conLineFontSize; // ~94
  const headerH = conName ? conLineBaselineY + 8 : roomNameBaselineY + 8;
  const rowH = Math.min(72, Math.floor((height - headerH - padding * 2) / Math.max(1, roommates.length)));

  // DAY counter only renders once the con has actually started. Before that
  // we'd show "DAY 0" or negative, which is more confusing than empty.
  const dayLabel =
    conDay != null && conDay > 0
      ? `<g>
          <text x="${width - padding}" y="${roomNameBaselineY}" text-anchor="end"
                font-size="28" font-weight="700"
                font-family="ui-sans-serif, system-ui, sans-serif" fill="black">
            DAY ${String(conDay).padStart(2, '0')}
          </text>
        </g>`
      : '';

  const conLine = conName
    ? `<text x="${padding}" y="${conLineBaselineY}" font-size="${conLineFontSize}"
            font-family="ui-sans-serif, system-ui, sans-serif" font-weight="400" fill="#555">
        ${escape(conName)}
      </text>`
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
  <text x="${padding}" y="${roomNameBaselineY}" font-size="${roomNameFontSize}"
        font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" fill="black">
    ${escape(roomName)}
  </text>
  ${conLine}
  ${dayLabel}
  <line x1="${padding}" y1="${headerH + padding / 2}" x2="${width - padding}" y2="${headerH + padding / 2}"
        stroke="black" stroke-width="2"/>
  ${rows}
</svg>`;
}

/**
 * Centered "this panel is waiting to be paired" SVG. Matches the Pencil
 * mockup `Screen / E-Ink — Unpaired` (frame RTuAt): CON·SIGN wordmark, an
 * 80×4 ink rule, "PAIRING CODE" eyebrow, the code itself in a 3-stroke
 * outlined box, an instruction line, and a "refreshes every 5 minutes"
 * footer.
 */
export function renderUnpairedSvg(args: {
  pairCode: string;
  width: number;
  height: number;
}): string {
  const { pairCode, width, height } = args;
  const cx = width / 2;
  const cy = height / 2;
  // Render the code with em-spaces between glyphs to match the mockup.
  const spaced = pairCode.split('').join('  ');
  const codeFontSize = 56;
  const boxPadX = 36;
  const boxPadY = 22;
  // Rough glyph-width estimate for the box stroke; doesn't need to be exact.
  const codeBoxW = spaced.length * codeFontSize * 0.55;
  const codeBoxH = codeFontSize + boxPadY * 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <g font-family="ui-monospace, 'IBM Plex Mono', monospace" fill="black" text-anchor="middle">
    <text x="${cx}" y="${cy - 150}" font-size="22" font-weight="700" letter-spacing="6">CON·SIGN</text>
    <rect x="${cx - 40}" y="${cy - 130}" width="80" height="4" fill="black"/>
    <text x="${cx}" y="${cy - 80}" font-size="18" font-weight="700" letter-spacing="4">PAIRING CODE</text>
    <rect x="${cx - codeBoxW / 2}" y="${cy - codeBoxH / 2 + 10}" width="${codeBoxW}" height="${codeBoxH}"
          fill="white" stroke="black" stroke-width="3"/>
    <text x="${cx}" y="${cy + 30}" font-size="${codeFontSize}" font-weight="700" letter-spacing="8">${escape(spaced)}</text>
  </g>
  <g font-family="ui-serif, 'IBM Plex Serif', serif" fill="black" text-anchor="middle">
    <text x="${cx}" y="${cy + 110}" font-size="20">Enter this code at cons.social/pair</text>
    <text x="${cx}" y="${cy + 138}" font-size="20">to link this panel to your room.</text>
  </g>
  <text x="${cx}" y="${cy + 188}" font-size="14" font-style="italic" font-family="ui-monospace, monospace"
        fill="#666" text-anchor="middle">Code refreshes every 5 minutes.</text>
</svg>`;
}

/**
 * "This panel was unpaired by a room admin" SVG. Matches the Pencil mockup
 * `Screen / E-Ink — Token Revoked` (frame bsCQx). A simple triangle stands
 * in for the lucide warning glyph; the panel doesn't have a glyph font
 * available and we want zero external assets.
 */
export function renderRevokedSvg(args: { width: number; height: number }): string {
  const { width, height } = args;
  const cx = width / 2;
  const cy = height / 2;

  // Equilateral warning triangle.
  const t = 36;
  const triangle = `M ${cx} ${cy - 70 - t} L ${cx + t} ${cy - 70 + t * 0.6} L ${cx - t} ${cy - 70 + t * 0.6} Z`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <g font-family="ui-monospace, 'IBM Plex Mono', monospace" fill="black" text-anchor="middle">
    <text x="${cx}" y="${cy - 150}" font-size="22" font-weight="700" letter-spacing="6">CON·SIGN</text>
    <rect x="${cx - 40}" y="${cy - 130}" width="80" height="4" fill="black"/>
    <path d="${triangle}" fill="none" stroke="black" stroke-width="4" stroke-linejoin="round"/>
    <text x="${cx}" y="${cy - 30}" font-size="14" font-weight="700">!</text>
    <text x="${cx}" y="${cy + 8}" font-size="26" font-weight="700" letter-spacing="4">PANEL UNPAIRED</text>
  </g>
  <g font-family="ui-serif, 'IBM Plex Serif', serif" fill="black" text-anchor="middle">
    <text x="${cx}" y="${cy + 56}" font-size="20">This panel's token has been revoked by a room admin.</text>
    <text x="${cx}" y="${cy + 96}" font-size="16" font-style="italic" fill="#666">
      To re-pair, visit cons.social/pair or contact your room admin.
    </text>
  </g>
</svg>`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
