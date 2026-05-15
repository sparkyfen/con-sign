# PLAN — TRMNL

Status: **Mode B implemented and hardware-verified on a real 7.5" TRMNL.**
For step-by-step bring-up, see [`SETUP.md`](./SETUP.md).
Hardware: 7.5" TRMNL, ESP32-based, 800×480 e-ink, Wi-Fi, battery-powered.
Polls an HTTPS URL on a configurable interval. See
[`../protocol.md`](../protocol.md) for the device-agnostic contract that
sits underneath this adapter.

## Goal

Get a real TRMNL displaying a real con-sign room view, end to end:
unpaired panel shows the 6-char OTP, admin claims it from the
dashboard, the device's next poll shows the paired room sign.

## Two integration modes

TRMNL supports two ways for our backend to feed it images. Both are
viable; the plan covers both because we want to prototype quickly via
A and then settle on B.

### Mode A — Private plugin (TRMNL cloud in the path)

```
┌────────┐   poll    ┌──────────────┐   GET    ┌────────────┐
│ TRMNL  │ ────────▶ │ TRMNL cloud  │ ───────▶ │ cons.social│
│ device │           │              │          │ /api/...   │
└────────┘ ◀──────── └──────────────┘ ◀─────── └────────────┘
            image          fetched
```

- Admin creates a TRMNL account, configures a "private plugin" with
  a custom URL pointing at our server, sets a refresh interval.
- TRMNL cloud polls our URL on schedule, fetches the image, ships it
  to the device.
- **Auth lives in the URL**: TRMNL cloud has no header support per
  plugin URL, so the device identity has to be embedded in the
  URL itself (e.g. `cons.social/api/device/sign.png?d=<key>`).
- **Our pair-code flow becomes mostly redundant** — TRMNL's account
  + plugin URL already does the "this is my device" plumbing on
  their side. We'd still display the unpaired OTP for cosmetic
  consistency but it doesn't gate anything.
