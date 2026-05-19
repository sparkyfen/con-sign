/**
 * Hand-written D1 query helpers. We intentionally don't use an ORM — the
 * surface is small, the schema is fixed, and prepared statements with
 * parameter binding are clear at the call site.
 */

import type { Roommate, Status, UpdateRoommate } from '@con-sign/shared';
import type { FieldVisibility, Tier } from '@con-sign/shared';

const newId = (): string => crypto.randomUUID();

const SLUG_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const SLUG_LEN = 10;
export const newQrSlug = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LEN));
  let out = '';
  for (let i = 0; i < SLUG_LEN; i++) out += SLUG_ALPHABET[(bytes[i] ?? 0) % SLUG_ALPHABET.length];
  return out;
};

// ─── users + identities ────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  display_name: string;
  created_at: string;
}

export interface IdentityRow {
  id: string;
  user_id: string;
  provider: 'bsky' | 'telegram';
  provider_id: string;
  handle: string | null;
  avatar_url: string | null;
}

/**
 * Thrown by upsertIdentity when `linkToUserId` is set and the requested
 * (provider, provider_id) is already attached to a *different* user.
 */
export class IdentityCollisionError extends Error {
  constructor(
    public readonly provider: 'bsky' | 'telegram',
    public readonly providerId: string,
    public readonly existingUserId: string,
    public readonly attemptedUserId: string,
  ) {
    super(`identity ${provider}:${providerId} already linked to a different user`);
  }
}

/**
 * Upsert an external identity. Behavior depends on `linkToUserId`:
 *
 *   - **`linkToUserId` undefined** (the bare login flow):
 *       - existing identity → return its existing user_id (no merge);
 *       - no existing identity → create a fresh user + identity.
 *   - **`linkToUserId` set** (user is already logged in via another
 *     provider, OAuth callback wants to attach this identity to the
 *     current session's user):
 *       - existing identity on the same user → no-op, return it;
 *       - existing identity on a *different* user → throw
 *         `IdentityCollisionError`. Caller should surface 409;
 *       - no existing identity → create a new identity row bound to
 *         the supplied user_id (no new `user` row).
 *
 * Returns the resolved user_id on success.
 */
export async function upsertIdentity(
  db: D1Database,
  args: {
    provider: 'bsky' | 'telegram';
    providerId: string;
    handle: string | null;
    avatarUrl: string | null;
    displayName: string;
    /** Active session's user_id, if the call is part of a link-account flow. */
    linkToUserId?: string | undefined;
  },
): Promise<string> {
  const existing = await db
    .prepare('SELECT user_id FROM identity WHERE provider = ? AND provider_id = ?')
    .bind(args.provider, args.providerId)
    .first<{ user_id: string }>();

  if (existing) {
    if (args.linkToUserId && existing.user_id !== args.linkToUserId) {
      throw new IdentityCollisionError(
        args.provider,
        args.providerId,
        existing.user_id,
        args.linkToUserId,
      );
    }
    await db
      .prepare(
        'UPDATE identity SET handle = ?, avatar_url = ? WHERE provider = ? AND provider_id = ?',
      )
      .bind(args.handle, args.avatarUrl, args.provider, args.providerId)
      .run();
    return existing.user_id;
  }

  // Attach to existing session user — create only the identity row.
  if (args.linkToUserId) {
    await db
      .prepare(
        'INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        newId(),
        args.linkToUserId,
        args.provider,
        args.providerId,
        args.handle,
        args.avatarUrl,
      )
      .run();
    return args.linkToUserId;
  }

  // Fresh login — create user + identity.
  const userId = newId();
  const identityId = newId();
  await db.batch([
    db.prepare('INSERT INTO user (id, display_name) VALUES (?, ?)').bind(userId, args.displayName),
    db
      .prepare(
        'INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(identityId, userId, args.provider, args.providerId, args.handle, args.avatarUrl),
  ]);
  return userId;
}

// ─── roommates ─────────────────────────────────────────────────────────────

export interface RoommateRow {
  id: string;
  room_id: string;
  user_id: string;
  role: 'admin' | 'member';
  passcode_hash: string;
  passcode_rotated_at: string;
  fursona_name: string | null;
  fursona_species: string | null;
  pronouns: string | null;
  bsky_handle: string | null;
  telegram_handle: string | null;
  status_kind: 'preset' | 'custom' | null;
  status_preset:
    | 'room'
    | 'lobby'
    | 'dealers'
    | 'panels'
    | 'out'
    | 'asleep'
    | null;
  status_custom_text: string | null;
  status_updated_at: string | null;
  created_at: string;
}

/**
 * Convert a raw RoommateRow plus an avatar (joined separately from identity)
 * into the API-shaped Roommate. The avatar isn't stored on roommate; it
 * follows whichever identity the user chose for this room (currently we use
 * the most recently updated identity).
 */
/**
 * Status is stored across three columns (`status_kind`, `status_preset`,
 * `status_custom_text`) so the DB can index/filter on the discriminator.
 * Project it back to the tagged-union shape the rest of the app sees.
 */
function statusFromColumns(row: RoommateRow): Status | null {
  if (row.status_kind === 'preset' && row.status_preset) {
    return { kind: 'preset', preset: row.status_preset };
  }
  if (row.status_kind === 'custom' && row.status_custom_text) {
    return { kind: 'custom', text: row.status_custom_text };
  }
  return null;
}

/**
 * Flatten a `Status | null` patch into the three column updates the DB
 * needs, plus the `status_updated_at` bookkeeping. A null status
 * (clearing) nulls every column including the timestamp; preset and
 * custom each set their own combination. Returned in the order
 * `updateRoommateProfile` will write them.
 */
function statusToColumns(status: Status | null): Array<[string, unknown]> {
  if (status === null) {
    return [
      ['status_kind', null],
      ['status_preset', null],
      ['status_custom_text', null],
      ['status_updated_at', null],
    ];
  }
  const now = new Date().toISOString();
  if (status.kind === 'preset') {
    return [
      ['status_kind', 'preset'],
      ['status_preset', status.preset],
      ['status_custom_text', null],
      ['status_updated_at', now],
    ];
  }
  return [
    ['status_kind', 'custom'],
    ['status_preset', null],
    ['status_custom_text', status.text],
    ['status_updated_at', now],
  ];
}

export function roommateRowToApi(row: RoommateRow, avatarUrl: string | null): Roommate {
  const status = statusFromColumns(row);

  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role,
    fursonaName: row.fursona_name,
    fursonaSpecies: row.fursona_species,
    pronouns: row.pronouns,
    bskyHandle: row.bsky_handle,
    telegramHandle: row.telegram_handle,
    avatarUrl,
    status,
    statusUpdatedAt: row.status_updated_at,
    createdAt: row.created_at,
  };
}

