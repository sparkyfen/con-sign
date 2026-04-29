import { describe, expect, it } from 'vitest';
import { call, newCtx, seedCon } from '../helpers.js';

describe('integration: cons typeahead', () => {
  it('returns upcoming cons matching a query', async () => {
    const ctx = newCtx();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await seedCon(ctx, { name: 'Furry Weekend', startDate: tomorrow, endDate: future });
    await seedCon(ctx, { name: 'Sci-fi Con', startDate: tomorrow, endDate: future });

    const r = await call(ctx, 'GET', '/api/cons?q=Furry');
    expect(r.status).toBe(200);
    const body = r.body as { cons: { name: string }[] };
    expect(body.cons.map((c) => c.name)).toEqual(['Furry Weekend']);
  });

  it('excludes cons whose end_date is in the past', async () => {
    const ctx = newCtx();
    await seedCon(ctx, {
      name: 'Old Con',
      startDate: '2020-01-01',
      endDate: '2020-01-03',
    });
    const r = await call(ctx, 'GET', '/api/cons');
    expect((r.body as { cons: unknown[] }).cons).toHaveLength(0);
  });
});
