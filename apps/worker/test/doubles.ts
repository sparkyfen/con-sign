/**
 * Test doubles for Cloudflare bindings: D1, KV, RateLimit.
 * Backed by better-sqlite3 + plain Maps. They implement only the surface
 * area the Worker actually uses (no full conformance with @cloudflare/types).
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── D1 ────────────────────────────────────────────────────────────────────

type D1Result = { results: unknown[]; success: boolean; meta: { rows_read: number } };

class D1Statement {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...args: unknown[]): D1Statement {
    return new D1Statement(this.sqlite, this.sql, args);
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...(this.params as []));
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...(this.params as [])) as T[];
    return { results: rows };
  }

  async run(): Promise<D1Result> {
    const info = this.sqlite.prepare(this.sql).run(...(this.params as []));
    return { results: [], success: true, meta: { rows_read: info.changes } };
  }
}

class D1Stub {
  constructor(private readonly sqlite: Database.Database) {}
  prepare(sql: string): D1Statement {
    return new D1Statement(this.sqlite, sql);
  }
  async batch(stmts: D1Statement[]): Promise<D1Result[]> {
    const txn = this.sqlite.transaction((items: D1Statement[]) => {
      const results: D1Result[] = [];
      for (const s of items) {
        // Reach into the private state — fine for a test double.
        const sql = (s as unknown as { sql: string }).sql;
        const params = (s as unknown as { params: unknown[] }).params;
        const stmt = this.sqlite.prepare(sql);
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
          stmt.all(...(params as []));
        } else {
          stmt.run(...(params as []));
        }
        results.push({ results: [], success: true, meta: { rows_read: 0 } });
      }
      return results;
    });
    return txn(stmts);
  }
}

export function createD1(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = join(process.cwd(), 'src/db/migrations');
  const initSql = readFileSync(join(migrationsDir, '0001_init.sql'), 'utf8');
  sqlite.exec(initSql);
  // SQLite reserves `user` and `con` — check our migration uses them as
  // identifiers (it does; they're not reserved in SQLite proper, just MySQL).
  return new D1Stub(sqlite) as unknown as D1Database;
}

// ─── KV ────────────────────────────────────────────────────────────────────

interface KvEntry {
  value: string;
  expiresAt: number | null;
}

export function createKV(): KVNamespace {
  const store = new Map<string, KvEntry>();
  const now = (): number => Date.now();
  const stub = {
    async get(key: string): Promise<string | null> {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && e.expiresAt < now()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      const expiresAt = opts?.expirationTtl ? now() + opts.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor: string }> {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
        cursor: '',
      };
    },
  };
  return stub as unknown as KVNamespace;
}

// ─── RateLimit ─────────────────────────────────────────────────────────────

export function createRateLimit(): { limit: (o: { key: string }) => Promise<{ success: boolean }> } {
  // For tests we always succeed — rate-limit logic is exercised by hand by
  // tests that need it (by replacing this stub).
  return { limit: async () => ({ success: true }) };
}

// ─── Bindings factory ──────────────────────────────────────────────────────

export interface TestBindings {
  DB: D1Database;
  SESSIONS: KVNamespace;
  UNLOCK_RL: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
  ICS_FEED_URL: string;
  TURNSTILE_SITE_KEY: string;
  SESSION_HMAC: string;
  BSKY_CLIENT_SECRET: string;
  TG_BOT_TOKEN: string;
  TURNSTILE_SECRET: string;
}

export function createTestBindings(overrides: Partial<TestBindings> = {}): TestBindings {
  return {
    DB: createD1(),
    SESSIONS: createKV(),
    UNLOCK_RL: createRateLimit(),
    ICS_FEED_URL: 'https://example.invalid/test.ics',
    TURNSTILE_SITE_KEY: 'test-site-key',
    SESSION_HMAC: 'test-hmac-secret-do-not-use-in-prod',
    BSKY_CLIENT_SECRET: 'test',
    TG_BOT_TOKEN: 'test-bot-token',
    TURNSTILE_SECRET: 'test-turnstile-secret',
    ...overrides,
  };
}
