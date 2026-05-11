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
pnpm run keygen:bsky -- --jwks | pnpm wrangler secret put BSKY_PRIVATE_JWKS
pnpm wrangler secret put TG_BOT_TOKEN        # Telegram bot token
pnpm wrangler secret put TURNSTILE_SECRET    # Cloudflare Turnstile secret

# For local dev, put the same keys in .dev.vars (gitignored):
#   SESSION_HMAC=...
#   BSKY_PRIVATE_JWKS=...    # JSON array from `pnpm run keygen:bsky -- --jwks`
#   TG_BOT_TOKEN=...
#   TURNSTILE_SECRET=...
```

The matching public JWKs are derived from `BSKY_PRIVATE_JWKS` at request
time and served at `/api/auth/bsky/jwks.json`.

### Rotating the BSky signing key

1. Mint the new key as a single-element array:
   `pnpm run keygen:bsky -- --jwks`
2. Read the current secret, prepend the new key, and put back:
   ```bash
   OLD=$(wrangler secret list --json | jq -r '...')   # or pull from your safe
   NEW=$(pnpm run keygen:bsky -- --jwks)
   echo "$(jq -s '.[0] + .[1]' <(echo "$NEW") <(echo "$OLD"))" \
     | pnpm wrangler secret put BSKY_PRIVATE_JWKS
   ```
   The first key in the array signs new tokens; both publish on /jwks.json.
3. Wait ~24h (ATProto refresh tokens are single-use and rotate per call;
   JWKS cache is short — 24h is conservative).
4. Drop the old key and re-put the secret. Done.

The legacy single-key secret name `BSKY_PRIVATE_JWK` is still accepted for
backwards compat; the loader wraps it into a 1-element array.

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
- `pnpm keygen:bsky` — print a fresh ES256 private JWK (for `BSKY_PRIVATE_JWK`)

## Deploy

Push to `main` — `.github/workflows/deploy-worker.yml` deploys on changes
under `apps/worker/**` or `packages/shared/**`. Don't run `wrangler deploy`
locally; that drifts the live Worker from `origin/main`.
