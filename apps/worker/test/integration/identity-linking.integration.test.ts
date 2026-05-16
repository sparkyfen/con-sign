import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx } from '../helpers.js';
import { upsertIdentity, IdentityCollisionError } from '../../src/db/queries.js';

const USER_A = '00000000-0000-0000-0000-000000000ee1';
const USER_B = '00000000-0000-0000-0000-000000000ee2';

describe('integration: identity linking via upsertIdentity', () => {
  it('creates a fresh user when no session and no existing identity', async () => {
    const ctx = newCtx();
    const userId = await upsertIdentity(ctx.env.DB, {
      provider: 'bsky',
      providerId: 'did:plc:fresh',
      handle: 'fresh.bsky.social',
      avatarUrl: null,
      displayName: 'Fresh',

    });
    expect(userId).toBeTruthy();
    const u = await ctx.env.DB.prepare('SELECT id FROM user WHERE id = ?').bind(userId).first();
    expect(u).not.toBeNull();
  });

  it('returns the same user_id on repeat login of an existing identity', async () => {
    const ctx = newCtx();
    const first = await upsertIdentity(ctx.env.DB, {
      provider: 'bsky',
      providerId: 'did:plc:repeat',
      handle: 'repeat.bsky.social',
      avatarUrl: null,
      displayName: 'Repeat',

    });
    const second = await upsertIdentity(ctx.env.DB, {
      provider: 'bsky',
      providerId: 'did:plc:repeat',
      handle: 'repeat.bsky.social',
      avatarUrl: 'https://example.invalid/new.jpg',
      displayName: 'Repeat',

    });
    expect(second).toBe(first);
  });

  it('attaches a new identity to the active session user (link flow)', async () => {
    const ctx = newCtx();
    await loginAs(ctx, USER_A);

    const linked = await upsertIdentity(ctx.env.DB, {
      provider: 'telegram',
      providerId: '12345',
      handle: 'tg_new',
      avatarUrl: null,
      displayName: 'TG',

      linkToUserId: USER_A,
    });
    expect(linked).toBe(USER_A);

    // Only one user row should exist (the one loginAs created).
    const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM user')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    // The identity row points at USER_A.
    const ident = await ctx.env.DB.prepare(
      'SELECT user_id FROM identity WHERE provider = ? AND provider_id = ?',
    )
      .bind('telegram', '12345')
      .first<{ user_id: string }>();
    expect(ident?.user_id).toBe(USER_A);
  });

  it('is a no-op when re-attaching an identity that already belongs to the same user', async () => {
    const ctx = newCtx();
    await loginAs(ctx, USER_A);
    // Pre-seed the identity on USER_A.
    await ctx.env.DB.prepare(
      "INSERT INTO identity (id, user_id, provider, provider_id, handle) VALUES ('id1', ?, 'bsky', 'did:plc:owned', 'me')",
    )
      .bind(USER_A)
      .run();

    const result = await upsertIdentity(ctx.env.DB, {
      provider: 'bsky',
      providerId: 'did:plc:owned',
      handle: 'me',
      avatarUrl: null,
      displayName: 'me',

      linkToUserId: USER_A,
    });
    expect(result).toBe(USER_A);
  });

  it('throws IdentityCollisionError when linking to a different user', async () => {
    const ctx = newCtx();
    await loginAs(ctx, USER_A);
    await loginAs(ctx, USER_B); // creates the user row, leaves the cookie pointing at B
    // Pre-seed the identity on USER_B.
    await ctx.env.DB.prepare(
      "INSERT INTO identity (id, user_id, provider, provider_id, handle) VALUES ('id2', ?, 'telegram', '999', 'b')",
    )
      .bind(USER_B)
      .run();

    await expect(
      upsertIdentity(ctx.env.DB, {
        provider: 'telegram',
        providerId: '999',
        handle: 'b',
        avatarUrl: null,
        displayName: 'b',

        linkToUserId: USER_A,
      }),
    ).rejects.toBeInstanceOf(IdentityCollisionError);
  });

});
