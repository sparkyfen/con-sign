/**
 * Hand-written D1 query helpers. We intentionally don't use an ORM — the
 * surface is small, the schema is fixed, and prepared statements with
 * parameter binding are clear at the call site.
 */

import type { Roommate, Status } from '@con-sign/shared';
import type { FieldVisibility, Tier } from '@con-sign/shared';

const newId = (): string => crypto.randomUUID();

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
