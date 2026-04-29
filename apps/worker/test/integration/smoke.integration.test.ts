import { describe, expect, it } from 'vitest';
import { call, newCtx } from '../helpers.js';

describe('integration: smoke', () => {
  it('responds to /api/health', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('returns 404 on unknown routes', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/does-not-exist');
    expect(r.status).toBe(404);
  });

  it('rejects unauthenticated room creation', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'POST', '/api/rooms', {
      body: { conId: '00000000-0000-0000-0000-000000000000', name: 'X' },
    });
    expect(r.status).toBe(401);
  });
});
