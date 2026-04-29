import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Bindings, Env } from './types.js';
import { HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { conRoutes } from './routes/cons.js';
import { deviceRoutes } from './routes/device.js';
import { partyRoutes } from './routes/parties.js';
import { roomRoutes } from './routes/rooms.js';
import { visitorRoutes } from './routes/visitor.js';
import { runIcsSync } from './cron/ics-sync.js';

const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: 'invalid_request', issues: err.issues }, 400);
  }
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/api/auth', authRoutes);
app.route('/api/cons', conRoutes);
app.route('/api/r', visitorRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api/device', deviceRoutes);
app.route('/api/parties', partyRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runIcsSync(env));
  },
} satisfies ExportedHandler<Bindings>;
