import type { ProjectedRoommate } from '@con-sign/shared';
import QRCode from 'qrcode';
import { fetchAvatarDataUri } from './avatars.js';

/**
 * Compute "which day of the con is it" given the con's start date.
 *
 * - `startDate` is treated as a YYYY-MM-DD calendar date in the con's
 *   local timezone (`tz`). When `tz` is null/undefined we fall back to
 *   UTC, which matches the previous behavior.
 * - Returns null if the con hasn't started yet, or if startDate is missing.
 * - Day 1 = the start date itself.
 */
export function computeConDay(
  startDate: string | null,
  now: Date = new Date(),
  tz?: string | null,
): number | null {
  if (!startDate) return null;
  const startParts = startDate.split('-').map(Number);
  if (startParts.length !== 3 || startParts.some((n) => !Number.isFinite(n))) return null;
  const start = Date.UTC(startParts[0]!, startParts[1]! - 1, startParts[2]!);
  const todayYmd = tz ? ymdInTz(now, tz) : ymdInTz(now, 'UTC');
  const [ty, tm, td] = todayYmd.split('-').map(Number) as [number, number, number];
  const today = Date.UTC(ty, tm - 1, td);
  if (today < start) return null;
  return Math.floor((today - start) / 86_400_000) + 1;
}

/**
 * `YYYY-MM-DD` for `now` in the given IANA timezone. Workers ship full
 * ICU so any valid IANA name works; invalid names throw at construction
 * time — callers pass validated values.
 */
