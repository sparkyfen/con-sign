import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Bindings, Env } from './types.js';
import { HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { avatarRoutes } from './routes/avatar.js';
import { conRoutes } from './routes/cons.js';
import { deviceRoutes } from './routes/device.js';
import { meRoutes } from './routes/me.js';
import { partyRoutes } from './routes/parties.js';
import { roomRoutes } from './routes/rooms.js';
import { visitorRoutes } from './routes/visitor.js';
import { runIcsSync, runStaleDeviceCleanup } from './cron/ics-sync.js';
import { csrfOriginCheck } from './auth/csrf.js';

export const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: 'invalid_request', issues: err.issues }, 400);
  }
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  // Unknown failure — log the detail server-side so it shows up in
  // `wrangler tail`, but don't echo it back to the client. Raw error
  // messages from D1 / fetch / JSON.parse can leak schema, internal
  // hostnames, or payload contents we'd rather keep server-side.
  console.error('unhandled error', err);
  return c.json({ error: 'internal_error' }, 500);
});

/**
 * Liveness + binding probe. Each component independently pinged so a
 * misconfigured binding shows up as `ok: false` for that component
 * specifically, not a generic 500. Cheap enough to hit from uptime
 * monitors at 1/min without worrying about D1 quota.
 */
// CSRF defense: every state-changing method must carry a same-host Origin
// header. Mounted before any route so the check is unmissable.
app.use('*', csrfOriginCheck);

app.get('/api/health', async (c) => {
  const [d1, kv] = await Promise.all([
    c.env.DB.prepare('SELECT 1 AS ok')
      .first<{ ok: number }>()
      .then((r) => r?.ok === 1)
      .catch(() => false),
    (async () => {
      const probeKey = 'health:probe';
      try {
        await c.env.SESSIONS.put(probeKey, '1', { expirationTtl: 60 });
        const v = await c.env.SESSIONS.get(probeKey);
        return v === '1';
      } catch {
        return false;
      }
    })(),
  ]);
  const ok = d1 && kv;
  return c.json({ ok, components: { d1, kv } }, ok ? 200 : 503);
});

app.route('/api/auth', authRoutes);
app.route('/api/avatar', avatarRoutes);
app.route('/api/cons', conRoutes);
app.route('/api/me', meRoutes);
app.route('/api/r', visitorRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api/device', deviceRoutes);
app.route('/api/parties', partyRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runIcsSync(env));
    ctx.waitUntil(runStaleDeviceCleanup(env));
  },
} satisfies ExportedHandler<Bindings>;
