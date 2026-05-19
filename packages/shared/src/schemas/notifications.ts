import { z } from 'zod';

/**
 * Schemas for the per-room Admin Notifications surface. See
 * PLAN.md "Admin notifications" for the locked design.
 *
 * Four rule kinds in v1:
 *   - panel_offline
 *   - panel_battery_low
 *   - roommate_status_stale
 *   - claim_attempts_high
 *
 * Each is on-by-default for new rooms; the listing endpoint synthesizes
 * a default row when none exists yet, so the dashboard never has to
 * special-case "missing pref means enabled."
 */

export const NOTIFICATION_RULE_KINDS = [
  'panel_offline',
  'panel_battery_low',
  'roommate_status_stale',
  'claim_attempts_high',
] as const;
export const notificationRuleKindSchema = z.enum(NOTIFICATION_RULE_KINDS);
export type NotificationRuleKind = z.infer<typeof notificationRuleKindSchema>;

export const notificationRuleEntrySchema = z.object({
  kind: notificationRuleKindSchema,
  enabled: z.boolean(),
  /** Opaque key/value bag of threshold defaults; non-adjustable in v1
   * (toggles only) but surfaced so the dashboard can show "2 hours"
   * etc. without hard-coding it client-side. */
  threshold: z.record(z.unknown()).nullable(),
});
export type NotificationRuleEntry = z.infer<typeof notificationRuleEntrySchema>;

export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  /** "HH:MM" 24-hour, interpreted in the room's con-local TZ. NULL
   * when the admin hasn't picked times yet (UI defaults to 23:00/07:00). */
  startLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  endLocal: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const deliveryChannelSchema = z.object({
  channel: z.literal('telegram'),
  /** True iff the caller has linked a Telegram identity to their
   * con-sign account. UI swaps the "Linked / @handle" pill for the
   * "Link Telegram account" CTA based on this. */
  linked: z.boolean(),
  handle: z.string().nullable(),
});
export type DeliveryChannel = z.infer<typeof deliveryChannelSchema>;

export const recentAlertSchema = z.object({
  id: z.string().uuid(),
  kind: notificationRuleKindSchema,
  /** Short human-readable summary the cron wrote when the alert fired,
   * e.g. "2h 14m gap detected" for panel_offline. */
  title: z.string(),
  detail: z.string(),
  firedAt: z.string(),
  deliveryStatus: z.enum(['sent', 'failed', 'suppressed_quiet', 'suppressed_off']),
});
export type RecentAlert = z.infer<typeof recentAlertSchema>;

export const notificationsViewSchema = z.object({
  rules: z.array(notificationRuleEntrySchema),
  quiet: quietHoursSchema,
  delivery: deliveryChannelSchema,
  recentAlerts: z.array(recentAlertSchema),
});
export type NotificationsView = z.infer<typeof notificationsViewSchema>;

export const rulePrefUpdateSchema = z.object({
  enabled: z.boolean(),
});
export type RulePrefUpdate = z.infer<typeof rulePrefUpdateSchema>;

export const quietHoursUpdateSchema = z
  .object({
    enabled: z.boolean(),
    startLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'must be HH:MM 24-hour')
      .nullable()
      .optional(),
    endLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'must be HH:MM 24-hour')
      .nullable()
      .optional(),
  })
  .refine(
    (v) => !v.enabled || (v.startLocal != null && v.endLocal != null),
    { message: 'startLocal and endLocal are required when enabled' },
  );
export type QuietHoursUpdate = z.infer<typeof quietHoursUpdateSchema>;

/**
 * Default thresholds. Surfaced on the listing so the dashboard renders
 * "Panel offline > 2 hours" without hard-coding the 2. v1 doesn't let
 * admins change them; v2 may.
 */
export const DEFAULT_THRESHOLDS: Record<NotificationRuleKind, Record<string, unknown>> = {
  panel_offline: { hours: 2 },
  panel_battery_low: { percent: 15 },
  roommate_status_stale: { hours: 24 },
  claim_attempts_high: { attempts: 5, withinMinutes: 10 },
};
