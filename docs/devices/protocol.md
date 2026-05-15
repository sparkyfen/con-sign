# Generic device protocol

The contract every con-sign device speaks. If you write firmware (Pi
Zero, ESP32, anything else with custom code), this is all you need to
talk to. Commercial devices with stock firmware that hardcode their
own URL paths get a thin adapter route alongside this — see e.g.
[`trmnl/PLAN.md`](./trmnl/PLAN.md) — but the underlying state machine
and image are the same.

## TL;DR

1. Generate a UUID once on first boot. Persist it in flash. Use it
   forever — this is the device's identity.
2. Poll `https://cons.social/api/device/sign.png?fmt=png&d=<your-uuid>&w=800&h=480`
   on whatever cadence makes sense for your hardware.
3. Display the bytes. They're a real PNG at your requested dimensions.
4. Sleep, repeat.

That's the entire contract. No registration call. No handshake. No
heartbeat. Three render states (unpaired with OTP, paired with the
room sign, revoked notice) dispatch automatically on the server.

## Auth

Bearer-as-UUID. Two equivalent transports — pick whichever your HTTP
client makes easier:

```
Authorization: Bearer <uuid>
```
or
```
GET /api/device/sign.png?d=<uuid>&fmt=png
```

The query-param form exists for cloud-mediated plugin services that
can only configure a URL, not headers. For raw-HTTP firmware, prefer
the header.

## Sizes

`w` and `h` query params override the default 800×480. Clamped to
`[100, 4096]`. The server scales the layout to your panel's native
resolution; common values:

| Panel | w × h |
|---|---|
| TRMNL, Waveshare 7.5" | 800 × 480 |
| Inkplate 6 | 800 × 600 |
| Waveshare 4.2" | 400 × 300 |
| M5Paper | 960 × 540 |

`fmt=png` returns image/png (raster). `fmt=svg` (default) returns the
underlying SVG if your firmware can rasterize itself. PNG path is
edge-cached for 60 s; SVG path is not.

## State machine (server-side, automatic)

The server picks one of three renders per request, based on the
device's current row in the `device` table:

| Server state | Render | What to display |
|---|---|---|
| No row | Unpaired panel with a rotating 6-char OTP code | The OTP. Don't store it; it rotates every 5 minutes. |
| `room_id` set | Paired room sign | Room name, con (with local clock + day counter), roommates with public-tier fields. |
| `revoked_at` set, `last_seen_at` NULL | Revoked notice | "Panel unpaired by a room admin." Shown once. |
| `revoked_at` set, `last_seen_at` non-NULL | Self-healed unpaired | Back to the OTP screen; admin re-claims to recover. |

Revoke is a one-poll-cycle notice: on revoke we clear `last_seen_at`,
so the first post-revoke poll renders the notice and touches the row;
every subsequent poll falls through to the unpaired branch so the
panel never gets stuck on a dead-end screen. `revoked_at` stays set
forever as an audit trail. The device doesn't participate in the
state change — it just keeps polling.

## Poll cadence

You choose. The server has no opinion. Practical guidance:

| Window | Suggested interval |
|---|---|
| Day of the con | 5 min |
| Within ±7 days of the con | 1 hour |
| Otherwise | 24 hours (effectively asleep) |

Battery-powered panels should sleep aggressively outside the con
window; mains-powered ones can poll faster. The image content
doesn't change often (status updates are minutes-apart at fastest),
so 5 minutes is the sensible floor.

If your firmware needs the server to tell it the next interval (i.e.
you don't want to hard-code cadence logic), use the device-specific
adapter route for your firmware family — see TRMNL's
[`/api/trmnl/display`](./trmnl/PLAN.md) which returns a JSON envelope
with `refresh_rate` alongside the image URL.

## Errors

The endpoint returns standard HTTP status codes. The body is always
`{ "error": "...", "message"?: "..." }` for non-2xx (the device
endpoint specifically; other parts of the API have richer shapes).

| Code | When | Device should |
|---|---|---|
| 200 | Normal | Render bytes. |
| 401 `missing_bearer` | No UUID supplied | Check your firmware persisted the UUID; otherwise generate one. |
| 404 `room_not_found` | Device's `room_id` points at a deleted room (very rare) | Sleep, try again later. |
| 429 | Cloudflare zone-level rate limit (per-path) | Back off; you're polling too fast. |
| 500 | Server problem | Sleep, try again later. |

Devices should be tolerant: a single failed fetch isn't a problem,
just retry on the next scheduled poll. Don't burn battery hammering
on an error.

## Pair-code claim

When the panel shows the OTP screen, that 6-character code maps to
your device's UUID for ~5 minutes. An admin types the code into the
dashboard's "Pair device" form; the server reverse-looks-up the
device row by code, marks it paired to their room. Your next poll
returns the paired sign.

You don't need to know any of this. Just keep polling.

## Time-on-device

You don't need a real clock. The server tracks `last_seen_at` per
device based on its poll timestamps. Your firmware can sleep
through anything that's not a poll.

## Commercial-firmware devices

Devices like TRMNL ship with stock firmware that hardcodes its own
URL paths and JSON shapes. We accommodate those via thin adapter
routes (e.g. `/api/trmnl/*`) that translate to the same image and
the same state machine described above. Don't write your own
firmware for those devices — use ours-on-top-of-theirs.

## Future devices

Anyone adding a new commercial device family should add a
`docs/devices/<name>/PLAN.md` and, if the device's stock firmware
needs a custom protocol, a `apps/worker/src/routes/devices/<name>.ts`
adapter. Generic-firmware devices need nothing — they're already
supported by this contract.
