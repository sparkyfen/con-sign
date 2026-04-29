import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

// Stretch: parties hosted in the room. Routes stubbed for shape; gated by
// feature flag in the UI for v1.
export const partyRoutes = new Hono<Env>();

partyRoutes.post('/', () => {
  throw new HttpError(404, 'not_implemented', 'Create party — stretch');
});

partyRoutes.patch('/:id', () => {
  throw new HttpError(404, 'not_implemented', 'Update party — stretch');
});

partyRoutes.delete('/:id', () => {
  throw new HttpError(404, 'not_implemented', 'Delete party — stretch');
});
