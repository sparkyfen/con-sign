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
  'device.claim',
  'device.revoke',
  'roommate.passcode_rotated',
  'roommate.visibility_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditWrite {
  actorUserId: string;
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

export async function listAuditForRoom(
  db: D1Database,
  roomId: string,
  limit = 100,
): Promise<AuditRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM audit_log
        WHERE room_id = ?
        ORDER BY at DESC LIMIT ?`,
    )
    .bind(roomId, limit)
    .all<AuditRow>();
  return result.results ?? [];
}

export async function listAuditForUser(
  db: D1Database,
  userId: string,
  limit = 100,
): Promise<AuditRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM audit_log
        WHERE actor_user_id = ?
        ORDER BY at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<AuditRow>();
  return result.results ?? [];
}