export async function listRoommatesForRoom(
  db: D1Database,
  roomId: string,
): Promise<{ row: RoommateRow; avatarUrl: string | null }[]> {
  // Most-recent identity wins for the avatar — handles the "logged in via TG
  // then linked BSky" case sensibly.
  const result = await db
    .prepare(
      `SELECT r.*,
              (SELECT i.avatar_url FROM identity i WHERE i.user_id = r.user_id
                ORDER BY i.created_at DESC LIMIT 1) AS avatar_url
         FROM roommate r
        WHERE r.room_id = ?
        ORDER BY r.created_at`,
    )
    .bind(roomId)
    .all<RoommateRow & { avatar_url: string | null }>();
  return (result.results ?? []).map((r) => {
    const { avatar_url, ...row } = r;
    return { row: row as RoommateRow, avatarUrl: avatar_url };
  });
}

// ─── visibility ────────────────────────────────────────────────────────────

export async function getVisibility(
  db: D1Database,
  roommateId: string,
): Promise<FieldVisibility> {
  const result = await db
    .prepare('SELECT field_name, min_tier FROM field_visibility WHERE roommate_id = ?')
    .bind(roommateId)
    .all<{ field_name: string; min_tier: Tier }>();
  const out: FieldVisibility = {};
  for (const r of result.results ?? []) {
    out[r.field_name as keyof FieldVisibility] = r.min_tier;
  }
  return out;
}

export async function setVisibility(
  db: D1Database,
  roommateId: string,
  visibility: FieldVisibility,
): Promise<void> {
  const stmts = [
    db.prepare('DELETE FROM field_visibility WHERE roommate_id = ?').bind(roommateId),
    ...Object.entries(visibility).map(([field, tier]) =>
      db
        .prepare(
          'INSERT INTO field_visibility (id, roommate_id, field_name, min_tier) VALUES (?, ?, ?, ?)',
        )
        .bind(newId(), roommateId, field, tier),
    ),
  ];
  await db.batch(stmts);
}

// ─── rooms ─────────────────────────────────────────────────────────────────

export interface RoomRow {
  id: string;
  con_id: string;
  name: string;
  qr_slug: string;
  created_at: string;
  // Added in migration 0010 (room notes pinned blob trailer).
  pinned_note: string | null;
  pinned_note_updated_by_user_id: string | null;
  pinned_note_updated_at: string | null;
  // Added in migration 0011 (admin notifications quiet hours).
  quiet_enabled: number;
  quiet_start_local: string | null;
  quiet_end_local: string | null;
}

