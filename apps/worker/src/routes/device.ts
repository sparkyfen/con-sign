import { Hono } from 'hono';
import { projectRoommate } from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { verifyPasscode } from '../auth/passcode.js';
import { getVisibility, listRoommatesForRoom, roommateRowToApi } from '../db/queries.js';
import { computeConDay, renderSignSvg } from '../render/sign.js';

export const deviceRoutes = new Hono<Env>();

/**
 * GET /api/device/sign.png?room=<roomId>
 *
 * Authenticated by the room's device bearer token (Authorization header).
 * Returns the room rendered at GUEST tier — devices see exactly what a
 * passer-by sees, never personal data.
 *
 * NOTE: this currently returns SVG (image/svg+xml). The PNG conversion via
 * resvg-wasm lands in task #16; SVG is what most modern e-ink driver code
 * can rasterize on-device, and it lets us ship the bearer auth + rendering
 * pipeline today.
 */
deviceRoutes.get('/sign.png', async (c) => {
  const auth = c.req.header('Authorization');
  const m = auth?.match(/^Bearer (.+)$/);
  if (!m) throw new HttpError(401, 'missing_bearer');
  const token = m[1]!;

  const roomId = c.req.query('room');
  if (!roomId) throw new HttpError(400, 'missing_room');

  const room = await c.env.DB.prepare(
    `SELECT room.id AS id, room.name AS name, room.qr_slug AS qr_slug,
            room.device_token_hash AS device_token_hash,
            con.start_date AS con_start_date
       FROM room JOIN con ON con.id = room.con_id
      WHERE room.id = ?`,
  )
    .bind(roomId)
    .first<{
      id: string;
      name: string;
      qr_slug: string;
      device_token_hash: string | null;
      con_start_date: string | null;
    }>();
  if (!room || !room.device_token_hash) throw new HttpError(404, 'room_not_found');

  if (!(await verifyPasscode(token, room.device_token_hash))) {
    throw new HttpError(401, 'bad_bearer');
  }

  const rows = await listRoommatesForRoom(c.env.DB, roomId);
  const projected = await Promise.all(
    rows.map(async ({ row, avatarUrl }) => {
      const visibility = await getVisibility(c.env.DB, row.id);
      const r = roommateRowToApi(row, avatarUrl);
      return projectRoommate(r, visibility, []);
    }),
  );

  const widthQ = c.req.query('w');
  const heightQ = c.req.query('h');
  const width = widthQ ? Math.max(100, Math.min(4096, Number(widthQ))) : 800;
  const height = heightQ ? Math.max(100, Math.min(4096, Number(heightQ))) : 480;

  const svg = renderSignSvg({
    roomName: room.name,
    roommates: projected,
    width,
    height,
    conDay: computeConDay(room.con_start_date),
  });
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
});
