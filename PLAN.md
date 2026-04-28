# con-sign — Fursona Room Sign

## Context

You're building an e-ink "door sign" for a hotel room at furry conventions. The
sign shows your roommates' fursonas, names, handles, and rough whereabouts at
the con. Random passersby see a sanitized view; people who scan the QR and
enter a passcode see more detail; admins manage everything from a web UI.

The application doesn't exist yet — this plan is greenfield and covers stack
choice, data model, auth, privacy tiers, and a v1/stretch breakdown.

**Decisions already locked in (from clarifying Qs):**

- **Frontend:** Pencil.dev (TypeScript/React-flavored).
- **Backend runtime:** Cloudflare Workers (TypeScript). Same language end-to-end.
- **Database:** Cloudflare D1 (SQLite at the edge). Relational data fits naturally;
  KV/DO can be added later for sessions or live-status push.
- **Image hosting:** none. BlueSky avatars are public URLs (store URL only);
  Telegram avatars are stream-proxied through the Worker via Bot API.
- **Multi-room / multi-con:** required from day one. Affects schema below.
- **Login (admin/roommate only for v1):** BlueSky OAuth + Telegram Login Widget.
- **Public access tiers:** **passcode-only**. One passcode → guest; another → friend.
  No login required for visitors. (Identity-bound ACLs are a future option.)
- **Location field:** predefined options + custom override, modeled as a typed
  status object so future panel/GPS data slots in without migration.
- **E-ink device auth:** per-device API token (bearer header).
- **E-ink hardware:** undecided (Seeed Studio board seen at dma.space). Plan
  treats the device as a dumb HTTP client that fetches a server-rendered PNG —
  works for ESP32, Pi, Inkplate, or a tablet kiosk.

---

## Architecture

```
┌──────────────┐   BSky/TG OAuth   ┌────────────────────┐
│  Pencil.dev  │ ◀───────────────▶ │  Cloudflare Worker │
│  Web UI      │   /api/* (JSON)   │  (Hono router)     │
└──────────────┘                   │                    │
                                   │  ┌──────────────┐  │
┌──────────────┐  passcode + JSON  │  │   D1 (SQL)   │  │
│  QR visitor  │ ◀───────────────▶ │  └──────────────┘  │
└──────────────┘                   │  ┌──────────────┐  │
                                   │  │ KV (sessions)│  │
┌──────────────┐  bearer token     │  └──────────────┘  │
│  E-ink dev.  │ ─── GET /sign ──▶ │  PNG render        │
└──────────────┘   PNG (1bpp)      └────────────────────┘
```

- **One Worker** serves the API, the public visitor JSON, and the device PNG
  endpoint. Pencil.dev frontend deploys to Cloudflare Pages and calls the
  Worker. (Pages + Worker can share a project; same domain, no CORS.)
- **D1** holds all relational state.
- **KV** (optional, low-cost) holds session tokens and short-lived passcode
  rate-limit counters.
- **No R2** in v1 (no image storage).

### Image rendering for the e-ink