- Effort: ~1 day. The only backend change is the image-format swap
  (#16) — TRMNL expects PNG or 1-bit BMP, not SVG.

### Mode B — BYOS (Bring Your Own Server)

```
┌────────┐   poll    ┌──────────────┐
│ TRMNL  │ ────────▶ │ cons.social  │
│ device │           │ /api/trmnl/* │
└────────┘ ◀──────── └──────────────┘
            image + JSON envelope
```

- Device polls **our** server directly. No TRMNL cloud between us
  and the device.
- We implement TRMNL's device protocol on a small set of new
  endpoints (next section).
- **Pair-code flow works as designed**: device's first contact
  creates an unpaired row, server returns the OTP image, admin
  claims via dashboard, next poll returns the paired sign.
- Real per-device telemetry (battery, signal, firmware) lands in
  our `device` table.
- Server-controlled refresh interval saves battery (e.g. 5min during
  con, 1h off-hours).
- Effort: ~3 days.

### Recommendation

**Plan for B**, but A is fine as a smoke test if we want pixels on
the screen sooner. The bullet points below describe B unless they
explicitly say otherwise; the few Mode-A-specific notes are flagged.

## TRMNL's device protocol (the BYOS surface)

Four endpoints; con-sign owns each.

| Method + path | Purpose |
|---|---|
| `GET /api/trmnl/setup` | First boot. Device sends its MAC in a header. Server creates an unpaired `device` row keyed by a freshly-issued UUID, returns `{ api_key, friendly_id }`. The `api_key` is just the UUID — single identity throughout. |
| `GET /api/trmnl/display` | Hot loop. Device polls with `Access-Token: <api_key>`. Response: `{ image_url, refresh_rate, filename, reset_firmware?, update_firmware?, special_function? }`. The `image_url` points at our existing `/api/device/sign.png` (now serving PNG/BMP), with the api_key embedded for auth. |
| `POST /api/trmnl/log` | Telemetry: battery, runtime errors, button presses. Optional; stash last 1 KB per device, drop on re-claim. |
| Firmware OTA | Defer to TRMNL's hosted firmware URLs. We never host firmware bytes. |

## Auth model

- **`Access-Token`** header on the device's polls; value equals the
  `device.id` UUID we issued at setup. No separate key column.
- Setup itself: trust on first use. The device sends its MAC, we
  trust it (TRMNL hardware uniquely owns its MAC; this is the
  device's "I'm a TRMNL" credential). If the row already exists for
  that MAC, return the existing api_key — that's the re-pair path.
- **Pair-code claim** stays exactly as today: admin enters the
  6-char OTP shown on the panel, server `claimDevice`s the row,
  next display poll returns the paired sign.
- All TRMNL endpoints carve out of the CSRF Origin middleware
  (server-to-device, no browser). The auth is the `Access-Token`,
  full stop.

## Image format

**PNG render is live.** `GET /api/device/sign.png?fmt=png` rasterizes
the existing SVG output via `@resvg/resvg-wasm` and returns
`image/png`. Edge-cached for 60 s via `caches.default`. The SVG path
remains the default for Pi-class devices that want to rasterize
themselves.

Pipeline:

1. `renderSignSvg` stays the layout source of truth.
2. `apps/worker/src/render/raster.ts` calls `Resvg(svg, ...).render().asPng()`.
3. If TRMNL's firmware turns out to need 1-bit BMP1 instead of PNG,
   a ~20-line PNG → BMP1 encoder bolts on top of the same SVG. Verify
   firmware version against your TRMNL before doing this — newer
   builds accept PNG directly.

Both Mode A and Mode B use the same `?fmt=png` endpoint.

## Schema changes

One new column, one new migration:

```sql
-- 0004_device_mac.sql
ALTER TABLE device ADD COLUMN mac_address TEXT UNIQUE;
CREATE INDEX idx_device_mac ON device(mac_address);
```

Lets a factory-reset device re-pair to its existing row via MAC
match instead of orphaning audit history.

Nothing else changes. `device.id` stays the UUID; `device.room_id`,
`paired_at`, `revoked_at`, `last_seen_at`, `created_at` all retain
their current meaning. The new `mac_address` is nullable so non-
TRMNL devices (e.g. a Pi Zero) don't need to populate it.

## Refresh interval policy

Returned by `/display`. Conservative defaults:

| Window | Interval |
|---|---|
| Day of con (between `con.start_date` and `con.end_date`) | **5 min** |
| Pre-con or post-con, within ±7 days | **1 h** |
| Otherwise | **24 h** (effectively asleep) |

Tunable per device later. The server computes this from `con` data
the device's room is in, so it adapts to each room's schedule.

## File layout (for the eventual implementation)

```
apps/worker/src/
  routes/
    devices/
      trmnl.ts             # /api/trmnl/{setup,display,log}
  render/
    sign.ts                # existing SVG (unchanged)
    raster.ts              # SVG → PNG via resvg-wasm
    bmp1.ts                # PNG → 1-bit BMP (only if needed)
  trmnl/
    adapter.ts             # map device state → TRMNL display envelope
    refresh-policy.ts      # next-interval picker
```

Generic `/api/device/sign.png` keeps serving whatever format the
caller asks for via `Accept` (default SVG, `?fmt=png` or `?fmt=bmp`
overrides). TRMNL adapter picks the format that matches firmware.

## Setup steps (Mode B, deferred until code exists)

1. `wrangler secret put TRMNL_SETUP_PSK` — optional shared secret if
   we want to gate `/api/trmnl/setup` against random scanners. Open
   question; might be unnecessary if `/setup` only ever creates an
   unpaired row that admins still have to claim.
2. Deploy.
3. Flash TRMNL with a custom firmware build pointing at
   `https://cons.social/api/trmnl` as its server URL. (Or use
   whatever override TRMNL exposes for BYOS — check current docs.)
4. Boot the panel. `/setup` issues an api_key, `/display` returns the
   unpaired OTP image, admin claims via dashboard, next poll → paired.

## Setup steps (Mode A, smoke-test only)

1. Implement the PNG render in `apps/worker/src/render/raster.ts`.
2. Sign in to your TRMNL account. Create a private plugin with URL
   `https://cons.social/api/device/sign.png?d=<some-key>`. Refresh
   interval: 5–15 min.
3. Pair the device with the plugin via TRMNL's UI.
4. Watch the screen. Skip the rest of the BYOS plan unless we
   commit to B.

## Open decisions

- **PNG vs BMP1** — needs a real TRMNL to check firmware version.
  Default: assume PNG works; fall back to BMP1 only if it doesn't.
- **`/setup` rate-limit/auth** — open. Trust-on-first-use is fine
  for a personal project; if we ever ship publicly we'd want a
  per-IP RL binding on this endpoint at minimum.
- **`/log` retention** — last 1 KB per device, dropped on re-claim?
  Or fixed-size circular buffer in KV? Pick before writing the
  endpoint; both are cheap.
- **Friendly id** — TRMNL likes a human-readable id alongside the
  uuid. Easiest: `friendly_id = device.id.slice(0, 8).toUpperCase()`.

## Out of scope

- TRMNL's own OTA firmware delivery — we don't host firmware bytes;
  the device fetches them from TRMNL when our `display` response
  sets `update_firmware: true`.
- Button-press handlers / `special_function` — TRMNL has hardware
  buttons; mapping them to status changes is a future polish item.
- Group billing / multi-tenant TRMNL — if we ever support TRMNL
  fleet management for con organisers, that's a separate plan.

## What's done

### 2026-05-14 (initial Mode B landing)

- `0004_device_mac.sql` migration ✅
- PNG render via `@resvg/resvg-wasm` ✅
- `?fmt=png` flag + 60 s edge cache ✅
- `?d=<uuid>` bearer fallback (Mode A unblocker) ✅
- IBM Plex Mono bundled for resvg ✅
- Con name + day counter in the rendered sign ✅
- `apps/worker/src/trmnl/refresh-policy.ts` ✅
- `apps/worker/src/trmnl/adapter.ts` ✅
- `GET /api/trmnl/setup`, `GET /api/trmnl/display`, `POST /api/trmnl/log` ✅
- CSRF Origin carve-out for `/api/trmnl/*` ✅
- Integration tests covering setup, display (unpaired + paired), log,
  CSRF carve-out ✅
- Mode A smoke test against a hand-seeded room ✅

### Spec-compliance pass (after reading terminus/doc/api.adoc)

- `/display` now reads `ACCESS_TOKEN` (the actual spec header — was
  `Access-Token`, would have 401'd against real hardware) ✅
- `/display` falls back to `ID` (MAC) for identification when
  ACCESS_TOKEN is absent ✅
- `/log` uses `ID` (MAC) primary, `ACCESS_TOKEN` alternative ✅
- `/display` honors device-reported `WIDTH`/`HEIGHT` headers ✅
- Migration `0005_device_telemetry.sql` adds nullable
  `battery_voltage`, `percent_charged`, `rssi`, `fw_version`, `model`
  columns on `device` ✅
- `/display` writes those columns from request headers ✅
- `/log` parses JSON body as a record array, extracts
  battery/wifi/firmware fields, writes to the same columns ✅

### 2026-05-15 (hardware verification + panel content polish)

- Successfully paired and re-paired a real 7.5" TRMNL against
  production multiple times via pair-code OTP (`VV2NNY`, `J333RJ`,
  `Z492LT`, `K3Y62M`). ✅
- **1-bit grayscale PNG encoder** (`render/png1.ts`): hand-rolled
  PNG with `bit_depth=1` + `color_type=0`. TRMNL firmware ≥1.5.2
  rejects the 8-bit RGBA output `Resvg.asPng()` produced; this
  takes resvg's raw RGBA buffer and packs it correctly. ~3-5 KB
  per panel render. ✅
- **Floyd–Steinberg dithering** before threshold so photographic
  content (avatars) stipples instead of crushing to black blobs.
  Text/UI edges stay crisp because resvg outputs near-pure
  black/white there with little AA fringe for FS to push around. ✅
- **Avatars on each row**: fetch each roommate's projected
  `avatarUrl` in parallel, inline as base64 `data:` URI inside an
  `<image>` tag, let resvg composite. No hosting — BSky CDN URLs
  are pulled direct (forcing `@jpeg` suffix since BSky defaults
  to `image/webp` and resvg-wasm lacks a webp decoder); Telegram
  bot-fetch goes through our existing `/api/avatar/tg/...` proxy.
  Edge-cached by URL. 72×72 slot with a 2px border. ✅
- **Status pill variants + duration + 24h stale-clear**: `room`
  filled black, `lobby`/`dealers`/`panels`/custom outlined,
  `out`/`asleep` dashed-outlined (no grays — dashes binarize
  cleanly). Pill appends compact elapsed time (e.g. `ASLEEP · 2h14m`)
  and disappears entirely once the status is >24 h old. ✅
- **Con-local time**: new `con.timezone` IANA column
  (`Europe/Brussels`, etc., nullable). When set, header shows a
  24-hour wall clock under DAY 0N; DAY itself rolls at con-local
  midnight instead of UTC. Workers' built-in `Intl.DateTimeFormat`
  with full ICU does the conversion — no tz database needed. ✅
- **Revoke self-heal**: revoke is a one-poll-cycle notice. We
  clear `last_seen_at` on revoke so the first post-revoke poll
  shows the notice and touches the row; subsequent polls fall
  through to the unpaired+pair-code screen. Re-revoke wipes
  `last_seen_at` again. Solves the dead-end where revoked panels
  used to need direct D1 access to recover. ✅
- **TRMNL `filename` cache-bust on state transitions**: the
  `/api/display` envelope's filename now embeds the device's
  render state (`p`/`r`/`u`) alongside the time bucket, so any
  paired ↔ revoked ↔ unpaired transition forces the device to
  refetch inside the current bucket instead of holding the prior
  cached image. Without this, a revoke that landed mid-bucket
  was invisible to the panel. ✅
- **Auto-populate roommate handles**: identity rows' BSky /
  Telegram handles get copied onto `roommate.bsky_handle` /
  `telegram_handle` at insert time, plus a one-shot backfill
  migration for any pre-existing rows. ✅

## What's left

- **Dashboard UI for pair-code claim**: currently goes through
  `POST /api/rooms/:id/devices/claim` directly (curl). The UI
  affordance for typing in a 6-char code lives in the dashboard
  build, not here.
- **BMP1 encoder**: probably no longer needed. PNG works on real
  hardware. Leave parked unless we hit a firmware variant that
  insists on BMP.
- **Audit log writes** for `trmnl.setup` (first-seen) — small
  follow-up if useful for forensics.
- **Plex Serif font bundle** for mockup-parity typography on the
  room name, header clock, and "More" headline. Functional in
  Plex Mono / sans for now.
- **Region-masked dithering**: only worth pursuing if real-panel
  text on the e-ink shows visible noise from the whole-frame FS
  pass. Hasn't been observed in PNG previews, may not happen.
- **Admin UI for setting `con.timezone`**: currently set via
  `wrangler d1 execute` against prod. Per-con form field in the
  dashboard's con picker would close this.