/** All rooms the user is a member of, joined with con metadata + caller's role. */
export async function listRoomsForUser(
  db: D1Database,
  userId: string,
): Promise<
  {
    id: string;
    name: string;
    qr_slug: string;
    role: 'admin' | 'member';
    con_id: string;
    con_name: string;
    con_start_date: string | null;
    con_end_date: string | null;
  }[]
> {
  const result = await db
    .prepare(
      `SELECT room.id AS id, room.name AS name, room.qr_slug AS qr_slug,
              roommate.role AS role,
              con.id AS con_id, con.name AS con_name,
              con.start_date AS con_start_date, con.end_date AS con_end_date
         FROM room
         JOIN roommate ON roommate.room_id = room.id
         JOIN con      ON con.id = room.con_id
        WHERE roommate.user_id = ?
        ORDER BY con.start_date DESC, room.created_at DESC`,
    )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      qr_slug: string;
      role: 'admin' | 'member';
      con_id: string;
      con_name: string;
      con_start_date: string | null;
      con_end_date: string | null;
    }>();
  return result.results ?? [];
}

/** Room + con join for the room-detail endpoint. */
export async function getRoomDetail(
  db: D1Database,
  roomId: string,
): Promise<
  | (RoomRow & {
      con_name: string;
      con_start_date: string | null;
      con_end_date: string | null;
      con_location: string | null;
      con_url: string | null;
    })
  | null
> {
  return db
    .prepare(
      `SELECT room.*,
              con.name AS con_name, con.start_date AS con_start_date,
              con.end_date AS con_end_date, con.location AS con_location,
              con.url AS con_url
         FROM room JOIN con ON con.id = room.con_id
        WHERE room.id = ?`,
    )
    .bind(roomId)
    .first();
}

