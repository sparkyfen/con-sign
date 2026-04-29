/**
 * Hand-written D1 query helpers. We intentionally don't use an ORM — the
 * surface is small, the schema is fixed, and prepared statements with
 * parameter binding are clear at the call site.
 */

import type { Roommate, Status, UpdateRoommate } from '@con-sign/shared';
import type { FieldVisibility, Tier } from '@con-sign/shared';

const newId = (): string => crypto.randomUUID();

const SLUG_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
export const newQrSlug = (len = 10): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[(bytes[i] ?? 0) % SLUG_ALPHABET.length];
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
  raw_profile_json: string | null;
}

/**
 * Upsert an external identity, creating the underlying user if no identity
 * with this (provider, provider_id) exists yet. Returns the user_id.
 */
export async function upsertIdentity(
  db: D1Database,
  args: {
    provider: 'bsky' | 'telegram';
    providerId: string;
    handle: string | null;
    avatarUrl: string | null;
    displayName: string;
    rawProfile: unknown;
  },
): Promise<string> {
  const existing = await db
    .prepare('SELECT user_id FROM identity WHERE provider = ? AND provider_id = ?')
    .bind(args.provider, args.providerId)
    .first<{ user_id: string }>();

  if (existing) {
    await db
      .prepare(
        'UPDATE identity SET handle = ?, avatar_url = ?, raw_profile_json = ? ' +
          'WHERE provider = ? AND provider_id = ?',
      )
      .bind(
        args.handle,
        args.avatarUrl,
        JSON.stringify(args.rawProfile),
        args.provider,
        args.providerId,
      )
      .run();
    return existing.user_id;
  }

  const userId = newId();
  const identityId = newId();
  await db.batch([
    db.prepare('INSERT INTO user (id, display_name) VALUES (?, ?)').bind(userId, args.displayName),
    db
      .prepare(
        'INSERT INTO identity (id, user_id, provider, provider_id, handle, avatar_url, raw_profile_json) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        identityId,
        userId,
        args.provider,
        args.providerId,
        args.handle,
        args.avatarUrl,
        JSON.stringify(args.rawProfile),
      ),
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
export function roommateRowToApi(row: RoommateRow, avatarUrl: string | null): Roommate {
  const status: Status | null =
    row.status_kind === 'preset' && row.status_preset
      ? { kind: 'preset', preset: row.status_preset }
      : row.status_kind === 'custom' && row.status_custom_text
        ? { kind: 'custom', text: row.status_custom_text }
        : null;

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
  device_token_hash: string | null;
  created_at: string;
}

export async function createRoomWithAdmin(
  db: D1Database,
  args: { conId: string; name: string; adminUserId: string; passcodeHash: string },
): Promise<{ roomId: string; qrSlug: string; roommateId: string }> {
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
            'INSERT INTO roommate (id, room_id, user_id, role, passcode_hash) ' +
              'VALUES (?, ?, ?, ?, ?)',
          )
          .bind(roommateId, roomId, args.adminUserId, 'admin', args.passcodeHash),
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

export async function addRoommate(
  db: D1Database,
  args: { roomId: string; userId: string; role: 'admin' | 'member'; passcodeHash: string },
): Promise<string> {
  const roommateId = newId();
  await db
    .prepare(
      'INSERT INTO roommate (id, room_id, user_id, role, passcode_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(roommateId, args.roomId, args.userId, args.role, args.passcodeHash)
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
  if ('status' in patch) {
    if (patch.status === null) {
      push('status_kind', null);
      push('status_preset', null);
      push('status_custom_text', null);
      push('status_updated_at', null);
    } else if (patch.status?.kind === 'preset') {
      push('status_kind', 'preset');
      push('status_preset', patch.status.preset);
      push('status_custom_text', null);
      push('status_updated_at', new Date().toISOString());
    } else if (patch.status?.kind === 'custom') {
      push('status_kind', 'custom');
      push('status_preset', null);
      push('status_custom_text', patch.status.text);
      push('status_updated_at', new Date().toISOString());
    }
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

export async function setRoomDeviceTokenHash(
  db: D1Database,
  roomId: string,
  hash: string,
): Promise<void> {
  await db.prepare('UPDATE room SET device_token_hash = ? WHERE id = ?').bind(hash, roomId).run();
}
