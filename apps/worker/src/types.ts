/**
 * Bindings declared in wrangler.toml. Keep this in sync.
 */
export interface Bindings {
  DB: D1Database;
  SESSIONS: KVNamespace;
  UNLOCK_RL: RateLimit;
  CLAIM_RL: RateLimit;
  AVATAR_RL: RateLimit;

  // vars
  ICS_FEED_URL: string;
  TURNSTILE_SITE_KEY: string;

  // secrets
  SESSION_HMAC: string;
  /** JSON array of private JWKs (ES256). First key signs; all publish on /jwks.json. */
  BSKY_PRIVATE_JWKS?: string;
  TG_BOT_TOKEN: string;
  TURNSTILE_SECRET: string;
}

/**
 * Hono Variables — values set on the request context by middleware.
 */
export interface Variables {
  /** Set by the auth middleware when an admin/roommate session is valid. */
  userId?: string;
  /** Set by the visitor middleware: roommate IDs the viewer has unlocked. */
  unlockedRoommateIds?: string[];
}

export type Env = { Bindings: Bindings; Variables: Variables };

/**
 * Workers Rate Limiting binding shape — not yet in @cloudflare/workers-types
 * for all releases, so declare locally.
 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
