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
- **Public access tiers:** **QR + per-roommate passcode**. Scanning the room QR
  drops you into the **guest** tier automatically (proof-of-presence at the
  door). Each roommate has their *own* passcode that unlocks that roommate's
  **personal** fields only — independently keyed, share-link + QR per roommate.
  Roommates who want zero visibility simply don't share their passcode.
  (Identity-bound ACLs via login are a future option.)
- **Location field:** predefined options + custom override, modeled as a typed
  status object so future panel/GPS data slots in without migration.
- **E-ink device auth:** per-device API token (bearer header).
- **E-ink hardware:** undecided (Seeed Studio board seen at dma.space). Plan
  treats the device as a dumb HTTP client that fetches a server-rendered PNG —
  works for ESP32, Pi, Inkplate, or a tablet kiosk.
- **Cons list:** populated from the public
  [furrycons.com ICS feed](https://furrycons.com/calendar/furrycons.ics) via a
  daily Cron Trigger Worker — users *pick* a con, never type one in.
- **Abuse protection:** Cloudflare-native (Workers Rate Limiting binding +
  Cloudflare Rate Limiting Rules + Turnstile). No hand-rolled KV counters and
  no IP-based blocking (hotel NAT would punish the whole room).

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
-- 'con' is sourced from the furrycons.com ICS feed (cron-synced); users pick.
con            (id, ics_uid, name, start_date, end_date,
                location, url, source_updated_at, created_at)
room           (id, con_id, name, qr_slug, device_token_hash, created_at)

-- Identity. A user can log in with BSky OR Telegram (or both, linked).
user           (id, display_name, created_at)
identity       (id, user_id, provider /* 'bsky' | 'telegram' */,
                provider_id, handle, avatar_url, raw_profile_json)

-- Membership: a user is a roommate of a room with a role.
-- Each roommate has their OWN passcode that unlocks their 'personal' fields.
roommate       (id, room_id, user_id, role /* 'admin' | 'member' */,
                passcode_hash, passcode_rotated_at,
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
                  min_tier /* 'guest'|'personal'|'private' */)

-- Stretch: parties hosted in the room.
party          (id, room_id, name, starts_at, ends_at,
                telegram_link, capacity, notes, created_at)
```

Notes:

- **Per-roommate passcodes** stored as argon2 hashes (Workers has wasm-argon2).
  Auto-generated on roommate creation (e.g. 8-char base32 — short enough to
  type, long enough to resist brute-force given Turnstile + RL). Rotatable by
  the roommate themselves or by admins; rotation invalidates old share links.
- **No room-level passcode.** Scanning the QR (`/r/{slug}`) puts you in guest
  tier automatically. The slug is the proof-of-presence.
- **`device_token_hash`**: hash of the bearer token. Token shown once at
  generation, never recoverable. Multiple tokens per room → upgrade to a
  separate `device` table only if needed.
- **`field_visibility`** keyed by string field name (not a column-per-field
  table) so adding fields later is just app code, not a migration.
- **`con`** rows are upserted by `ics_uid` from the daily ICS sync. We never
  insert cons by hand; if a con is missing, we wait for the feed (or trigger
  a manual re-sync from admin tools).

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

### Visitor access (no login)

- `GET /r/{slug}` → guest view. No passcode needed; scanning the door QR is the
  proof. Server returns the room with all fields projected at `guest` tier.
- `POST /api/r/{slug}/unlock { passcode }` → if the passcode matches *any*
  roommate in this room, returns a short-lived signed cookie naming the unlocked
  `roommate_id`(s). The cookie is additive — entering a second roommate's
  passcode unlocks them too. Server-side: argon2 verify against every roommate
  in the room (cheap; rooms have a handful of members).
- Share link format: `https://.../r/{slug}#k={passcode}` — frontend reads the
  fragment (never sent to server) and POSTs it to `/unlock` automatically. QR
  encoded for each roommate by admin/roommate UI.
- **Abuse protection (Cloudflare-native, no IP bans):**
  - Workers Rate Limiting binding: per-cookie counter (long-lived cookie set on
    first visit) — soft cap, e.g. 10 attempts / 10 min per cookie.
  - Cloudflare Rate Limiting Rule (zone-level): slug-global backstop, e.g.
    200 attempts/hour per `/api/r/:slug/unlock` path — well above any
    legitimate hotel-room load.
  - Cloudflare Turnstile challenge inserted on the unlock form after 3 failed
    attempts on a slug. Does not block; just adds friction.
  - No IP-based blocking. Hotel NAT means IP ≠ user.

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
GET    /api/r/:slug                   → room view, projected per current cookie's
                                        unlocked roommate_ids (or guest-only)
POST   /api/r/:slug/unlock            → { unlocked_roommate_ids[] }

# Cons (read-only; ICS-synced)
GET    /api/cons?q=...                → typeahead search

# Admin / roommate (logged in)
POST   /api/rooms                     (body: con_id, name) creates room + admin
POST   /api/rooms/:id/invite          → { invite_url }
POST   /api/rooms/:id/join            (accept invite)
GET    /api/rooms/:id
PATCH  /api/rooms/:id                 (name)
DELETE /api/rooms/:id/roommates/:rid  (admin only; or self)
PATCH  /api/roommates/:id             (own profile, status, fursona)
PUT    /api/roommates/:id/visibility  (per-field min_tier)
POST   /api/roommates/:id/passcode    → { passcode, share_url } (shown once,
                                        rotates the existing one)
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
2. **Pick a Con** from the typeahead (data from the daily ICS sync).
3. **Create Room** in that con (name auto-generates `qr_slug`).
4. Wizard offers **"Generate device token"** (shown once, copy to device later).
5. Admin fills out their own roommate profile + per-field visibility. A
   **personal passcode** is auto-generated; admin can copy the share link / QR
   to give to whoever they want to grant `personal` access.
6. Admin creates **invite links** for other roommates → they log in via the
   link, are auto-attached to the room as `member`, fill out their own
   profile, and get their *own* auto-generated personal passcode + share link
   + QR. Each roommate decides independently who gets it (or shares it with
   no-one).
7. Print the room QR (`/r/{slug}`) for the door — sign is live.

Admin post-setup: kick roommates, regenerate device token, manage parties
(stretch). Roommates (incl. admins): rotate own passcode, edit own profile,
edit own visibility.

---

## v1 Scope vs. Stretch

**v1 (in this plan):**

- Multi-con, multi-room data model.
- Daily ICS sync from furrycons.com (Cron Trigger Worker).
- BSky + Telegram login (admin/roommate only).
- QR-as-guest + per-roommate passcode visitor access (additive unlocks).
- Cloudflare-native abuse protection (RL binding + RL Rules + Turnstile).
- Roommate profile + per-field visibility (`guest` | `personal` | `private`).
- Auto-generated passcodes with share link + QR per roommate.
- Predefined-or-custom status with `status_updated_at`.
- Device PNG endpoint with bearer token.
- Setup wizard + admin/roommate edit flows.

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
- `apps/worker/src/routes/visitor.ts` — unlock endpoint + projected room view.
- `apps/worker/src/cron/ics-sync.ts` — daily fetch + parse of
  `furrycons.com/calendar/furrycons.ics`, upsert into `con` by `ics_uid`.
- `apps/web/` — setup wizard, admin dashboard, visitor view (3 main flows).
- `wrangler.toml` — D1 + KV bindings; secrets for BSky client, Telegram bot
  token, session HMAC key.

---

## Verification

End-to-end checks before calling v1 done:

1. **ICS sync:** Trigger the cron handler, confirm cons are upserted from the
   feed (idempotent on second run), search typeahead returns expected results.
2. **Setup:** Log in with BSky → pick con → create room → generate device
   token → fill profile → confirm personal passcode + share URL + QR returned
   on profile creation, shown once.
3. **Per-roommate unlock:** From an incognito window, scan QR (no passcode):
   only `guest` fields visible. Enter roommate A's passcode: A's `personal`
   fields unlock, B's stay hidden. Enter B's passcode in the same session:
   both A and B unlocked. `private` fields never appear in any state.
4. **Abuse protection:** Submit 4 wrong passcodes on the same slug → 4th
   request is gated by Turnstile. Blast 250 unlocks/hour at the slug → CF
   Rate Limiting Rule kicks in. Confirm a *different* cookie on the same IP
   is unaffected (no IP punishment).
5. **Visibility editor:** Toggle a field from `personal` to `guest`, refresh
   visitor view, confirm change reflected. Same shared `projectRoommate`
   called from both server filtering and admin UI preview (unit test asserts
   parity).
6. **Multi-roommate:** Admin invites a second user via Telegram → fills
   profile → gets own passcode + share link → admin removes them → confirm
   row gone, their unlock cookie no longer projects their fields.
7. **Passcode rotation:** Roommate rotates their passcode → old share URL no
   longer unlocks, new one does, existing unlock cookies for that roommate
   are invalidated.
8. **Device:** `curl -H "Authorization: Bearer …" .../api/device/sign.png` →
   PNG is 1-bit, panel-sized, shows the guest-tier projection (device sees
   what a passer-by sees — never personal data).
9. **Multi-tenancy:** Same admin creates a room in a different con, confirm
   isolation (no roommate leakage between rooms).
10. **Avatar proxy:** Telegram roommate's avatar loads via `/api/avatar/tg/:id`;
    no image bytes persisted in D1 or R2.

Tests to write alongside:

- Unit: `projectRoommate` for every (tier × field × visibility) combo,
  including additive unlocks across multiple roommate_ids.
- Unit: argon2 passcode hash + verify.
- Unit: ICS parser handles VEVENT recurrence, cancelled events, timezone-naive
  dates.
- Integration (Miniflare/Vitest): full unlock flow + rate-limit binding +
  Turnstile bypass token against a test D1.
