/**
 * `/api/rooms/:id/notifications/*` — Admin Notifications surface.
 *
 * Per-room settings for the four critical alert kinds, the room-wide
 * quiet-hours window, and a read of the recent-alerts log. All routes
 * require the caller to be an admin of the room.
 *
 * Cron + Telegram DM delivery land in a follow-up PR. This PR ships:
 *   - Storage (migration 0011 extended notification_pref with
 *     threshold_json, added quiet-hours columns to `room`, created
 *     `notification_log`).
 *   - The settings surface the dashboard reads/writes.
 *   - Empty Recent-Alerts reads so the dashboard renders cleanly
 *     before the cron starts writing rows.
 *
 * Default-on semantics: the four critical rule kinds are enabled by
 * default for every new room. We don't seed pref rows at room creation;
 * instead, the listing endpoint synthesizes a default `enabled: true`
 * for any kind that has no row yet. The PUT path always upserts.
 */

import { Hono, type Context } from 'hono';
import {
  DEFAULT_THRESHOLDS,
  NOTIFICATION_RULE_KINDS,
  notificationRuleKindSchema,
  quietHoursUpdateSchema,
  rulePrefUpdateSchema,
  type DeliveryChannel,
  type NotificationRuleEntry,
  type NotificationRuleKind,
  type NotificationsView,
  type QuietHours,
  type RecentAlert,
} from '@con-sign/shared';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../auth/middleware.js';
import {
  getQuietHours,
  getRoom,
  getRoommateForUser,
  getTelegramIdentityForUser,
  listNotificationRulePrefs,
  listRecentAlertsForRoom,
  setQuietHours,
  upsertRulePref,
} from '../db/queries.js';
import { recordAudit } from '../db/audit.js';

export const notificationRoutes = new Hono<Env>();

const RECENT_ALERTS_LIMIT = 10;

async function requireAdmin(
  c: Context<Env>,
  roomId: string,
): Promise<{ roommateId: string; userId: string }> {
  const userId = c.get('userId');
  if (!userId) throw new HttpError(401, 'unauthenticated');
  const me = await getRoommateForUser(c.env.DB, roomId, userId);
  if (!me) throw new HttpError(403, 'not_a_member');
  if (me.role !== 'admin') throw new HttpError(403, 'admin_only');
  return { roommateId: me.id, userId };
}

// ─── GET /api/rooms/:id/notifications ──────────────────────────────────────
// Settings page payload: rules + quiet + delivery + recent alerts in one
// shot. Defaults are synthesized so the dashboard never has to handle
// "missing pref" specially.

notificationRoutes.get('/:id/notifications', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireAdmin(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const [rulePrefs, quietRow, tgIdentity, recentLogs] = await Promise.all([
    listNotificationRulePrefs(c.env.DB, { recipientUserId: me.userId, roomId }),
    getQuietHours(c.env.DB, roomId),
    getTelegramIdentityForUser(c.env.DB, me.userId),
    listRecentAlertsForRoom(c.env.DB, roomId, RECENT_ALERTS_LIMIT),
  ]);

  const enabledByKind = new Map<string, boolean>();
  for (const p of rulePrefs) enabledByKind.set(p.kind, p.enabled === 1);

  const rules: NotificationRuleEntry[] = NOTIFICATION_RULE_KINDS.map((kind) => ({
    kind,
    // No row yet → default ON for these four critical kinds.
    enabled: enabledByKind.get(kind) ?? true,
    threshold: DEFAULT_THRESHOLDS[kind] ?? null,
  }));

  const quiet: QuietHours = {
    enabled: (quietRow?.quiet_enabled ?? 0) === 1,
    startLocal: quietRow?.quiet_start_local ?? null,
    endLocal: quietRow?.quiet_end_local ?? null,
  };

  const delivery: DeliveryChannel = {
    channel: 'telegram',
    linked: tgIdentity != null,
    handle: tgIdentity?.handle ?? null,
  };

  const recentAlerts: RecentAlert[] = recentLogs.map((r) => {
    const payload = r.payload_json
      ? (JSON.parse(r.payload_json) as { title?: string; detail?: string })
      : {};
    return {
      id: r.id,
      kind: r.kind as NotificationRuleKind,
      title: payload.title ?? r.kind,
      detail: payload.detail ?? '',
      firedAt: r.fired_at,
      deliveryStatus: r.delivery_status as RecentAlert['deliveryStatus'],
    };
  });

  const body: NotificationsView = { rules, quiet, delivery, recentAlerts };
  return c.json(body);
});

// ─── PUT /api/rooms/:id/notifications/rules/:kind ──────────────────────────
// Upsert one rule pref for the calling admin. Each admin of a room
// has their own pref rows; toggling here only affects this admin's
// DMs, not other admins'.

notificationRoutes.put('/:id/notifications/rules/:kind', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const kindParam = c.req.param('kind');
  const me = await requireAdmin(c, roomId);

  const kindParse = notificationRuleKindSchema.safeParse(kindParam);
  if (!kindParse.success) throw new HttpError(400, 'invalid_rule_kind');
  const kind = kindParse.data;

  const { enabled } = rulePrefUpdateSchema.parse(await c.req.json());
  await upsertRulePref(c.env.DB, {
    recipientUserId: me.userId,
    roomId,
    kind,
    enabled,
  });

  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.notification_pref_changed',
    metadata: { kind, enabled },
  });
  return c.json({ ok: true });
});

// ─── PUT /api/rooms/:id/notifications/quiet ────────────────────────────────
// Quiet hours are per-room (one window applies to all admins) per the
// locked design. The columns live on `room`, not `notification_pref`.

notificationRoutes.put('/:id/notifications/quiet', requireUser, async (c) => {
  const roomId = c.req.param('id');
  const me = await requireAdmin(c, roomId);
  const room = await getRoom(c.env.DB, roomId);
  if (!room) throw new HttpError(404, 'room_not_found');

  const patch = quietHoursUpdateSchema.parse(await c.req.json());
  await setQuietHours(c.env.DB, {
    roomId,
    enabled: patch.enabled,
    // When enabled=true the schema requires both times. When enabled=false
    // we preserve any times the admin had set (so the pickers don't
    // reset to empty when they toggle off briefly).
    startLocal: patch.startLocal ?? room.quiet_start_local ?? null,
    endLocal: patch.endLocal ?? room.quiet_end_local ?? null,
  });

  await recordAudit(c.env.DB, {
    actorUserId: me.userId,
    roomId,
    action: 'room.quiet_hours_changed',
    metadata: {
      enabled: patch.enabled,
      startLocal: patch.startLocal ?? null,
      endLocal: patch.endLocal ?? null,
    },
  });
  return c.json({ ok: true });
});