/** All identity rows for a user. Used by /api/auth/me. */
export async function listIdentitiesForUser(
  db: D1Database,
  userId: string,
): Promise<{ provider: 'bsky' | 'telegram'; handle: string | null; avatar_url: string | null }[]> {
  const result = await db
    .prepare(
      `SELECT provider, handle, avatar_url FROM identity
        WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<{ provider: 'bsky' | 'telegram'; handle: string | null; avatar_url: string | null }>();
  return result.results ?? [];
}

/** Display name on the user row. */
export async function getUserDisplayName(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT display_name FROM user WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string }>();
  return row?.display_name ?? null;
}

// ─── devices ───────────────────────────────────────────────────────────────

export interface DeviceRow {
  id: string;
  room_id: string | null;
  paired_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  mac_address?: string | null;
  /**
   * Firmware-facing bearer credential. NULL until the device has been
   * claimed by an operator; refreshed on every claim and cleared on
   * revoke/reset. `device.id` is the internal PK and stays stable
   * across rotations.
   */
  api_key?: string | null;
  /**
   * One-shot window during which `/api/trmnl/setup` will hand the
   * `api_key` to a request that lacks `ACCESS_TOKEN` (the bootstrap
   * after a claim — the firmware doesn't have the key yet). Set by
   * `claimDevice`; cleared on the first successful hand-off.
   */
  api_key_pending_until?: string | null;
  battery_voltage?: number | null;
  percent_charged?: number | null;
  rssi?: number | null;
  fw_version?: string | null;
  model?: string | null;
}

/** TRMNL-reported headers on /display, stashed on the device row. */
export interface DeviceTelemetry {
  batteryVoltage?: number | null;
  percentCharged?: number | null;
  rssi?: number | null;
  fwVersion?: string | null;
  model?: string | null;
}

/**
 * Upsert telemetry fields for a known device. Only columns whose values
 * are non-null in the input are touched, so a poll that omits e.g.
 * battery_voltage doesn't clobber a previously-reported value.
 */
export async function updateDeviceTelemetry(
  db: D1Database,
  deviceId: string,
  t: DeviceTelemetry,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (t.batteryVoltage != null) {
    sets.push('battery_voltage = ?');
    binds.push(t.batteryVoltage);
  }
  if (t.percentCharged != null) {
    sets.push('percent_charged = ?');
    binds.push(t.percentCharged);
  }
  if (t.rssi != null) {
    sets.push('rssi = ?');
    binds.push(t.rssi);
  }
  if (t.fwVersion) {
    sets.push('fw_version = ?');
    binds.push(t.fwVersion);
  }
  if (t.model) {
    sets.push('model = ?');
    binds.push(t.model);
  }
  if (sets.length === 0) return;
  binds.push(deviceId);
  await db
    .prepare(`UPDATE device SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/**
 * Look up a device by MAC address, or insert a fresh unpaired row if none
 * exists. Used by TRMNL's /setup handshake — the device identifies itself by
 * MAC, we hand back a stable UUID it'll use for the rest of its life.
 *
 * Returns the device's id (the value the device should treat as its
 * `Access-Token` going forward).
 */
export async function getOrCreateDeviceByMac(
  db: D1Database,
  macAddress: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .prepare('SELECT id FROM device WHERE mac_address = ?')
    .bind(macAddress)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };

  const id = newId();
  await db
    .prepare('INSERT INTO device (id, mac_address) VALUES (?, ?)')
    .bind(id, macAddress)
    .run();
  return { id, created: true };
}

/**
 * One-shot lookup that joins device → room → con for the TRMNL display
 * envelope. Returns null if the device row doesn't exist; returns the
 * device plus nullable room+con fields if the device is unpaired or
 * paired-but-orphaned.
 */
export async function getDeviceWithCon(
  db: D1Database,
  deviceId: string,
): Promise<{
  device: DeviceRow;
  con_start_date: string | null;
  con_end_date: string | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT device.*,
              con.start_date AS con_start_date,
              con.end_date AS con_end_date
         FROM device
    LEFT JOIN room ON room.id = device.room_id
    LEFT JOIN con  ON con.id = room.con_id
        WHERE device.id = ?`,
    )
    .bind(deviceId)
    .first<DeviceRow & { con_start_date: string | null; con_end_date: string | null }>();
  if (!row) return null;
  const { con_start_date, con_end_date, ...device } = row;
  return { device, con_start_date, con_end_date };
}

export async function getDevice(db: D1Database, deviceId: string): Promise<DeviceRow | null> {
  return db.prepare('SELECT * FROM device WHERE id = ?').bind(deviceId).first<DeviceRow>();
}

/**
 * Look up a device by its firmware-facing `api_key` (the value the
 * TRMNL stock firmware sends in `ACCESS_TOKEN`). Returns null when no
 * row matches — which is the right shape for the route to surface as
 * 401, since the alternative (returning the device.id directly) would
 * leak whether a given key is in the keyspace.
 */
export async function getDeviceByApiKey(
  db: D1Database,
  apiKey: string,
): Promise<DeviceRow | null> {
  if (!apiKey) return null;
  return db.prepare('SELECT * FROM device WHERE api_key = ?').bind(apiKey).first<DeviceRow>();
}

/**
 * One-shot bootstrap: if the device row has a non-expired
 * `api_key_pending_until`, return its `api_key` and clear the window
 * atomically. Used by `/api/trmnl/setup` to hand the credential to a
 * just-claimed device's first poll, where the firmware hasn't yet
 * stored an `ACCESS_TOKEN` to send.
 *
 * Returns null when the window has expired or the device hasn't been
 * claimed yet — both map to "/setup returns 202 stub" at the route.
 */
export async function consumePendingApiKey(
  db: D1Database,
  deviceId: string,
): Promise<string | null> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE device
          SET api_key_pending_until = NULL
        WHERE id = ?
          AND api_key IS NOT NULL
          AND api_key_pending_until IS NOT NULL
          AND api_key_pending_until > ?
        RETURNING api_key`,
    )
    .bind(deviceId, now)
    .first<{ api_key: string }>();
  return result?.api_key ?? null;
}

export async function touchDevice(db: D1Database, deviceId: string): Promise<void> {
  await db
    .prepare('UPDATE device SET last_seen_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), deviceId)
    .run();
}

/** Pending-claim hand-off window for /setup. The device's first poll
 * after a claim consumes the api_key without an Access-Token. Short
 * enough that an attacker racing with the legitimate device has a
 * narrow window; long enough that flaky Wi-Fi during setup doesn't
 * brick the bootstrap. */
const API_KEY_PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Atomically pair a device to a room AND mint its firmware-facing
 * `api_key` if one isn't set yet. Returns the api_key on success and
 * null when the device already belongs to a different room (caller
 * surfaces 409). The 5-minute pending window means the device's next
 * `/api/trmnl/setup` call can pick the credential up even though the
 * firmware has nothing to authenticate with yet.
 *
 * Two pathways succeed:
 *   - Fresh INSERT: device row didn't exist yet.
 *   - Conflict UPDATE gated by WHERE: row exists but is unclaimed
 *     (room_id IS NULL) or previously revoked (revoked_at IS NOT NULL).
 *
 * The WHERE on the conflict branch closes a TOCTOU race between two
 * concurrent claim requests against the same KV pair code: the loser's
 * UPDATE is skipped and meta.changes comes back 0.
 */
export async function claimDevice(
  db: D1Database,
  args: { deviceId: string; roomId: string },
): Promise<string | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const pendingUntil = new Date(now.getTime() + API_KEY_PENDING_TTL_MS).toISOString();
  const apiKey = newId();
  const result = await db
    .prepare(
      `INSERT INTO device (id, room_id, paired_at, last_seen_at, api_key, api_key_pending_until)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         room_id = excluded.room_id,
         paired_at = excluded.paired_at,
         revoked_at = NULL,
         last_seen_at = excluded.last_seen_at,
         api_key = excluded.api_key,
         api_key_pending_until = excluded.api_key_pending_until
       WHERE device.room_id IS NULL OR device.revoked_at IS NOT NULL`,
    )
    .bind(args.deviceId, args.roomId, nowIso, nowIso, apiKey, pendingUntil)
    .run();
  return ((result.meta as { changes?: number }).changes ?? 0) > 0 ? apiKey : null;
}

