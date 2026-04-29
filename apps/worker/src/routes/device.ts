import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

export const deviceRoutes = new Hono<Env>();

deviceRoutes.get('/sign.png', () => {
  throw new HttpError(404, 'not_implemented', 'E-ink PNG render — task #16');
});
