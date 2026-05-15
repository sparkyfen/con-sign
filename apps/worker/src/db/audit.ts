/**
 * Audit log helpers.
 *
 * One write call per admin-action endpoint. The `action` string is part of
 * the API contract — bumping it requires updating every reader. Don't
 * recycle a value for a different meaning.
 *
 * Design decisions:
 *   - Action vocabulary lives here as a TS union (not a SQL CHECK) so
 *     adding new actions never needs a migration.
 *   - `metadata_json` is kept small and human-readable. If you find
 *     yourself stuffing more than a couple hundred bytes in here, that
 *     belongs on a real domain table, not the audit log.
 *   - `recordAudit` *swallows* failures. The operation it logs has
 *     already succeeded; failing the request because we couldn't write
 *     the audit row would be worse than the missing log entry. We
 *     console.error so the failure shows up in `wrangler tail`.
 */

export const AUDIT_ACTIONS = [
  'room.create',
  'room.rename',
  'room.invite_created',
  'room.member_joined',
  'room.member_removed',
  'device.setup',
  'device.claim',
  'device.revoke',
  'roommate.passcode_rotated',
  'roommate.visibility_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditWrite {
  /**
   * The user who performed the action, or null for system/device-initiated
   * events (e.g. `device.setup` — the device contacts us before any user
   * is involved). The `actor_user_id` column is nullable to match.
   */
  actorUserId: string | null;
  roomId: string | null;
  action: AuditAction;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  room_id: string | null;
  action: string;
  target_id: string | null;
  metadata_json: string | null;
  at: string;
}

export async function recordAudit(db: D1Database, args: AuditWrite): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log
           (id, actor_user_id, room_id, action, target_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        args.actorUserId,
        args.roomId,
        args.action,
        args.targetId ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
      )
      .run();
  } catch (err) {
    console.error('audit write failed', { action: args.action, err: String(err) });
  }
}

/**
 * Cursor for keyset pagination. Encodes the (at, id) of the last row in
 * the current page so a follow-up query can resume strictly before it.
 *
 * Wire format: base64url (RFC 4648 §5) of the JSON. base64url avoids the
 * `+`, `/`, and `=` characters from standard base64 — clients can drop
 * the cursor into a URL query string without calling encodeURIComponent,
 * and we don't lose padding to URL parsers that strip `=`.
 *
 * decodeCursor also accepts legacy standard-base64 cursors (single
 * deploy with `+`/`/`/`=`) so any in-flight client doesn't 404 the
 * moment we ship this; safe to remove once that's no longer a concern.
 */
export interface AuditCursor {
  at: string;
  id: string;
}

export function encodeCursor(c: AuditCursor): string {
  return base64urlEncode(JSON.stringify(c));
}

export function decodeCursor(s: string): AuditCursor | null {
  try {
    const v = JSON.parse(base64urlDecode(s)) as Partial<AuditCursor>;
    if (typeof v.at === 'string' && typeof v.id === 'string') return { at: v.at, id: v.id };
    return null;
  } catch {
    return null;
  }
}

function base64urlEncode(s: string): string {
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64urlDecode(s: string): string {
  // Tolerate both base64url and legacy standard base64 input.
  let normalized = s.replaceAll('-', '+').replaceAll('_', '/');
  const pad = normalized.length % 4;
  if (pad) normalized += '='.repeat(4 - pad);
  return atob(normalized);
}

export interface AuditPage {
  rows: AuditRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Paginate the audit log keyset-style. Ordering is `(at DESC, id DESC)`
 * so ties on the millisecond (D1 datetime('now') has second precision)
 * still produce a total order via `id`. The cursor encodes both columns;
 * the WHERE clause asks for strictly-older rows.
 *
 * Returns `nextCursor: null` when the page is the last one (fewer than
 * `limit` rows came back, or the next query would be empty).
 */
async function listAuditPage(
  db: D1Database,
  filterColumn: 'room_id' | 'actor_user_id',
  filterValue: string,
  limit: number,
  cursor: AuditCursor | null,
): Promise<AuditPage> {
  const lim = Math.min(MAX_LIMIT, Math.max(1, limit));
  const sql = cursor
    ? `SELECT * FROM audit_log
        WHERE ${filterColumn} = ?
          AND (at < ? OR (at = ? AND id < ?))
        ORDER BY at DESC, id DESC
        LIMIT ?`
    : `SELECT * FROM audit_log
        WHERE ${filterColumn} = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`;
  const stmt = cursor
    ? db.prepare(sql).bind(filterValue, cursor.at, cursor.at, cursor.id, lim)
    : db.prepare(sql).bind(filterValue, lim);
  const result = await stmt.all<AuditRow>();
  const rows = result.results ?? [];
  const nextCursor =
    rows.length === lim
      ? encodeCursor({ at: rows[rows.length - 1]!.at, id: rows[rows.length - 1]!.id })
      : null;
  return { rows, nextCursor };
}

export async function listAuditForRoom(
  db: D1Database,
  roomId: string,
  opts: { limit?: number | undefined; cursor?: AuditCursor | null } = {},
): Promise<AuditPage> {
  return listAuditPage(db, 'room_id', roomId, opts.limit ?? DEFAULT_LIMIT, opts.cursor ?? null);
}

export async function listAuditForUser(
  db: D1Database,
  userId: string,
  opts: { limit?: number | undefined; cursor?: AuditCursor | null } = {},
): Promise<AuditPage> {
  return listAuditPage(db, 'actor_user_id', userId, opts.limit ?? DEFAULT_LIMIT, opts.cursor ?? null);
}