/**
 * Revoke a device. Clears `room_id` so the panel stops rendering the
 * room view, and clears `last_seen_at` so the renderer can tell whether
 * the revoke notice has already been displayed: the first post-revoke
 * poll sees `last_seen_at IS NULL` and shows the notice, then touches
 * the row — subsequent polls find `last_seen_at` non-null and self-heal
 * to the unpaired+pair-code screen. Re-revoke nulls it again, so the
 * notice rotates back in for one more poll.
 */
/**
 * Returns true when a matching row was updated. The caller passes the
 * room id along with the device id so a stray request from one room's
 * admin can't revoke a device that lives in a different room — the
 * WHERE clause does the cross-tenancy check in the same round-trip
 * that performs the update.
 */
export async function revokeDevice(
  db: D1Database,
  roomId: string,
  deviceId: string,
): Promise<boolean> {
  // Keep `api_key` set so the firmware can still authenticate to
  // /sign.png and render the revoke-notice screen on its next poll
  // (the self-heal classifier uses `last_seen_at IS NULL` as the
  // "notice not yet shown" flag). The credential rotates when an
  // admin re-claims the device via the pair-code OTP — claimDevice
  // overwrites `api_key` with a fresh value at that point. The
  // pending window is cleared because there's no active claim.
  const result = await db
    .prepare(
      'UPDATE device SET room_id = NULL, revoked_at = ?, last_seen_at = NULL, ' +
        'api_key_pending_until = NULL ' +
        'WHERE id = ? AND room_id = ?',
    )
    .bind(new Date().toISOString(), deviceId, roomId)
    .run();
  return ((result.meta as { changes?: number }).changes ?? 0) > 0;
}

/**
 * Delete devices that have been silent past the cutoff. Catches both
 * abandoned panels (`last_seen_at` older than the window) and devices
 * created but never paired (no `last_seen_at`, judged by `created_at`).
 * Returns the number of rows removed for cron logging.
 */
