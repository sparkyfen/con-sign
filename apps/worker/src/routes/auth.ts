import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

export const authRoutes = new Hono<Env>();

authRoutes.get('/bsky/start', () => {
  throw new HttpError(404, 'not_implemented', 'BlueSky OAuth start — task #8');
});

authRoutes.get('/bsky/callback', () => {
  throw new HttpError(404, 'not_implemented', 'BlueSky OAuth callback — task #8');
});

authRoutes.post('/telegram/callback', () => {
  throw new HttpError(404, 'not_implemented', 'Telegram login — task #9');
});

authRoutes.post('/logout', () => {
  throw new HttpError(404, 'not_implemented', 'Logout — task #7');
});
