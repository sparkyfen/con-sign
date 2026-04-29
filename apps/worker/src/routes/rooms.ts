import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../errors.js';

export const roomRoutes = new Hono<Env>();

roomRoutes.post('/', () => {
  throw new HttpError(404, 'not_implemented', 'Create room — task #12');
});

roomRoutes.get('/:id', () => {
  throw new HttpError(404, 'not_implemented', 'Get room — task #12');
});

roomRoutes.patch('/:id', () => {
  throw new HttpError(404, 'not_implemented', 'Update room — task #12');
});

roomRoutes.post('/:id/invite', () => {
  throw new HttpError(404, 'not_implemented', 'Invite roommate — task #12');
});

roomRoutes.post('/:id/join', () => {
  throw new HttpError(404, 'not_implemented', 'Join via invite — task #12');
});

roomRoutes.delete('/:id/roommates/:rid', () => {
  throw new HttpError(404, 'not_implemented', 'Remove roommate — task #12');
});

roomRoutes.patch('/:id/roommates/:rid', () => {
  throw new HttpError(404, 'not_implemented', 'Update roommate profile — task #12');
});

roomRoutes.put('/:id/roommates/:rid/visibility', () => {
  throw new HttpError(404, 'not_implemented', 'Visibility editor — task #13');
});

roomRoutes.post('/:id/roommates/:rid/passcode', () => {
  throw new HttpError(404, 'not_implemented', 'Rotate roommate passcode — task #14');
});

roomRoutes.post('/:id/device-token', () => {
  throw new HttpError(404, 'not_implemented', 'Issue device token — task #15');
});
