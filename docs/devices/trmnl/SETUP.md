# SETUP — TRMNL

How to bring a stock TRMNL (7.5", 800×480) online with con-sign, end
to end. Walks through what we actually did to pair our first unit — if
your experience diverges, file a doc patch.

For protocol-level background see [`PLAN.md`](./PLAN.md). For the
device-agnostic state machine see [`../protocol.md`](../protocol.md).

## What you need

- A TRMNL device (we tested an A1G22V). Stock firmware is fine — you
  do not need to reflash it.
- A 2.4 GHz Wi-Fi network the panel can reach.
- An account on cons.social with at least one room (so you have a
  room to pair the device to).
- ~5 minutes.

## 1. Point the TRMNL at cons.social

TRMNL stock firmware supports BYOS (Bring-Your-Own-Server) — the
captive portal lets you override the server URL at first boot.

1. Power-cycle the device. It boots into setup mode and exposes a
   Wi-Fi AP named something like `TRMNL-XXYYZZ`.
2. Connect to that AP from your phone or laptop. The captive portal
   opens automatically.
3. Fill in:
   - **Wi-Fi SSID / password** for your real network.
   - **API server**: `https://cons.social` — *no* trailing path, no
     `/api/trmnl`. The firmware appends `/api/setup`, `/api/display`,
     `/api/log` itself. Our worker mounts those at the API root in
     addition to `/api/trmnl/*` precisely so stock firmware works
     without a custom build.
4. Save. The device reboots, joins your network, and makes its
   first call to `/api/setup`.

If the captive portal on your firmware revision asks for an
`api_key` upfront, leave it blank. The server does not issue an
`api_key` until you've claimed the panel from a room (step 3) — the
firmware idles on `/setup` until then.

## 2. Watch the panel come up

On first poll the worker creates an unpaired device row keyed by the
MAC and returns a `status: 202` "awaiting claim" stub. The stub
includes an `image_url` for the rotating-pair-code splash, so the
panel displays:

```
              CON · SIGN
                ────

             PAIRING CODE

         ┌──────────────────┐
         │   K 3 Y 6 2 M    │   ← 6-char code, rotates every 5 min
         └──────────────────┘

       Enter this code at cons.social/pair
       to link this panel to your room.

         Code refreshes every 5 minutes.
```

The code is one-way: it maps to the device's UUID for ~5 minutes,
then rotates. If you miss the window, wait for the next refresh and
read the new code off the screen.

## 3. Claim the panel from your room

Until the dashboard's "Pair device" form ships, claim from the
command line. Replace `<ROOM_ID>` with your room's UUID (from
`GET /api/rooms`) and `<CODE>` with what's on the panel:

```bash
curl -X POST \
  -H "Cookie: cs_session=<your-session-jwt>" \
  -H "Origin: https://cons.social" \
  -H "Content-Type: application/json" \
  -d '{"code":"<CODE>"}' \
  https://cons.social/api/rooms/<ROOM_ID>/devices/claim
```

Response on success: `{"deviceId":"<uuid>"}`. The server has now
minted the panel's `api_key` and opened a 5-minute pending window.
The panel's next `/api/setup` poll picks the credential up (no
`ACCESS_TOKEN` required during the window — single-use, then the
window closes). From there the firmware switches to `/api/display`
polls and (within the configured `refresh_rate`, default 5 min)
returns the paired-room envelope and
the panel switches to the room sign.

If you want the panel to update immediately rather than waiting,
power-cycle it.

## 4. Flip privacy on what you want visible

The panel renders at the **guest** tier — fields the roommate hasn't
opted to expose at that tier don't appear. Defaults are conservative:
fursona name + species + pronouns are visible, **avatar and status
are private**. To get a richer panel:

```bash
# Find your roommate id for this room
curl -H "Cookie: cs_session=<...>" \
  https://cons.social/api/rooms/<ROOM_ID>/membership
# → {"members":[{"roommateId":"<RID>", ...}], ...}

# Bump avatar_url + status to guest visibility
curl -X PUT \
  -H "Cookie: cs_session=<...>" \
  -H "Origin: https://cons.social" \
  -H "Content-Type: application/json" \
  -d '{"visibility":{
        "fursona_name":"guest",
        "fursona_species":"guest",
        "pronouns":"guest",
        "bsky_handle":"guest",
        "avatar_url":"guest",
        "status":"guest"}}' \
  https://cons.social/api/rooms/<ROOM_ID>/roommates/<RID>/visibility
```