function ymdInTz(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/**
 * Format the wall clock as 24-hour HH:MM in the given IANA timezone.
 * Returns null if `tz` is null/empty — the renderer omits the clock in
 * that case rather than guessing a default.
 */
export function formatConClock(now: Date, tz: string | null | undefined): string | null {
  if (!tz) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/**
 * Lightweight SVG renderer for the e-ink panel. High-contrast, no
 * gradients, large type — what 1-bit panels need.
 *
 * Task #16 will swap this for satori+resvg to emit a true 1-bit PNG. The
 * SVG output here is already enough for any device that can rasterize SVG
 * locally (most modern Pi-class drivers can; some ESP32 firmware can't).
 */
export async function renderSignSvg(args: {
  roomName: string;
  conName?: string | null;
  roommates: ProjectedRoommate[];
  width: number;
  height: number;
  conDay?: number | null;
  /**
   * Absolute URL the right-sidebar QR encodes. When present we reserve
   * a 200-px sidebar on the right of the layout; when absent the panel
   * uses the full width for roommates (legacy / test-only path).
   */
  visitorUrl?: string | null;
  /**
   * IANA timezone for the con. When set, the header shows a wall clock
   * in this zone; when null/undefined the clock is omitted entirely.
   */
  conTimezone?: string | null;
  /**
   * Injection point for tests. Production passes the real fetcher; the
   * test suite stubs this to avoid hitting the network.
   */
  fetchAvatar?: (url: string) => Promise<string | null>;
}): Promise<string> {
  const { roomName, conName, roommates, width, height, conDay, visitorUrl, conTimezone } = args;
  const fetchAvatar = args.fetchAvatar ?? fetchAvatarDataUri;
  const clock = formatConClock(new Date(), conTimezone ?? null);

  const padding = 24;
  const sidebarW = visitorUrl ? 200 : 0;
  // Where the roommate content ends on the right. Header DAY counter
  // also right-aligns to this so it doesn't cross into the QR area.
  const contentRight = width - sidebarW;

  // Header: room name + con line (if any) + DAY counter (if any).
  const roomNameFontSize = 36;
  const roomNameBaselineY = padding + roomNameFontSize; // ~60
  const conLineFontSize = 18;
  const conLineGap = 6;
  const conLineBaselineY = roomNameBaselineY + conLineGap + conLineFontSize; // ~84
  const headerH = conName ? conLineBaselineY + 10 : roomNameBaselineY + 10;

  // Each row gets its own height; cap at 80 so 1-2 roommates don't
  // stretch into the empty space below.
  const rowH = Math.min(
    80,
    Math.max(60, Math.floor((height - headerH - padding) / Math.max(1, roommates.length))),
  );

  // Header right column: DAY 0N on top, big wall clock below. Both
  // right-align to contentRight so the QR sidebar (when present) frames
  // them. Mockup uses serif for the clock; we ship sans for now and
  // can swap once Plex Serif is bundled.
  const dayText =
    conDay != null && conDay > 0
      ? `<text x="${contentRight - padding}" y="${roomNameBaselineY - 28}" text-anchor="end"
              font-size="18" font-weight="700" letter-spacing="2"
              font-family="ui-monospace, monospace" fill="black">DAY ${String(conDay).padStart(2, '0')}</text>`
      : '';
  const clockText = clock
    ? `<text x="${contentRight - padding}" y="${roomNameBaselineY}" text-anchor="end"
            font-size="36" font-weight="700"
            font-family="ui-sans-serif, system-ui, sans-serif" fill="black">${escape(clock)}</text>`
    : '';
  const dayLabel = `${dayText}${clockText}`;

  const conLine = conName
    ? `<text x="${padding}" y="${conLineBaselineY}" font-size="${conLineFontSize}"
            font-family="ui-sans-serif, system-ui, sans-serif" font-weight="400" fill="black">${escape(conName)}</text>`
    : '';

  // Per-roommate rendering — the "more than just a name" payload:
  //   line 1: fursona name (or 'Roommate' fallback) — large serif weight.
  //   line 2: caption "@handle · species · pronouns" (privacy-projected
  //           fields only; omit the whole line if none present).
  //   right edge: status pill (rounded rect + dot + label), absent when
  //           no status set or status is hidden.
  // Resolve avatars in parallel up front. Each entry is the inline data:
  // URI (success) or null (no URL, fetch failure, non-image content-type).
  const avatarDataUris = await Promise.all(
    roommates.map((r) => (r.avatarUrl ? fetchAvatar(r.avatarUrl) : Promise.resolve(null))),
  );

  const avatarSize = 72;
  const avatarGap = 8;

  const rows = roommates
    .map((r, i) => {
      const top = headerH + i * rowH;
      const nameY = top + 28;
      const captionY = top + 50;
      const nameSize = 22;
      const captionSize = 12;

      // Per-row left edge: bumped right when an avatar resolved, so
      // text-only rows don't sit in a phantom indent.
      const avatarUri = avatarDataUris[i];
      const textX = avatarUri ? padding + avatarSize + avatarGap : padding;
      const avatarTop = top + (rowH - avatarSize) / 2;
      const avatarTag = avatarUri
        ? `<image x="${padding}" y="${avatarTop}"
                  width="${avatarSize}" height="${avatarSize}"
                  preserveAspectRatio="xMidYMid slice" href="${avatarUri}"/>
          <rect x="${padding}" y="${avatarTop}" width="${avatarSize}" height="${avatarSize}"
                fill="none" stroke="black" stroke-width="2"/>`
        : '';

      const name = r.fursonaName ?? 'Roommate';
      const handle = r.bskyHandle
        ? `@${r.bskyHandle}`
        : r.telegramHandle
          ? `@${r.telegramHandle}`
          : null;
      const captionParts = [handle, r.fursonaSpecies, r.pronouns].filter(
        (s): s is string => !!s && s.length > 0,
      );
      const caption =
        captionParts.length > 0
          ? `<text x="${textX}" y="${captionY}" font-size="${captionSize}"
                  font-family="ui-monospace, monospace" fill="black">${escape(captionParts.join('  ·  '))}</text>`
          : '';

      const pill = r.status?.label
        ? renderStatusPill(r.status.label, r.status.updatedAt ?? null, contentRight - padding, top + 32)
        : '';

      const divider =
        i < roommates.length - 1
          ? `<line x1="${padding}" y1="${top + rowH}" x2="${contentRight - padding}" y2="${top + rowH}" stroke="black" stroke-width="1"/>`
          : '';

      return `
        ${avatarTag}
        <text x="${textX}" y="${nameY}" font-size="${nameSize}" font-weight="700"
              font-family="ui-sans-serif, system-ui, sans-serif" fill="black">${escape(name)}</text>
        ${caption}
        ${pill}
        ${divider}`;
    })
    .join('');

  const sidebar = visitorUrl
    ? renderQrSidebar(visitorUrl, contentRight, width, height)
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="${padding}" y="${roomNameBaselineY}" font-size="${roomNameFontSize}"
        font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700" fill="black">${escape(roomName)}</text>
  ${conLine}
  ${dayLabel}
  <line x1="${padding}" y1="${headerH - 4}" x2="${contentRight - padding}" y2="${headerH - 4}"
        stroke="black" stroke-width="2"/>
  ${rows}
  ${sidebar}
</svg>`;
}

/**
 * Stale-clear cutoff. Statuses older than this just disappear from the
 * panel — the assumption is "if they didn't update in a day, the status
 * isn't telling you anything useful anymore". Render-side only; we leave
 * the row in the DB so the dashboard, audit log, and /me view still
 * reflect what the user actually set.
 */
const STATUS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const PRESET_VARIANTS: Record<string, 'filled' | 'outlined' | 'away'> = {
  room: 'filled',
  lobby: 'outlined',
  dealers: 'outlined',
  panels: 'outlined',
  out: 'away',
  asleep: 'away',
};

/**
 * Pill variants (all 1-bit friendly):
 *   - filled   → solid black fill, white text  ("ROOM": come on in)
 *   - outlined → white fill, solid border      (active elsewhere)
 *   - away     → white fill, dashed border     (out / asleep — diminished)
 *
 * No grays. The "away" variant uses a dashed stroke instead of a lighter
 * fill, since true gray binarizes to noise on the panel.
 *
 * Custom statuses (anything not in PRESET_VARIANTS) default to outlined.
 * Label is uppercased and, if updatedAt is recent enough, suffixed with
 * an elapsed-time duration (e.g. "ASLEEP · 2h"). Returns '' if the
 * status went stale past STATUS_STALE_AFTER_MS.
 */
function renderStatusPill(
  label: string,
  updatedAt: string | null,
  rightEdgeX: number,
  centerY: number,
  now: Date = new Date(),
): string {
  const ageMs = updatedAt ? now.getTime() - Date.parse(updatedAt) : null;
  if (ageMs !== null && Number.isFinite(ageMs) && ageMs > STATUS_STALE_AFTER_MS) {
    return '';
  }

  const variant = PRESET_VARIANTS[label.toLowerCase()] ?? 'outlined';
  const duration = ageMs != null && Number.isFinite(ageMs) ? formatDuration(ageMs) : null;
  const display = duration ? `${label.toUpperCase()} · ${duration}` : label.toUpperCase();

  const charPx = 7.2;
  const padX = 12;
  const dotSize = 4;
  const labelPx = display.length * charPx;
  const pillW = padX + dotSize * 2 + 6 + labelPx + padX;
  const pillH = 26;
  const x = rightEdgeX - pillW;
  const y = centerY - pillH / 2;

  const isFilled = variant === 'filled';
  const fill = isFilled ? 'black' : 'white';
  const textColor = isFilled ? 'white' : 'black';
  const dotColor = isFilled ? 'white' : 'black';
  const strokeAttrs =
    variant === 'away'
      ? 'stroke="black" stroke-width="1.5" stroke-dasharray="3 2"'
      : isFilled
        ? 'stroke="black" stroke-width="1.5"'
        : 'stroke="black" stroke-width="1.5"';

  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${pillH / 2}" ry="${pillH / 2}"
            fill="${fill}" ${strokeAttrs}/>
      <circle cx="${padX + dotSize}" cy="${pillH / 2}" r="${dotSize}" fill="${dotColor}"/>
      <text x="${padX + dotSize * 2 + 6}" y="${pillH / 2 + 4}" font-size="11" font-weight="700" letter-spacing="1"
            font-family="ui-monospace, monospace" fill="${textColor}">${escape(display)}</text>
    </g>`;
}

/**
 * Compact human duration for the pill. We never show seconds (the panel
 * polls at 5 min minimum) and we never show >=24h (the stale-clear
 * guard above strips the pill entirely before we get here).
 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h${remMin}m`;
}

/**
 * Right-edge sidebar: "SCAN TO SEE / More / [QR] / cons.social/r/SLUG".
 * Reserves 200 px and draws a left-edge ink rule so the boundary
 * reads as a real panel section at hotel-room distance.
 *
 * QR is rendered as a tight grid of <rect> elements rather than an
 * inline <image> so the 1-bit raster pipeline doesn't have to fetch
 * or composite anything — resvg gets pure vector input.
 */
function renderQrSidebar(visitorUrl: string, leftEdgeX: number, panelW: number, panelH: number): string {
  const sidebarW = panelW - leftEdgeX;
  const cx = leftEdgeX + sidebarW / 2;

  // Hostname/path slice for the label under the QR. Strip scheme so the
  // short cons.social/r/SLUG fits without truncation.
  const shortUrl = visitorUrl.replace(/^https?:\/\//, '');

  const qrPx = 140;
  const qrTopY = 130;
  const qrLeftX = cx - qrPx / 2;

  const qr = QRCode.create(visitorUrl, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const moduleCount = modules.size;
  const cell = qrPx / moduleCount;

  let cells = '';
  for (let y = 0; y < moduleCount; y++) {
    for (let x = 0; x < moduleCount; x++) {
      if (modules.get(x, y)) {
        cells += `<rect x="${qrLeftX + x * cell}" y="${qrTopY + y * cell}" width="${cell + 0.5}" height="${cell + 0.5}" fill="black"/>`;
      }
    }
  }

  return `
    <line x1="${leftEdgeX}" y1="0" x2="${leftEdgeX}" y2="${panelH}" stroke="black" stroke-width="3"/>
    <text x="${cx}" y="60" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="2"
          font-family="ui-monospace, monospace" fill="black">SCAN TO SEE</text>
    <text x="${cx}" y="100" text-anchor="middle" font-size="26" font-weight="700"
          font-family="ui-sans-serif, system-ui, sans-serif" fill="black">More</text>
    <rect x="${qrLeftX - 6}" y="${qrTopY - 6}" width="${qrPx + 12}" height="${qrPx + 12}" fill="white" stroke="black" stroke-width="2"/>
    ${cells}
    <text x="${cx}" y="${qrTopY + qrPx + 30}" text-anchor="middle" font-size="11"
          font-family="ui-monospace, monospace" fill="black">${escape(shortUrl)}</text>
  `;
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
  <!--
    Footer was previously italic gray (#666, 14pt); both choices look
    fine in a browser but binarize badly on a 1-bit e-ink panel — italic
    falls back to upright glyphs (we don't bundle the italic TTF) and
    #666 thresholds to all-black-or-all-white depending on anti-alias
    coverage, making the line look noisy. Upright black at 16pt is what
    actually reads at hotel-room distance.
  -->
  <text x="${cx}" y="${cy + 188}" font-size="16" font-family="ui-monospace, monospace"
        fill="black" text-anchor="middle">Code refreshes every 5 minutes.</text>
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
    <!-- See unpaired footer comment: drop italic + gray for 1-bit legibility. -->
    <text x="${cx}" y="${cy + 96}" font-size="16" fill="black">
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
