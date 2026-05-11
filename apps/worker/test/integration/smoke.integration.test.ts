import { describe, expect, it } from 'vitest';
import { call, newCtx } from '../helpers.js';

describe('integration: smoke', () => {
  it('responds to /api/health with component probes', async () => {
    const ctx = newCtx();
    const r = await call(ctx, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, components: { d1: true, kv: true } });
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

  it('does not leak raw error messages on unexpected failures', async () => {
    // Drop a table the cons typeahead reads from to force a D1 error.
    const ctx = newCtx();
    await ctx.env.DB.prepare('DROP TABLE con').run();
    const r = await call(ctx, 'GET', '/api/cons');
    expect(r.status).toBe(500);
    const body = r.body as { error: string; message?: string };
    expect(body.error).toBe('internal_error');
    // No leaked SQL / D1 message in the response body.
    expect(body.message).toBeUndefined();
  });
});
