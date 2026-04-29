import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

export const visitorRoutes = new Hono<Env>();

visitorRoutes.get('/:slug', () => {
  throw new HttpError(404, 'not_implemented', 'Room visitor view — task #10');
});

visitorRoutes.post('/:slug/unlock', () => {
  throw new HttpError(404, 'not_implemented', 'Passcode unlock — task #10/#11');
});
