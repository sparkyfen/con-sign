# con-sign — Fursona Room Sign

## Context

You're building an e-ink "door sign" for a hotel room at furry conventions. The
sign shows your roommates' fursonas, names, handles, and rough whereabouts at
the con. Random passersby see a sanitized view; people who scan the QR and
enter a passcode see more detail; admins manage everything from a web UI.

The application doesn't exist yet — this plan is greenfield and covers stack
choice, data model, auth, privacy tiers, and a v1/stretch breakdown.

**Decisions already locked in (from clarifying Qs):**

- **Frontend:** SvelteKit 2 + Svelte 5 on Cloudflare Pages
  (`@sveltejs/adapter-cloudflare`); Pencil.dev sources the visual design.
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
- **E-ink device auth:** firmware-generated UUID is the bearer; admin
  bootstraps via a 6-char OTP shown on the panel (see "Device pair-code
  bootstrap" below).
- **E-ink hardware:** first target is TRMNL (7.5", 800×480, ESP32-based).
  See `docs/devices/` for per-device plans. The render pipeline stays
  hardware-agnostic — device adapters live in
  `apps/worker/src/routes/devices/<name>.ts`, not inside `routes/device.ts`.
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
│  SvelteKit   │ ◀───────────────▶ │  Cloudflare Worker │
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
  endpoint. SvelteKit frontend deploys to Cloudflare Pages and calls the
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
room           (id, con_id, name, qr_slug, created_at)

-- Device pairing: each panel is a first-class row keyed by the persistent
-- UUID the firmware generates on first boot. Unpaired state lives in KV
-- (rotating 6-char OTP code, 5-min TTL); D1 only sees a device once an
-- admin claims its code.
device         (id /* device UUID */, room_id /* nullable */,
                paired_at, revoked_at, last_seen_at, created_at)

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
- **`device`** rows are inserted only when an admin claims a panel's pair
  code. Unpaired state is *transient* and lives entirely in KV — no D1 row
  exists for a panel that's never been claimed. Multiple devices per room
  are first-class.
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

### Device pair-code bootstrap

- Each panel generates a stable UUID (`device_id`) on first boot and persists
  it in flash. That UUID is the bearer token forever — there is no separate
  device-token registration step.
- Panel polls `GET /api/device/sign.png` with `Authorization: Bearer <device_id>`.
  Server dispatches on the matching `device` row:
  - **No row** → render unpaired panel showing a rotating 6-char OTP code.
    The code is random (not derived) and lives in KV under `pair:code:<CODE>`
    (→ device_id) and `pair:dev:<device_id>` (→ code), 5-min TTL on both.
  - **Row with `room_id`** → render the room sign (existing guest-tier
    projection — the device sees what a passer-by sees).
  - **Row with `revoked_at`** → render "panel unpaired" notice.
- Admin pairs by typing the 6-char code at `cons.social/pair`, which POSTs
  to `/api/rooms/:id/devices/claim`. Server reverse-resolves the code to
  `device_id` (atomic via `kv.delete`), inserts the `device` row, panel sees
  paired sign on next poll.
- Revoke: admin DELETE on `/api/rooms/:id/devices/:device_id` sets
  `revoked_at`. Re-pair: clears `revoked_at` on the same row, panel goes
  back through the unpaired flow on next poll.

---

## API Surface (sketch)

```
# Auth
GET    /api/auth/bsky/start?handle=…  → 302 to BSky OAuth
GET    /api/auth/bsky/callback        → consume code; set cs_session; 302 /
GET    /api/auth/bsky/client-metadata.json
GET    /api/auth/bsky/jwks.json
POST   /api/auth/telegram/callback    (TG Login Widget HMAC verify)
GET    /api/auth/me                   → { userId, displayName, identities[] }
POST   /api/auth/logout               (revokes jti via SESSIONS KV)

# Visitor
GET    /api/r/:slug                   → room view, projected per current cookie's
                                        unlocked roommate_ids (or guest-only)
POST   /api/r/:slug/unlock            → { unlocked_roommate_ids[] }

# Cons (read-only; ICS-synced)
GET    /api/cons?q=...                → typeahead search

# Avatars
GET    /api/avatar/tg/:tgUserId       (Bot API stream-proxy)

# Rooms (logged in)
GET    /api/rooms                     → { rooms[] } caller's memberships
POST   /api/rooms                     (body: conId, name) creates room + admin
GET    /api/rooms/:id                 → { room, con, myRole }
PATCH  /api/rooms/:id                 (name)
GET    /api/rooms/:id/membership      → { members[], isOnlyAdmin }
GET    /api/rooms/:id/qr.png          (admin-only; SVG, content-type image/svg+xml)
POST   /api/rooms/:id/invite          → { inviteUrl, expiresAt }
POST   /api/rooms/join                (body: { token } from invite link)

# Roommates
GET    /api/rooms/:id/roommates/:rid              (self or admin; full row)
PATCH  /api/rooms/:id/roommates/:rid              (self only; profile, status)
DELETE /api/rooms/:id/roommates/:rid              (admin only, or self; last-admin guard)
GET    /api/rooms/:id/roommates/:rid/visibility   (self only)
PUT    /api/rooms/:id/roommates/:rid/visibility   (self only)
POST   /api/rooms/:id/roommates/:rid/passcode     (self only; rotates, returns once)

# Audit
GET    /api/rooms/:id/audit            (member-readable; room's history)
GET    /api/me/audit                   (caller's actions across all rooms)

# Devices
POST   /api/rooms/:id/devices/claim   (admin enters 6-char OTP)
GET    /api/rooms/:id/devices         → { devices[] }
DELETE /api/rooms/:id/devices/:devId  (admin only; sets revoked_at)
GET    /api/device/sign.png           (bearer = device UUID; unpaired/paired/revoked)

# Stretch (stubbed)
POST   /api/parties
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

**Stretch — multi-room / multi-con UX (selected from 2026-05-16 brainstorm):**

- **Roommate-to-roommate notes.** Shared in-room scratchpad visible
  only to logged-in roommates of the room — never to visitors, never
  on the panel. Mock: `J2aSJY "Screen / Room Notes"`.
  - **Shape**: two surfaces. (a) One *pinned blob* per room
    (wiki-style, last-edit-wins) for evergreen info — Wi-Fi
    password, allergies, hotel breakfast. (b) A *feed of transient
    entries* below for moment-to-moment notes ("out for tea",
    "left key on counter").
  - **Schema**: `room.pinned_note TEXT` column for the blob (≤1 KB)
    + `room.pinned_note_updated_by_user_id` + `room.pinned_note_updated_at`
    for the "Last edited by X · Yh ago" footer. New
    `room_note (id, room_id, author_user_id, body ≤280, created_at)`
    table for the feed. Feed capped at 50 entries per room, oldest
    TTLs out on insert.
  - **Access**: reads + writes gated by `requireRoommate`. Authors
    can delete their own feed entries; admins can delete any. Both
    actions live behind a ⋯ (ellipsis-vertical) menu on each feed
    row, not a bare trash icon — keeps the default state clean.
    Pinned blob: any roommate can edit; last-edit-wins.
  - **Notifications**: new feed entries optionally fire a Telegram
    DM to each other roommate, **per-source-roommate granularity**
    (each recipient picks which specific roommates' posts they want
    pinged on). Pinned-note edits do NOT fire DMs — the pinned
    blob is high-edit-rate scratchpad and pinging on every tweak
    would be noisy. If someone makes a meaningful pinned change,
    convention is to drop a feed entry saying "updated the pin."
  - **Notification opt-ins live on the Notes page itself**
    (in-context), not on a global Notifications Settings screen.
    The underlying `notification_pref` table is still shared with
    the broader Admin-Notifications work, but this is one of the
    panels the user touches the toggles through. Schema keys on
    `(recipient_user_id, room_id, kind='room_note', source_roommate_id)`
    so a row exists per (me, room, other-roommate) pair.
  - **New-roommate default**: when a new roommate joins, they
    appear in everyone else's notification list with the toggle
    defaulted **OFF**. Opt-in design avoids surprising existing
    roommates with pings from a stranger; the toggle row is
    visible enough that people will flip it on if they want it.
  - **Ship scope**: Notes storage + UI ships **first**; the
    notification toggles render and persist `notification_pref`
    rows, but the DM pipe doesn't fire until the broader
    Admin-Notifications cron lands. Decouples a straightforward
    CRUD feature from Telegram bot plumbing.
  - **Surface placement** in the dashboard: dedicated `Notes` nav
    tab in the sidebar, matching the mock.
- **Room template.** Per-admin reusable bundle. Unlimited
  templates per admin; private only (no cross-admin sharing in
  v1).
  - **What it captures**: room name pattern, invitee handle list
    (BSky/Telegram), per-field visibility defaults, and a
    "use con-local timezone" hint that picks up the destination
    con's `con.timezone` at instantiation. **Does NOT snapshot
    invitee profiles** — at instantiation, each invitee's fursona
    / species / pronouns / avatar are pulled from their latest
    identity + roommate row via the **Carry-over profile** flow
    below. This means a template stays fresh as people's profiles
    evolve.
  - **Schema**: new `room_template (id, owner_user_id, name_pattern,
    contents_json, created_at, updated_at)` table where
    `contents_json` carries `{ invitees: [{handle, provider}],
    visibility_defaults: {...} }`. Normalize later if querying
    individual invitees becomes a hot path.
  - **Instantiation flow**: admin picks a con → server creates the
    room + stages each invite in a **pending** state on a new
    `pending_invite` table → admin reviews on a "send invites"
    screen and fires them off (one-by-one or bulk). Lets the admin
    drop people who aren't coming this year before sending.
  - **Stale invitee handling**: if any handle on the template no
    longer resolves to a user at instantiation, the operation
    **hard-fails** with a list of broken handles. Admin must edit
    the template (or accept the drops by removing them) before
    retrying. Strictness here avoids silent surprise drop-outs.
  - Composes with **Carry-over profile** below: template knows
    *who*, carry-over knows *what each person looks like*.
- **Carry-over profile.** Per-USER, not per-room. When a user
  joins any new room, the roommate row pre-populates from their
  *most recent* prior roommate row (by `created_at`, regardless
  of which con).
  - **Trigger**: implicit. Always copies; the user can edit
    afterwards. Matches the existing `bsky_handle` /
    `telegram_handle` auto-populate from migration 0006.
  - **Fields carried**: `fursona_name`, `fursona_species`,
    `pronouns`, status presets (custom labels the user defined),
    per-field visibility defaults, avatar URL choice (which
    identity's avatar to render).
  - **Schema**: no new tables. Extend `addRoommate` and
    `createRoomWithAdmin` to look up the most recent prior
    `roommate` row by `user_id` and copy the listed columns.
    Identity-derived fields (handles) continue to be set from
    `identity.handle` as today.
  - **No source backref**: the new row doesn't remember which
    prior room it copied from. If we ever want a "reset to
    last profile" affordance, that's a separate query against
    `roommate` ordered by `created_at`.
  - Distinct from room template above: template knows the
    invitees; carry-over knows what each invitee's profile
    looks like at the moment they join.
- **Admin notifications.** Per-room alerts to the admin
  (per-room, not per-admin — an admin who owns multiple rooms
  configures each independently). Delivery via **Telegram bot
  DM** at v1; email lands later when we add an SMTP provider.
  - **Default rule set** (all on by default for every new room):
    1. **Panel offline > 2 h** during the con window
       (`last_seen_at` stale).
    2. **Panel battery < 15%**.
    3. **Roommate stale status > 24 h** during the con window.
    4. **Repeated failed claim attempts** on this room's
       pair-code (>5 in 10 min).
  - **Con window** = strictly `con.start_date` to `con.end_date`
    in `con.timezone`. Outside the window the rules go silent.
    Matches the existing refresh-rate cadence logic.
  - **Quiet hours**: default **OFF**. Admin opts in if they want
    night-time quieting. Critical alerts (offline/battery/
    security) still go out 24/7 within the con window.
  - **Schema**: new `notification_pref (id, room_id,
    actor_user_id, kind, enabled, threshold_json, quiet_start,
    quiet_end, created_at, updated_at)` and `notification_log
    (id, pref_id, fired_at, payload_json, delivery_status)`.
  - **Cron cadence**: when the daily ICS cron fires, also check
    rooms whose con is currently in-window and queue alerts. For
    sub-day responsiveness during the con, add a second cron at
    10-min cadence that only iterates rooms with an in-window
    con (cheap query). Falls silent outside con windows.
  - **Channel infra**: existing `TG_BOT_TOKEN` + Bot API used to
    fetch avatars works for `sendMessage` too. Each admin links
    their Telegram identity via the existing login flow before
    they can receive DMs.
- **Virtual guest book.** After a visitor unlocks a roommate's
  card via passcode, they're offered a "sign the guest book"
  prompt.
  - **Identity required to sign.** Visitors must be logged in via
    BSky or Telegram before they can leave a message. **No
    plaintext-handle anonymous entries** — the identity gate
    keeps profanity / spam / impersonation off the wall by
    making every signer accountable through their provider
    identity. Anonymous-but-read access is still fine: any
    passcode-unlocked visitor can *read* the guest book; only
    logged-in visitors can *write*.
  - **UX entry path for un-logged-in visitors**: after unlock,
    show a "log in to sign" CTA that routes through the existing
    BSky/Telegram login with a return-URL back to this room's
    unlocked view. The login flow currently redirects to `/` —
    needs to grow a `?return=` param on `/api/auth/bsky/start`
    and `/api/auth/telegram` before this lands.
  - **Visibility**: per-room private to roommates. Entries scoped
    to the room they were signed in; never visible to other
    visitors, never visible across rooms. Each roommate's card
    accumulates its own entries.
  - **Moderation**: each roommate can hide / delete entries on
    their own card (the signer left it for them, so it's theirs
    to keep or drop). Admins can delete any entry in any room
    they own. Audit log records `guest_book.entry_deleted` with
    the deleted entry's handle + body in metadata.
  - **Panel surface**: none. Guest book lives only in the
    dashboard. No count, no last-visitor name on the e-ink.
  - **Schema**: new `guest_book_entry (id, room_id,
    roommate_id, signer_identity_id, body ≤280, created_at,
    deleted_at NULL, deleted_by_user_id NULL)`. Soft-delete
    rather than hard-delete so we keep the moderation audit
    trail. The `signer_identity_id` is FK to `identity`, so
    we resolve handle + provider at read time and pick up
    any handle changes for free.
  - **Rate limit**: same per-visitor-cookie bucket as unlock
    attempts (`UNLOCK_RL`). Logged-in signers add their session
    `userId` as an additional dimension so a single user
    spamming across rooms also gets capped.

**Code-quality follow-ups (from simplification reviews):**

- **N+1 roommate projection** — `routes/visitor.ts` + `routes/device.ts`
  both loop `Promise.all(rows.map(getVisibility + projectRoommate))`.
  Extract `listProjectedRoommates(db, roomId, unlockedIds)` and fold
  `field_visibility` into the same query via LEFT JOIN. Eliminates the
  per-roommate round-trip on every panel render and every visitor view.
- **Drop the panel QR sidebar** in `apps/worker/src/render/sign.ts`. The
  current canonical e-ink mockup (`Screen / E-Ink Sign Render`, frame
  `TFPoI`) is full-bleed three-row, not the older sidebar variant.
  Removing it saves ~40 lines + the `qrcode` lib hit on every device
  poll + ~25% panel width.
- **Drop `turnstileRequired` from the visitor GET response** in
  `apps/worker/src/routes/visitor.ts`. The unlock-sheet learns about
  Turnstile from the 401 on `/unlock`; pre-fetching it on every
  pageview adds a KV read with no UI consumer.

**Testing infrastructure:**

- **Miniflare swap** in `apps/worker/test/doubles.ts` — replace the
  hand-rolled SQLite + Map stubs with workerd via Miniflare. Catches
  Workers-runtime bugs at PR time (the qrcode/canvas regression that
  reached prod is the canonical example). Unblocks BSky OAuth
  integration tests that need the real fetch shim.

---

## Project Layout

```
con-sign/
  apps/
    web/          # SvelteKit frontend → Cloudflare Pages
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