To set a status: `PATCH /api/rooms/<ROOM_ID>/roommates/<RID>` with
body `{"status":{"kind":"preset","preset":"room"}}` (or `lobby`,
`dealers`, `panels`, `out`, `asleep`, or `{"kind":"custom","text":"…"}`).

## 5. Set the con timezone (optional but recommended)

The header clock and DAY counter both honor `con.timezone`. ICS feeds
ship date-only, so we don't have one until you set it:

```bash
pnpm --filter @con-sign/worker exec wrangler d1 execute con-sign-db \
  --remote --command \
  "UPDATE con SET timezone = 'Europe/Brussels' WHERE id = '<CON_ID>'"
```

Pick the IANA name for the venue's city (`Europe/Brussels`,
`America/Los_Angeles`, `Asia/Tokyo`, etc.). Without it, the clock
disappears entirely and DAY rolls at UTC midnight, which is usually
wrong by a few hours.

## Verifying without the panel

You don't need the e-ink physically in front of you to debug
rendering. The same image the device fetches is reachable in your
browser:

```
https://cons.social/api/device/sign.png?d=<DEVICE_UUID>&fmt=png&w=800&h=480
```

Append `&t=<random>` to bust the worker's 60-second edge cache when
iterating on content.

To inspect what the TRMNL itself sees per poll:

```bash
curl https://cons.social/api/display \
  -H "ACCESS_TOKEN: <DEVICE_UUID>" \
  -H "ID: AA:BB:CC:DD:EE:FF"
# → {"filename":"sign-<8char>-p-<bucket>.png","image_url":"…","refresh_rate":300}
```

The middle letter in `filename` is the device's render state:
`p`=paired, `r`=revoked (one-shot notice), `u`=unpaired+pair-code.

## Recovering from a bad pair / revoke

**You accidentally revoked the panel.** From the panel's POV this is
not a dead end: it shows the "PANEL UNPAIRED" notice on the next
poll, and the poll after that flips back to a pair code. Read the
new code off the screen and run the same claim curl from step 3.

**Panel is stuck showing a stale screen.** TRMNL caches by the
`filename` field in the display envelope. Our filenames include both
a time-bucket and a state tag, so anything that changes server-side
state (claim, revoke, re-claim) busts the cache automatically. The
only way to get a stuck panel is if Wi-Fi dropped — check the
device's signal indicator and power-cycle.

**Panel never showed a pair code at all.** Walk through:
1. Is the URL correct? The captive portal sometimes silently drops
   the `https://` — check it's an absolute URL.
2. Curl `https://cons.social/api/setup` with `ID: <MAC>` header. A
   200 with JSON body means the worker can hear from the device's
   network; a different result means the panel isn't even reaching
   us.
3. Look at the device's `last_seen_at` via the room's
   `GET /api/rooms/<ROOM_ID>/devices` endpoint. Empty list = the
   device never registered. Present but stale `lastSeenAt` =
   registered but not polling.

## Troubleshooting we hit

- **First panel render was just a blank box.** Stock TRMNL firmware
  requires 1-bit grayscale PNG (`color_type=0, bit_depth=1`), not
  the 8-bit RGBA that `resvg.asPng()` emits. Fix is in the worker
  (`render/png1.ts`) — nothing for you to do on the device side.
- **Avatar showed up as a dark blob.** Resvg-wasm doesn't bundle a
  WebP decoder, but BSky's CDN serves WebP by default. We append
  `@jpeg` to BSky CDN URLs to coerce a JPEG response that resvg can
  read. Once rendered, Floyd–Steinberg dither turns the photo into
  a stippled image instead of crushing it to black. If your avatar
  still looks like a blob, your roommate row probably doesn't have
  `avatar_url` set to `guest` visibility — see step 4.
- **TRMNL polled but the worker 401'd.** The spec header is
  `ACCESS_TOKEN` (underscore, all caps), not the more natural-looking
  `Access-Token`. The worker accepts both, but if you're writing your
  own client, follow the spec.
