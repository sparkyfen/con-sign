import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon, type Ctx } from '../helpers.js';
import type { NotificationsView } from '@con-sign/shared';

const ADMIN = '00000000-0000-0000-0000-000000000ad1';
const FRIEND = '00000000-0000-0000-0000-000000000fr1';
const STRANGER = '00000000-0000-0000-0000-000000000st1';

interface RoomCreated {
  room: { id: string };
  me: { roommateId: string };
}

async function setupRoomWithPair(): Promise<{
  ctx: Ctx;
  friendCtx: Ctx;
  strangerCtx: Ctx;
  roomId: string;
}> {
  const ctx = newCtx();
  const conId = await seedCon(ctx);
  await loginAs(ctx, ADMIN);
  const room = (
    await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'Room' } })
  ).body as RoomCreated;

  const inv = (await call(ctx, 'POST', `/api/rooms/${room.room.id}/invite`)).body as {
    inviteUrl: string;
  };
  const token = inv.inviteUrl.split('/invite/')[1]!;

  const friendCtx = newCtx();
  Object.assign(friendCtx.env, ctx.env);
  await loginAs(friendCtx, FRIEND);
  await call(friendCtx, 'POST', '/api/rooms/join', { body: { token } });

  const strangerCtx = newCtx();
  Object.assign(strangerCtx.env, ctx.env);
  await loginAs(strangerCtx, STRANGER);

  return { ctx, friendCtx, strangerCtx, roomId: room.room.id };
}

