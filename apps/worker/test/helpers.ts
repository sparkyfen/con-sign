import { app } from '../src/index.js';
import {
  SESSION_COOKIE,
  buildCookie,
  newUserSession,
  signSession,
} from '../src/auth/session.js';
import { hashPasscode } from '../src/auth/passcode.js';
import { createTestBindings, type TestBindings } from './doubles.js';

const ORIGIN = 'http://localhost';

export interface Ctx {
  env: TestBindings;
  cookies: Map<string, string>;
}

export const newCtx = (overrides: Partial<TestBindings> = {}): Ctx => ({
  env: createTestBindings(overrides),
  cookies: new Map(),
});

const cookieHeader = (cookies: Map<string, string>): string =>
  Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

const captureSetCookies = (res: Response, cookies: Map<string, string>): void => {
  // hono returns multiple Set-Cookie via getSetCookie() in modern Web standards,
  // but Response.headers.get('set-cookie') can collapse them. Loop through
  // headers to handle both shapes.
  const setCookies: string[] = [];
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === 'set-cookie') setCookies.push(v);
  }
  // @ts-expect-error getSetCookie may not be in all TS lib versions
  if (typeof res.headers.getSetCookie === 'function') {
    // @ts-expect-error see above
    const arr = res.headers.getSetCookie() as string[];
    if (arr.length > setCookies.length) setCookies.splice(0, setCookies.length, ...arr);
  }
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair!.indexOf('=');
    if (eq < 0) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    if (value === '') cookies.delete(name);
    else cookies.set(name, value);
  }
};

export async function call(
  ctx: Ctx,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; res: Response }> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (ctx.cookies.size > 0) headers.set('Cookie', cookieHeader(ctx.cookies));

  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const res = await app.fetch(req, ctx.env as unknown as Parameters<typeof app.fetch>[1]);
  captureSetCookies(res, ctx.cookies);

  const ct = res.headers.get('Content-Type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body, res };
}

/**
 * Inject a "logged-in user" by directly minting and storing a session cookie.
 * Avoids running through Telegram OAuth in every test.
 */
export async function loginAs(ctx: Ctx, userId: string): Promise<void> {
  const session = newUserSession(userId);
  const token = await signSession(session, ctx.env.SESSION_HMAC);
  ctx.cookies.set(SESSION_COOKIE, token);
  // Also create the matching user row so foreign keys hold.
  await ctx.env.DB.prepare(
    'INSERT OR IGNORE INTO user (id, display_name) VALUES (?, ?)',
  )
    .bind(userId, `user-${userId.slice(0, 6)}`)
    .run();
}

/** Insert a test con (bypasses ICS sync). */
export async function seedCon(
  ctx: Ctx,
  args: { id?: string; name?: string; startDate?: string; endDate?: string } = {},
): Promise<string> {
  const id = args.id ?? crypto.randomUUID();
  await ctx.env.DB.prepare(
    `INSERT INTO con (id, ics_uid, name, start_date, end_date, source_updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `test-${id}`,
      args.name ?? 'Test Con',
      args.startDate ?? '2026-06-01',
      args.endDate ?? '2026-06-04',
      new Date().toISOString(),
    )
    .run();
  return id;
}

export { hashPasscode, buildCookie };