Render server-side in the Worker using `@cloudflare/workers-types` +
[`satori`](https://github.com/vercel/satori) (HTML/JSX → SVG) + a tiny SVG→PNG
step (e.g., `resvg-wasm`). The device just GETs `/api/device/sign.png` with its
bearer token; the Worker emits a 1-bit PNG sized to the panel. This is
hardware-agnostic — when you pick the Seeed Studio board, the only device-side
code is "fetch PNG, push to panel."

---

## Data Model (D1)

```sql
-- Tenancy: a Con is a top-level scope; Rooms belong to a Con.
con            (id, name, start_date, end_date, created_at)
room           (id, con_id, name, qr_slug, guest_passcode_hash,
                friend_passcode_hash, device_token_hash, created_at)

-- Identity. A user can log in with BSky OR Telegram (or both, linked).
user           (id, display_name, created_at)
identity       (id, user_id, provider /* 'bsky' | 'telegram' */,
                provider_id, handle, avatar_url, raw_profile_json)

-- Membership: a user is a roommate of a room with a role.
roommate       (id, room_id, user_id, role /* 'admin' | 'member' */,
                fursona_name, fursona_species, pronouns,
                bsky_handle, telegram_handle,
                status_kind /* 'preset' | 'custom' */,
                status_preset /* 'room'|'lobby'|'dealers'|'panels'|'out'|'asleep' */,
                status_custom_text, status_updated_at,
                created_at)

-- Per-roommate, per-field visibility. Field name is a string key
-- ('fursona_species', 'pronouns', 'bsky_handle', 'status', ...).
-- Tier is the minimum tier that can see it.
field_visibility (id, roommate_id, field_name,
                  min_tier /* 'guest'|'friend'|'private' */)

-- Stretch: parties hosted in the room.
party          (id, room_id, name, starts_at, ends_at,
                telegram_link, capacity, notes, created_at)
```

Notes:

- **Passcodes** stored as `bcrypt`/`argon2` hashes (Workers has wasm-argon2).
  Two per room: guest + friend. Rotatable by admin.
- **`device_token_hash`**: hash of the bearer token. Token shown once at
  generation, never recoverable. Multiple tokens per room → upgrade to a
  separate `device` table only if needed.
- **`field_visibility`** keyed by string field name (not a column-per-field
  table) so adding fields later is just app code, not a migration.
- **`qr_slug`**: short random string in the QR URL (`/r/{slug}`). Knowing the
  slug alone gets you the guest tier login screen, not data.

---

## Auth Flows

### Admin / roommate login (BlueSky + Telegram)

- **BlueSky:** AT Protocol OAuth (the official `@atproto/oauth-client` flow,
  Worker-compatible). Store `did` as `identity.provider_id`, handle, and avatar
  URL from the profile fetch.
- **Telegram:** Telegram Login Widget on the frontend posts a signed payload to
  `/api/auth/telegram/callback`; Worker verifies the HMAC against the bot
  token. Avatar fetched lazily via `getUserProfilePhotos` + `getFile` and
  stream-proxied through the Worker on demand (`/api/avatar/tg/{user_id}`).
- Session = signed JWT cookie (HMAC, Worker secret), 30-day expiry. KV used
  only to support hard-revocation.

### Visitor passcode (no login)

- `POST /api/r/{slug}/auth { passcode }` → returns a short-lived signed
  `tier=guest|friend` token cookie. Constant-time compare against both stored
  hashes. Aggressive rate-limiting per slug+IP via KV counters.
- Passcodes are room-scoped, not con-scoped.

### Device

- Header: `Authorization: Bearer <token>`. Token tied to a single room.
- Endpoint returns `image/png` (or `image/bmp` if the panel needs it).

---

## API Surface (sketch)

```
# Auth
POST   /api/auth/bsky/start           → redirect to BSky OAuth
GET    /api/auth/bsky/callback
POST   /api/auth/telegram/callback
POST   /api/auth/logout

# Visitor
POST   /api/r/:slug/auth              → { tier }
GET    /api/r/:slug                   → room view filtered by tier

# Admin / roommate (logged in)
POST   /api/cons                      (creates con + first room + makes user admin)
POST   /api/cons/:id/rooms
GET    /api/rooms/:id
PATCH  /api/rooms/:id                 (name, passcodes)
POST   /api/rooms/:id/invite          → { invite_url }
POST   /api/rooms/:id/join            (accept invite)
DELETE /api/rooms/:id/roommates/:rid  (admin only; or self)
PATCH  /api/roommates/:id             (own profile, status, fursona)
PUT    /api/roommates/:id/visibility  (per-field min_tier)
POST   /api/rooms/:id/device-token    → { token } (shown once)

# Device
GET    /api/device/sign.png           (bearer)

# Stretch
POST   /api/rooms/:id/parties
PATCH  /api/parties/:id
DELETE /api/parties/:id
```

---

## Setup Workflow (first-run UX)

1. User logs in (BSky or Telegram) → lands on empty dashboard.
2. **Create Con** (name + dates). User becomes admin of this con.
3. **Create Room** in that con (name auto-generates `qr_slug`).
4. Wizard prompts for **guest passcode** and **friend passcode**.
5. Wizard offers **"Generate device token"** (shown once, copy to device later).
6. Admin fills out their own roommate profile + per-field visibility.
7. Admin creates **invite links** for other roommates → they log in via the
   link, are auto-attached to the room as `member`, fill out their own
   profile.
8. Print the QR (`/r/{slug}`) — sign is live.

Admin post-setup: edit roommates (kick), rotate passcodes, regenerate device
token, edit own visibility, manage parties (stretch).

---

## v1 Scope vs. Stretch

**v1 (in this plan):**

- Multi-con, multi-room data model.
- BSky + Telegram login.
- Two-tier passcode visitor access.
- Roommate profile + per-field visibility.
- Predefined-or-custom status with `status_updated_at`.
- Device PNG endpoint with bearer token.
- Setup wizard + admin edit flows.

**Stretch (deferred, schema-ready):**

- Parties (`party` table is in the schema; UI/API gated behind a feature flag).
- Con panel schedule integrations (per-con adapters; status field is already
  typed to absorb a `panel_id` later).
- GPS live location (`status_kind = 'gps'` future variant).
- Telegram bot (Worker already speaks to Bot API for avatars; webhook handler
  is a small additive change).
- Identity-tied ACLs (replace/augment passcode tier with allowlists keyed off
  `identity`).

---

## Project Layout

```
con-sign/
  apps/
    web/          # Pencil.dev frontend → Cloudflare Pages
    worker/       # Hono app → Cloudflare Worker
      src/
        index.ts
        routes/{auth,rooms,visitor,device,parties}.ts
        render/{sign.tsx, png.ts}      # satori + resvg-wasm
        db/{schema.sql, migrations/, queries.ts}
        auth/{bsky.ts, telegram.ts, session.ts}
        privacy.ts                     # tier + field projection
  packages/
    shared/       # zod schemas + TS types shared between web and worker
  wrangler.toml   # D1, KV, secrets bindings
  package.json    # pnpm workspace
```

Key shared module: `packages/shared/privacy.ts` exports the field-projection
function — single source of truth used by both the visitor API (server-side
filtering) and the admin UI (to preview "what will guests see?").

---

## Critical Files to Create

- `apps/worker/src/db/schema.sql` — the schema above.
- `apps/worker/src/privacy.ts` — `projectRoommate(roommate, tier, visibility)`.
- `apps/worker/src/auth/bsky.ts` — AT Protocol OAuth client wiring.
- `apps/worker/src/auth/telegram.ts` — login-widget HMAC verify + avatar proxy.
- `apps/worker/src/render/sign.tsx` — JSX layout for the e-ink panel (1-bit
  friendly: high-contrast, no gradients, large type).
- `apps/worker/src/routes/visitor.ts` — passcode auth + projected room view.
- `apps/web/` — setup wizard, admin dashboard, visitor view (3 main flows).
- `wrangler.toml` — D1 + KV bindings; secrets for BSky client, Telegram bot
  token, session HMAC key.

---

## Verification

End-to-end checks before calling v1 done:

1. **Setup:** Log in with BSky → create con → create room → set passcodes →
   generate device token → fill profile → verify QR URL renders guest view.
2. **Tiers:** From an incognito window, scan QR, enter wrong passcode (rate
   limited after N tries), enter guest passcode (see only guest fields), enter
   friend passcode (see friend fields), confirm `private` fields never appear.
3. **Visibility editor:** Toggle a field from `friend` to `guest`, refresh
   visitor view, confirm change is reflected and the same field-projection
   logic was applied (call shared `projectRoommate` from both contexts in a
   unit test).
4. **Multi-roommate:** Admin invites a second user → second user logs in via
   Telegram → fills profile → admin removes them → confirm row gone and their
   data no longer in visitor view.
5. **Device:** `curl -H "Authorization: Bearer …" .../api/device/sign.png` →
   open PNG, verify it's 1-bit, sized for a target panel, and shows the
   guest-tier projection (the device sees the same as a passer-by).
6. **Multi-tenancy:** Create a second con + room with the same admin, confirm
   isolation (no leakage of roommates between rooms).
7. **Avatar proxy:** Telegram-only roommate's avatar loads via
   `/api/avatar/tg/:id`; no image bytes are persisted in D1 or R2.

Tests to write alongside:

- Unit: `projectRoommate` for every (tier × field × visibility) combo.
- Unit: passcode hash + constant-time compare.
- Integration (Miniflare/Vitest): full visitor flow against a test D1.