export async function deleteStaleDevices(
  db: D1Database,
  cutoffIso: string,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM device
        WHERE COALESCE(last_seen_at, created_at) < ?`,
    )
    .bind(cutoffIso)
    .run();
  return (result.meta as { changes?: number }).changes ?? 0;
}

export async function listDevicesForRoom(
  db: D1Database,
  roomId: string,
): Promise<DeviceRow[]> {
  const result = await db
    .prepare('SELECT * FROM device WHERE room_id = ? ORDER BY paired_at DESC')
    .bind(roomId)
    .all<DeviceRow>();
  return result.results ?? [];
}

/**
 * Look up the user's most-recent BSky and Telegram handles from their
 * identity rows. Used when inserting a roommate row so we auto-populate
 * the display handle columns from data the OAuth/Login Widget already
 * gave us, rather than leaving them null and forcing a manual PATCH.
 *
 * Default visibility on those fields is still `private` (the user has
 * to opt them in via the visibility editor) — this only seeds the
 * value, not its visibility.
 */
async function lookupIdentityHandles(
  db: D1Database,
  userId: string,
): Promise<{ bsky: string | null; telegram: string | null }> {
  const rows = await db
    .prepare(
      'SELECT provider, handle FROM identity WHERE user_id = ? ORDER BY created_at DESC',
    )
    .bind(userId)
    .all<{ provider: 'bsky' | 'telegram'; handle: string | null }>();
  const out: { bsky: string | null; telegram: string | null } = { bsky: null, telegram: null };
  for (const r of rows.results ?? []) {
    if (r.provider === 'bsky' && !out.bsky) out.bsky = r.handle;
    if (r.provider === 'telegram' && !out.telegram) out.telegram = r.handle;
  }
  return out;
}

export async function createRoomWithAdmin(
  db: D1Database,
  args: { conId: string; name: string; adminUserId: string; passcodeHash: string },
): Promise<{ roomId: string; qrSlug: string; roommateId: string }> {
  const handles = await lookupIdentityHandles(db, args.adminUserId);
  // qr_slug unique constraint: retry on the (extremely unlikely) collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const roomId = newId();
    const qrSlug = newQrSlug();
    const roommateId = newId();
    try {
      await db.batch([
        db
          .prepare('INSERT INTO room (id, con_id, name, qr_slug) VALUES (?, ?, ?, ?)')
          .bind(roomId, args.conId, args.name, qrSlug),
        db
          .prepare(
            'INSERT INTO roommate (id, room_id, user_id, role, passcode_hash, bsky_handle, telegram_handle) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            roommateId,
            roomId,
            args.adminUserId,
            'admin',
            args.passcodeHash,
            handles.bsky,
            handles.telegram,
          ),
      ]);
      return { roomId, qrSlug, roommateId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('UNIQUE') || attempt === 4) throw err;
    }
  }
  throw new Error('createRoomWithAdmin: exhausted slug retries');
}

export async function getRoom(db: D1Database, roomId: string): Promise<RoomRow | null> {
  return db.prepare('SELECT * FROM room WHERE id = ?').bind(roomId).first<RoomRow>();
}

export async function updateRoomName(db: D1Database, roomId: string, name: string): Promise<void> {
  await db.prepare('UPDATE room SET name = ? WHERE id = ?').bind(name, roomId).run();
}

export async function getRoommate(
  db: D1Database,
  roommateId: string,
): Promise<RoommateRow | null> {
  return db.prepare('SELECT * FROM roommate WHERE id = ?').bind(roommateId).first<RoommateRow>();
}

/** Find the caller's roommate row in a given room (used for membership checks). */
export async function getRoommateForUser(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<RoommateRow | null> {
  return db
    .prepare('SELECT * FROM roommate WHERE room_id = ? AND user_id = ?')
    .bind(roomId, userId)
    .first<RoommateRow>();
}

export async function deleteRoommate(db: D1Database, roommateId: string): Promise<void> {
  await db.prepare('DELETE FROM roommate WHERE id = ?').bind(roommateId).run();
}

export async function setRoommateRole(
  db: D1Database,
  roommateId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await db
    .prepare('UPDATE roommate SET role = ? WHERE id = ?')
    .bind(role, roommateId)
    .run();
}

export async function addRoommate(
  db: D1Database,
  args: { roomId: string; userId: string; role: 'admin' | 'member'; passcodeHash: string },
): Promise<string> {
  const handles = await lookupIdentityHandles(db, args.userId);
  const roommateId = newId();
  await db
    .prepare(
      'INSERT INTO roommate (id, room_id, user_id, role, passcode_hash, bsky_handle, telegram_handle) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      roommateId,
      args.roomId,
      args.userId,
      args.role,
      args.passcodeHash,
      handles.bsky,
      handles.telegram,
    )
    .run();
  return roommateId;
}

export async function updateRoommateProfile(
  db: D1Database,
  roommateId: string,
  patch: UpdateRoommate,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    sets.push(`${col} = ?`);
    binds.push(val);
  };
  if ('fursonaName' in patch) push('fursona_name', patch.fursonaName ?? null);
  if ('fursonaSpecies' in patch) push('fursona_species', patch.fursonaSpecies ?? null);
  if ('pronouns' in patch) push('pronouns', patch.pronouns ?? null);
  if ('bskyHandle' in patch) push('bsky_handle', patch.bskyHandle ?? null);
  if ('telegramHandle' in patch) push('telegram_handle', patch.telegramHandle ?? null);
  if ('status' in patch && patch.status !== undefined) {
    for (const [col, val] of statusToColumns(patch.status)) push(col, val);
  }
  if (sets.length === 0) return;
  binds.push(roommateId);
  await db
    .prepare(`UPDATE roommate SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function rotateRoommatePasscode(
  db: D1Database,
  roommateId: string,
  passcodeHash: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE roommate SET passcode_hash = ?, passcode_rotated_at = ? WHERE id = ?',
    )
    .bind(passcodeHash, new Date().toISOString(), roommateId)
    .run();
}


// ─── room notes (pinned blob + transient feed) ─────────────────────────────

export interface PinnedNoteRow {
  body: string | null;
  updated_by_user_id: string | null;
  updated_by_display_name: string | null;
  updated_at: string | null;
}

export interface RoomNoteRow {
  id: string;
  room_id: string;
  author_user_id: string;
  author_display_name: string;
  body: string;
  created_at: string;
}

/** Hard limit; matches the API-layer cap so the SQL stays defensible
 * even if a caller bypasses validation. */
export const FEED_CAP = 50;