describe('integration: admin notifications settings', () => {
  it('GET defaults: four rules all ON, quiet hours OFF, delivery not linked, no alerts', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const r = await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`);
    expect(r.status).toBe(200);
    const body = r.body as NotificationsView;

    // Four critical rule kinds, all default-on.
    expect(body.rules).toHaveLength(4);
    const byKind = Object.fromEntries(body.rules.map((r) => [r.kind, r]));
    expect(byKind.panel_offline?.enabled).toBe(true);
    expect(byKind.panel_battery_low?.enabled).toBe(true);
    expect(byKind.roommate_status_stale?.enabled).toBe(true);
    expect(byKind.claim_attempts_high?.enabled).toBe(true);

    // Thresholds surfaced from DEFAULT_THRESHOLDS.
    expect(byKind.panel_offline?.threshold).toEqual({ hours: 2 });
    expect(byKind.panel_battery_low?.threshold).toEqual({ percent: 15 });

    expect(body.quiet.enabled).toBe(false);
    expect(body.quiet.startLocal).toBeNull();
    expect(body.quiet.endLocal).toBeNull();

    expect(body.delivery.channel).toBe('telegram');
    expect(body.delivery.linked).toBe(false);
    expect(body.delivery.handle).toBeNull();

    expect(body.recentAlerts).toEqual([]);
  });

  it('GET reflects a linked Telegram identity', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    // Manufacture a telegram identity for the admin (the auth flow
    // would normally do this via /api/auth/telegram/callback).
    await ctx.env.DB.prepare(
      `INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url)
       VALUES (?, ?, 'telegram', '12345', 'tasselfox_tg', NULL)`,
    )
      .bind(crypto.randomUUID(), ADMIN)
      .run();

    const body = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    expect(body.delivery.linked).toBe(true);
    expect(body.delivery.handle).toBe('tasselfox_tg');
  });

  it('PUT rule pref persists; subsequent GET reflects it', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const put = await call(
      ctx,
      'PUT',
      `/api/rooms/${roomId}/notifications/rules/panel_battery_low`,
      { body: { enabled: false } },
    );
    expect(put.status).toBe(200);
    const view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    const byKind = Object.fromEntries(view.rules.map((r) => [r.kind, r]));
    expect(byKind.panel_battery_low?.enabled).toBe(false);
    // Other kinds still default-on.
    expect(byKind.panel_offline?.enabled).toBe(true);
  });

  it('PUT rule pref upsert: toggling the same kind off then on rewrites the row', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/rules/panel_offline`, {
      body: { enabled: false },
    });
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/rules/panel_offline`, {
      body: { enabled: true },
    });
    const view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    const offline = view.rules.find((r) => r.kind === 'panel_offline');
    expect(offline?.enabled).toBe(true);
    // Only one row, not two.
    const count = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notification_pref WHERE kind = 'panel_offline' AND room_id = ?`,
    )
      .bind(roomId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('PUT rule rejects unknown rule kinds', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const r = await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/rules/bogus_kind`, {
      body: { enabled: true },
    });
    expect(r.status).toBe(400);
  });

  it('PUT quiet hours requires both times when enabled=true', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const r = await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true },
    });
    expect(r.status).toBe(400);
  });

  it('PUT quiet hours stores times in HH:MM; GET reflects them', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const put = await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true, startLocal: '23:00', endLocal: '07:00' },
    });
    expect(put.status).toBe(200);
    const view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    expect(view.quiet.enabled).toBe(true);
    expect(view.quiet.startLocal).toBe('23:00');
    expect(view.quiet.endLocal).toBe('07:00');
  });

  it('PUT quiet hours with enabled=false preserves previously-set times', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true, startLocal: '23:00', endLocal: '07:00' },
    });
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: false },
    });
    const view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    expect(view.quiet.enabled).toBe(false);
    // Pickers don't get cleared just because the toggle went off.
    expect(view.quiet.startLocal).toBe('23:00');
    expect(view.quiet.endLocal).toBe('07:00');
  });

  it('PUT quiet hours rejects invalid HH:MM strings', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    const r = await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true, startLocal: '11:00 PM', endLocal: '07:00 AM' },
    });
    expect(r.status).toBe(400);
  });

  it('member (non-admin) gets 403 on every notifications route', async () => {
    const { friendCtx, roomId } = await setupRoomWithPair();
    const r1 = await call(friendCtx, 'GET', `/api/rooms/${roomId}/notifications`);
    expect(r1.status).toBe(403);
    const r2 = await call(
      friendCtx,
      'PUT',
      `/api/rooms/${roomId}/notifications/rules/panel_offline`,
      { body: { enabled: false } },
    );
    expect(r2.status).toBe(403);
    const r3 = await call(friendCtx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true, startLocal: '23:00', endLocal: '07:00' },
    });
    expect(r3.status).toBe(403);
  });

  it('stranger (non-member) gets 403, same shape as member', async () => {
    const { strangerCtx, roomId } = await setupRoomWithPair();
    const r = await call(strangerCtx, 'GET', `/api/rooms/${roomId}/notifications`);
    expect(r.status).toBe(403);
  });

  it('recent alerts reads from notification_log; pre-seeded rows appear newest-first', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    // Manufacture two log rows the cron would normally write.
    await ctx.env.DB.prepare(
      `INSERT INTO notification_log
         (id, room_id, recipient_user_id, kind, fired_at, payload_json, delivery_status)
       VALUES
         (?, ?, ?, 'panel_offline', '2026-05-15T10:00:00Z',
          '{"title":"Panel offline","detail":"2h 14m gap detected"}', 'sent'),
         (?, ?, ?, 'panel_battery_low', '2026-05-16T21:41:00Z',
          '{"title":"Battery low","detail":"12% remaining"}', 'sent')`,
    )
      .bind(
        crypto.randomUUID(),
        roomId,
        ADMIN,
        crypto.randomUUID(),
        roomId,
        ADMIN,
      )
      .run();

    const view = (await call(ctx, 'GET', `/api/rooms/${roomId}/notifications`))
      .body as NotificationsView;
    expect(view.recentAlerts).toHaveLength(2);
    // Newest first.
    expect(view.recentAlerts[0]?.kind).toBe('panel_battery_low');
    expect(view.recentAlerts[0]?.title).toBe('Battery low');
    expect(view.recentAlerts[0]?.detail).toBe('12% remaining');
    expect(view.recentAlerts[1]?.kind).toBe('panel_offline');
  });

  it('audit: rule change writes room.notification_pref_changed; quiet change writes room.quiet_hours_changed', async () => {
    const { ctx, roomId } = await setupRoomWithPair();
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/rules/panel_offline`, {
      body: { enabled: false },
    });
    await call(ctx, 'PUT', `/api/rooms/${roomId}/notifications/quiet`, {
      body: { enabled: true, startLocal: '23:00', endLocal: '07:00' },
    });
    const rows = await ctx.env.DB.prepare(
      `SELECT action, metadata_json FROM audit_log WHERE room_id = ?
       ORDER BY at ASC, id ASC`,
    )
      .bind(roomId)
      .all<{ action: string; metadata_json: string }>();
    const actions = (rows.results ?? []).map((r) => r.action);
    expect(actions).toContain('room.notification_pref_changed');
    expect(actions).toContain('room.quiet_hours_changed');
    const prefRow = rows.results!.find((r) => r.action === 'room.notification_pref_changed');
    expect(prefRow?.metadata_json).toContain('"kind":"panel_offline"');
    expect(prefRow?.metadata_json).toContain('"enabled":false');
  });
});
