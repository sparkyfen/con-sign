# @con-sign/worker

Cloudflare Worker: API, visitor flow, device PNG render, and daily ICS sync.

## First-time setup

```bash
pnpm install

# Create the D1 database and copy the printed database_id into wrangler.toml
pnpm wrangler d1 create con-sign-db

# Create the sessions KV namespace and copy the printed id into wrangler.toml
pnpm wrangler kv namespace create SESSIONS

# Apply migrations locally
pnpm db:migrate:local

# Set required secrets (production)
pnpm wrangler secret put SESSION_HMAC        # 64-char random hex
pnpm wrangler secret put BSKY_CLIENT_SECRET  # AT Protocol OAuth secret
pnpm wrangler secret put TG_BOT_TOKEN        # Telegram bot token
pnpm wrangler secret put TURNSTILE_SECRET    # Cloudflare Turnstile secret

# For local dev, put the same keys in .dev.vars (gitignored):
#   SESSION_HMAC=...
#   BSKY_CLIENT_SECRET=...
#   TG_BOT_TOKEN=...
#   TURNSTILE_SECRET=...
```

## Dashboard-side configuration

These are configured outside `wrangler.toml`:

- **Cloudflare Rate Limiting Rule** — slug-global backstop on
  `/api/r/*/unlock`, e.g. 200 requests/hour per URL path. Free tier covers it.
- **Turnstile site** — create one and put the site key in `[vars]` and the
  secret in `wrangler secret put TURNSTILE_SECRET`.
- **Custom domain / route** — bind the worker to your zone.

## Scripts

- `pnpm dev` — local Wrangler dev server
- `pnpm test` — Vitest (Miniflare pool)
- `pnpm typecheck` — TypeScript check, no emit
- `pnpm db:migrate:local` / `db:migrate:remote` — apply D1 migrations
