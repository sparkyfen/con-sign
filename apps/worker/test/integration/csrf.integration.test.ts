import { describe, expect, it } from 'vitest';
import { call, loginAs, newCtx, seedCon } from '../helpers.js';

const ADMIN = '00000000-0000-0000-0000-000000000c01';

describe('integration: CSRF Origin check', () => {
  it('rejects body-bearing requests with no Origin', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'R' },
      headers: { Origin: '' }, // explicit empty == drop the header
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe('origin_required');
  });

  it('rejects body-bearing requests with cross-origin Origin', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    const r = await call(ctx, 'POST', '/api/rooms', {
      body: { conId, name: 'R' },
      headers: { Origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe('origin_mismatch');
  });

  it('allows body-bearing requests with same-origin Origin', async () => {
    const ctx = newCtx();
    const conId = await seedCon(ctx);
    await loginAs(ctx, ADMIN);
    // Default helper sets Origin: http://localhost; the Request is built
    // against the same origin, so this should pass.
    const r = await call(ctx, 'POST', '/api/rooms', { body: { conId, name: 'R' } });
    expect(r.status).toBe(200);
  });

  it('allows GET without Origin (Bluesky callback shape)', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/health');
    expect(r.status).toBe(200);
  });
});
