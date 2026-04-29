import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

export const conRoutes = new Hono<Env>();

conRoutes.get('/', () => {
  throw new HttpError(404, 'not_implemented', 'Cons typeahead — task #17');
});

conRoutes.post('/sync', () => {
  throw new HttpError(404, 'not_implemented', 'Manual ICS resync — task #17');
});
