# con-sign

E-ink "door sign" for hotel rooms at furry conventions. Roommates show their
fursonas, handles, and rough whereabouts; passersby see a sanitized view; QR +
per-roommate passcode unlocks more.

Production: **[cons.social](https://cons.social)**.

## Stack

- **Frontend** — Pencil.dev (Cloudflare Pages, owns the apex).
- **Backend** — Cloudflare Worker (Hono, TypeScript), routed at
  `cons.social/api/*`.
- **Database** — Cloudflare D1 (SQLite at the edge).
- **Sessions** — Cloudflare KV (for revocation).
- **Rate limiting** — Workers Rate Limiting binding + Cloudflare zone rule +
  Turnstile after repeated failures. No IP-based blocking (hotel NAT).
- **E-ink device** — dumb HTTP client, fetches a server-rendered image with a
  bearer token. Hardware-agnostic.
- **Cons list** — daily cron sync of the
  [furrycons.com](https://furrycons.com/calendar/furrycons.ics) ICS feed.

## Repo layout

```
apps/
  worker/        Cloudflare Worker — API, visitor flow, device sign render,
                 ICS cron. See apps/worker/README.md for setup.
  web/           Pencil.dev frontend (placeholder; toolchain TBD).
packages/
  shared/        Zod schemas + the privacy projection (projectRoommate).
                 The contract the UI imports.
docs/
  mockups/       Pencil.dev .pen files (open via the Pencil app + MCP).
PLAN.md          Canonical design doc — schema, auth, API surface, scope.
                 Read this before re-deriving any architectural decision.
```

## Screens

Mockups live in `docs/mockups/pencil-new.pen` (open via the Pencil app). The
design system frame defines a monochrome ink-on-paper palette shared between
the e-ink panel and the web UI.

- **E-Ink panel (800×480)** — Sign Render, Unpaired (shows pairing code), Token
  Revoked.
- **Visitor (mobile)** — Locked list, Passcode Sheet, Unlocked detail.
- **Login** — Desktop and Mobile, each with a BSky-disabled launch variant
  (Telegram-only until BSky OAuth lands).
- **Setup Wizard** — Pick a Con → Name Room → Invite Roommates → All Set.
- **Admin** — Dashboard, Roommate Editor (Desktop + Mobile), Device Pairing
  flow, Paired Devices settings.

## Privacy tiers

Each field on a roommate has a minimum tier required to see it:

- **guest** — anyone who scanned the room QR (proof-of-presence at the door).
- **personal** — entered that roommate's per-roommate passcode.
- **private** — admin / the roommate themselves. Default for new fields.

Unlocks are additive across roommates and rotation-aware (rotating a passcode
invalidates only that roommate's unlock).

## Develop

```bash
pnpm install
pnpm -r test          # 54+ tests, Miniflare pool
pnpm -r typecheck
pnpm -r build
```

Per-package scripts:

- `apps/worker` — `pnpm --filter @con-sign/worker dev` (Wrangler local).
  Setup, secrets, and D1/KV provisioning live in
  [`apps/worker/README.md`](apps/worker/README.md).
- `apps/web` — placeholder; Pencil.dev export lands here.
- `packages/shared` — pure TS, no build step (consumed via workspace `main`).

## Deployment

- Worker deploys via the GitHub Actions workflow under `.github/`.
- Pages project `con-sign` owns the apex; the Worker is bound to
  `cons.social/api/*` (see `apps/worker/wrangler.toml`).

## Status

Backend is end-to-end working: BlueSky + Telegram login, per-roommate
passcodes, room/roommate CRUD, visitor unlock + cookie projection, device
endpoint, daily ICS sync. Deferred: PNG (vs. SVG) device render — only
matters once e-ink hardware is picked. Next vertical slice: pair-code
device bootstrap (mockups exist, no backend yet). See `PLAN.md` and
`git log` for the latest.