export async function getPinnedNote(
  db: D1Database,
  roomId: string,
): Promise<PinnedNoteRow | null> {
  return db
    .prepare(
      `SELECT room.pinned_note AS body,
              room.pinned_note_updated_by_user_id AS updated_by_user_id,
              u.display_name AS updated_by_display_name,
              room.pinned_note_updated_at AS updated_at
         FROM room
    LEFT JOIN user u ON u.id = room.pinned_note_updated_by_user_id
        WHERE room.id = ?`,
    )
    .bind(roomId)
    .first<PinnedNoteRow>();
}

export async function setPinnedNote(
  db: D1Database,
  args: { roomId: string; userId: string; body: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE room
          SET pinned_note = ?,
              pinned_note_updated_by_user_id = ?,
              pinned_note_updated_at = ?
        WHERE id = ?`,
    )
    .bind(args.body, args.userId, new Date().toISOString(), args.roomId)
    .run();
}

export async function listRoomNotes(
  db: D1Database,
  roomId: string,
): Promise<RoomNoteRow[]> {
  // `rowid DESC` is the tiebreaker (not `id DESC`) because the `id`
  // column is a random UUID — within a same-second cohort that would
  // order entries arbitrarily. SQLite's implicit `rowid` is always
  // monotonically increasing per insert, so it gives us a stable
  // "newest first" order even when `created_at` has second-precision
  // collisions.
  const result = await db
    .prepare(
      `SELECT n.id, n.room_id, n.author_user_id,
              u.display_name AS author_display_name,
              n.body, n.created_at
         FROM room_note n
         JOIN user u ON u.id = n.author_user_id
        WHERE n.room_id = ?
        ORDER BY n.created_at DESC, n.rowid DESC
        LIMIT ?`,
    )
    .bind(roomId, FEED_CAP)
    .all<RoomNoteRow>();
  return result.results ?? [];
}

/**
 * Insert a feed entry and TTL out anything beyond the FEED_CAP newest
 * rows in the same room. Two statements; D1's `batch()` runs them
 * atomically so a partial write can't leave the room over the cap.
 */
export async function createRoomNote(
  db: D1Database,
  args: { roomId: string; authorUserId: string; body: string },
): Promise<string> {
  const noteId = newId();
  await db.batch([
    db
      .prepare(
        'INSERT INTO room_note (id, room_id, author_user_id, body) VALUES (?, ?, ?, ?)',
      )
      .bind(noteId, args.roomId, args.authorUserId, args.body),
    db
      .prepare(
        // See `listRoomNotes` for why we tiebreak on rowid, not id.
        `DELETE FROM room_note
           WHERE room_id = ?
             AND id NOT IN (
               SELECT id FROM room_note
                WHERE room_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
             )`,
      )
      .bind(args.roomId, args.roomId, FEED_CAP),
  ]);
  return noteId;
}

export async function getRoomNote(
  db: D1Database,
  noteId: string,
): Promise<{ id: string; room_id: string; author_user_id: string } | null> {
  return db
    .prepare('SELECT id, room_id, author_user_id FROM room_note WHERE id = ?')
    .bind(noteId)
    .first<{ id: string; room_id: string; author_user_id: string }>();
}

export async function deleteRoomNote(db: D1Database, noteId: string): Promise<void> {
  await db.prepare('DELETE FROM room_note WHERE id = ?').bind(noteId).run();
}

// ─── notification_pref (shared scaffolding) ────────────────────────────────
// One row per (recipient_user_id, room_id, kind, source_roommate_id).
// `kind='room_note'` with `source_roommate_id` set is the only consumer
// today; the table is designed to absorb Admin-Notifications kinds
// (panel_offline, battery_low, ...) where source_roommate_id will be NULL.

export interface NotificationPrefRow {
  id: string;
  recipient_user_id: string;
  room_id: string;
  kind: string;
  source_roommate_id: string | null;
  enabled: number; // SQLite returns INTEGER
}

export async function listRoomNotePrefs(
  db: D1Database,
  args: { recipientUserId: string; roomId: string },
): Promise<NotificationPrefRow[]> {
  const result = await db
    .prepare(
      `SELECT id, recipient_user_id, room_id, kind, source_roommate_id, enabled
         FROM notification_pref
        WHERE recipient_user_id = ? AND room_id = ? AND kind = 'room_note'`,
    )
    .bind(args.recipientUserId, args.roomId)
    .all<NotificationPrefRow>();
  return result.results ?? [];
}

export async function upsertNotePref(
  db: D1Database,
  args: {
    recipientUserId: string;
    roomId: string;
    sourceRoommateId: string;
    enabled: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO notification_pref
         (id, recipient_user_id, room_id, kind, source_roommate_id, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, 'room_note', ?, ?, ?, ?)
       ON CONFLICT (recipient_user_id, room_id, kind, source_roommate_id)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(
      newId(),
      args.recipientUserId,
      args.roomId,
      args.sourceRoommateId,
      args.enabled ? 1 : 0,
      now,
      now,
    )
    .run();
}

// ─── admin notifications (rules / quiet hours / log / delivery channel) ────
// See PLAN.md "Admin notifications". Schema delta lands in migration 0011.

export interface NotificationLogRow {
  id: string;
  room_id: string;
  recipient_user_id: string;
  kind: string;
  fired_at: string;
  payload_json: string | null;
  delivery_status: string;
  delivery_error: string | null;
}

export interface QuietHoursRow {
  quiet_enabled: number;
  quiet_start_local: string | null;
  quiet_end_local: string | null;
}

/**
 * List the calling admin's per-rule preferences for one room. Returns
 * raw rows for the four critical kinds; the route synthesizes defaults
 * for kinds that have no row yet (opt-out model).
 */
export async function listNotificationRulePrefs(
  db: D1Database,
  args: { recipientUserId: string; roomId: string },
): Promise<NotificationPrefRow[]> {
  const result = await db
    .prepare(
      `SELECT id, recipient_user_id, room_id, kind, source_roommate_id, enabled
         FROM notification_pref
        WHERE recipient_user_id = ? AND room_id = ?
          AND kind IN ('panel_offline', 'panel_battery_low',
                       'roommate_status_stale', 'claim_attempts_high')
          AND source_roommate_id IS NULL`,
    )
    .bind(args.recipientUserId, args.roomId)
    .all<NotificationPrefRow>();
  return result.results ?? [];
}

export async function upsertRulePref(
  db: D1Database,
  args: {
    recipientUserId: string;
    roomId: string;
    kind: string;
    enabled: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  // The conflict target picks the partial unique index that's keyed on
  // (recipient, room, kind) and scoped to NULL source — without that
  // WHERE clause SQLite would target the migration-0010 index whose
  // source_roommate_id column is NULL here and therefore never matches
  // another NULL row. See migration 0011 for the index definition.
  await db
    .prepare(
      `INSERT INTO notification_pref
         (id, recipient_user_id, room_id, kind, source_roommate_id, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (recipient_user_id, room_id, kind)
       WHERE source_roommate_id IS NULL
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(
      newId(),
      args.recipientUserId,
      args.roomId,
      args.kind,
      args.enabled ? 1 : 0,
      now,
      now,
    )
    .run();
}

export async function getQuietHours(
  db: D1Database,
  roomId: string,
): Promise<QuietHoursRow | null> {
  return db
    .prepare(
      'SELECT quiet_enabled, quiet_start_local, quiet_end_local FROM room WHERE id = ?',
    )
    .bind(roomId)
    .first<QuietHoursRow>();
}

export async function setQuietHours(
  db: D1Database,
  args: {
    roomId: string;
    enabled: boolean;
    startLocal: string | null;
    endLocal: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE room
          SET quiet_enabled = ?,
              quiet_start_local = ?,
              quiet_end_local = ?
        WHERE id = ?`,
    )
    .bind(
      args.enabled ? 1 : 0,
      args.startLocal,
      args.endLocal,
      args.roomId,
    )
    .run();
}

/** Most-recent N alerts for a room. v1 returns empty until the cron
 * starts writing; the endpoint still surfaces the read path so the
 * "Recent Alerts" card renders a clean empty state. */
export async function listRecentAlertsForRoom(
  db: D1Database,
  roomId: string,
  limit: number,
): Promise<NotificationLogRow[]> {
  const result = await db
    .prepare(
      `SELECT id, room_id, recipient_user_id, kind, fired_at,
              payload_json, delivery_status, delivery_error
         FROM notification_log
        WHERE room_id = ?
        ORDER BY fired_at DESC, rowid DESC
        LIMIT ?`,
    )
    .bind(roomId, limit)
    .all<NotificationLogRow>();
  return result.results ?? [];
}

/**
 * The caller's linked Telegram identity, if any. Used to populate the
 * `delivery.linked + handle` shape on the notifications view so the
 * dashboard can swap between the linked-pill and the link-CTA.
 */
export async function getTelegramIdentityForUser(
  db: D1Database,
  userId: string,
): Promise<{ handle: string | null } | null> {
  return db
    .prepare(
      `SELECT handle FROM identity
        WHERE user_id = ? AND provider = 'telegram'
        ORDER BY id LIMIT 1`,
    )
    .bind(userId)
    .first<{ handle: string | null }>();
}
