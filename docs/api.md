# con-sign API

Reference for the UI partner. All endpoints are served by the Worker at
`https://cons.social/api/*`. Requests/responses are JSON unless noted.

Type names below match the zod schemas exported from `@con-sign/shared` —
import them in the frontend rather than re-deriving:

```ts
import {
  type Roommate, type RoomDetail, type RoomList, type SessionUser,
  type VisitorRoomView, type DeviceList, type PasscodeIssued,
} from '@con-sign/shared';
```

## Conventions

- **Auth**: cookie-based. After login the Worker sets a `cs_session` HttpOnly
  cookie (30-day TTL, KV-revocable). Most admin/roommate endpoints require it
  and respond `401 { error: "unauthenticated" }` if missing/invalid.
- **Visitor unlock**: separate per-room `cs_unlock_<roomId>` cookies; additive
  across roommates within a room, 24-hour TTL.
- **Errors**: every non-2xx response is `{ error: string, message?: string }`.
  Validation failures from zod come back as `400 { error: "invalid_request",
  issues: [...] }` with the standard zod issue array.
- **Content type**: requests with bodies should send
  `Content-Type: application/json`. Responses are `application/json` except
  the device sign and the room QR (both `image/svg+xml`).

---

## Auth

### `GET /api/auth/bsky/start?handle=<handle>`
Begin Bluesky OAuth. Server resolves the handle, builds an authorize URL,
and 302s to it. After the user approves, they land on `/api/auth/bsky/callback`
which sets the session cookie and 302s to `/`.

### `GET /api/auth/bsky/callback`
Internal — only called by Bluesky's authorization server. Don't link to it.

### `GET /api/auth/bsky/client-metadata.json` and `GET /api/auth/bsky/jwks.json`
Public OAuth client metadata + JWKS. Bluesky's AS fetches these directly.
Don't proxy from the frontend.

### `POST /api/auth/telegram/callback`
Body: the payload from the Telegram Login Widget (id, first_name, last_name,
username, photo_url, auth_date, hash).
Response: `200 { ok: true, userId: string }` and sets `cs_session`. The
widget posts here itself; don't call manually.

### `GET /api/auth/me` *(auth required)*
Response: `SessionUser` —
```json
{
  "userId": "uuid",
  "displayName": "Sparky",
  "identities": [
    { "provider": "bsky", "handle": "sparky.social", "avatarUrl": "https://..." },
    { "provider": "telegram", "handle": "sparky_tg", "avatarUrl": null }
  ]
}
```
Identities are sorted newest-first.

### `POST /api/auth/logout`
Revokes the current session's `jti` in KV and clears the cookie.
Response: `{ ok: true }`.

---

## Cons (read-only catalog, ICS-synced daily)

### `GET /api/cons?q=<query>&limit=<1..50>`
Typeahead search. Query is matched against name (case-insensitive substring).
Without `q`, returns the next upcoming cons by `start_date`.
Response: `{ cons: Con[] }`.

### `POST /api/cons/sync` *(auth required)*
Manual ICS resync. Useful during testing; the daily cron at 07:00 UTC handles
the normal case.
Response: `{ ingested: number }`.

---

## Visitor (no login required)

### `GET /api/r/:slug`
Fetch the room view as projected for the current visitor cookie.
Anyone with the slug sees `guest`-tier fields; entering a roommate's
passcode upgrades that one roommate's projection to `personal`.
Response: `VisitorRoomView` —
```json
{
  "room": { "id", "name", "qrSlug", "con": { "id", "name" } },
  "roommates": [ProjectedRoommate, ...],
  "unlockedRoommateIds": ["uuid", ...],
  "turnstileRequired": false
}
```
`ProjectedRoommate` only contains the fields the viewer is authorized to
see — absent fields are *omitted*, not nulled.

### `POST /api/r/:slug/unlock`
Body: `UnlockRequest` — `{ passcode: string, turnstileToken?: string }`.
Server hashes against every roommate in the room and sets/extends the
unlock cookie if any matches.
After 3 failed attempts on the same slug, `turnstileRequired: true` comes
back and the next request must include a `turnstileToken` from the widget.
Response: `UnlockResponse` —
```json
{ "unlockedRoommateIds": [...], "matched": true, "turnstileRequired": false }
```

---

## Avatars

### `GET /api/avatar/tg/:tgUserId`
Stream-proxied Telegram user avatar via the Bot API. Cached `private` for
1 hour. Use as `<img src="/api/avatar/tg/12345">` — no JSON wrapper.

---

## Rooms

### `GET /api/rooms` *(auth required)*
Every room the caller is a member of. Powers the dashboard sidebar.
Response: `RoomList` —
```json
{
  "rooms": [{
    "id": "uuid", "name": "Suite 1842", "qrSlug": "abc123",
    "role": "admin",
    "conId": "uuid", "conName": "Anthrocon",
    "conStartDate": "2026-07-04", "conEndDate": "2026-07-07"
  }]
}
```

### `POST /api/rooms` *(auth required)*
Create a room. Caller becomes the first admin and gets a personal passcode
returned **once**.
Body: `CreateRoom` — `{ conId: string, name: string }`.
Response:
```json
{
  "room": { "id", "qrSlug", "name", "conId" },
  "me":   { "roommateId": "uuid" },
  "passcode": PasscodeIssued
}
```

### `GET /api/rooms/:id` *(member required)*
Header data for any in-room dashboard screen.
Response: `RoomDetail` —
```json
{
  "room": { "id", "conId", "name", "qrSlug", "createdAt" },
  "con":  { "id", "name", "startDate", "endDate", "location", "url" },
  "myRole": "admin"
}
```

### `PATCH /api/rooms/:id` *(admin required)*
Body: `UpdateRoom` — `{ name?: string }`. Response: `{ ok: true }`.

### `GET /api/rooms/:id/membership` *(member required)*
Lightweight roster for the admin management UI.
Response: `RoomMembership` —
```json
{
  "members": [{
    "roommateId", "userId", "role", "displayName", "joinedAt"
  }],
  "isOnlyAdmin": false
}
```
`isOnlyAdmin` is true iff the *caller* is the room's only admin — pre-disable
"Leave" / "Remove" buttons accordingly so users don't hit the 409.

### `GET /api/rooms/:id/qr.png` *(admin required)*
Returns an SVG (despite the `.png` extension; the URL is kept stable).
Encodes the public room URL `https://cons.social/r/<slug>`. Use directly
as `<img src="...">`. Cached `private, max-age=3600`.

### `POST /api/rooms/:id/invite` *(admin required)*
Mint an invite token (5-min TTL). Response: `InviteResponse` —
`{ inviteUrl: string, expiresAt: ISO8601 }`. Share the URL — the invitee logs
in (if needed), then the frontend extracts the token from the URL and POSTs
to `/api/rooms/join`.

### `POST /api/rooms/join` *(auth required)*
Body: `{ token: string }` — the token from `inviteUrl.split('/invite/')[1]`.
Response on success: `{ roommateId, role: 'member', passcode: PasscodeIssued }`.
- `409 invite_already_used` — token was consumed previously.
- `400 invite_expired` / `invite_bad_sig` — bad token.
- If the user is already a member, returns `{ roommateId, role }` (no new
  passcode) — re-using the link is a no-op.

---

## Roommates (within a room)

### `GET /api/rooms/:id/roommates/:rid` *(self or admin)*
Full `Roommate` row — no privacy projection. Backs the editor UI and the
admin's "view profile" affordance. 403 if you're a member trying to read
someone else.

### `PATCH /api/rooms/:id/roommates/:rid` *(self only)*
Body: `UpdateRoommate` — `{ fursonaName?, fursonaSpecies?, pronouns?,
bskyHandle?, telegramHandle?, status? }`. All fields optional and nullable
to clear. `status` is the discriminated union:
```ts
{ kind: 'preset', preset: 'room'|'lobby'|'dealers'|'panels'|'out'|'asleep' }
| { kind: 'custom', text: string }   // 1..140 chars
```
Setting a preset clears any custom text and bumps `statusUpdatedAt`.

### `DELETE /api/rooms/:id/roommates/:rid` *(admin or self)*
Remove a roommate. `409 last_admin` if this would leave the room admin-less.
Response: `{ ok: true }`.

### `GET /api/rooms/:id/roommates/:rid/visibility` *(self only)*
Response: `{ visibility: FieldVisibility }`. Maps each configurable field
name to the minimum tier required to see it. Fields not in the map default
to `private`.

### `PUT /api/rooms/:id/roommates/:rid/visibility` *(self only)*
Body: `UpdateFieldVisibility` — `{ visibility: FieldVisibility }`. Replaces
the entire visibility map (it's not a patch — send the full set).

Configurable field names: `fursona_name`, `fursona_species`, `pronouns`,
`bsky_handle`, `telegram_handle`, `avatar_url`, `status`.
Tiers: `'guest' | 'personal' | 'private'`.

### `POST /api/rooms/:id/roommates/:rid/passcode` *(self only)*
Rotate the personal passcode. Response: `PasscodeIssued` —
```json
{ "passcode": "ABCD2345", "shareUrl": "https://.../r/<slug>#k=ABCD2345",
  "qrDataUrl": "data:image/svg+xml;utf8,..." }
```
The plaintext is unrecoverable after this response. Old share links and
existing visitor unlock cookies for *this* roommate are invalidated;
unlocks for other roommates in the room are unaffected.

---

## Devices (e-ink panel pairing)

### `POST /api/rooms/:id/devices/claim` *(admin required)*
Body: `ClaimDevice` — `{ code: string }`. The 6-char OTP shown on the
unpaired panel; case-insensitive, spaces/dashes stripped server-side.
Response: `{ deviceId: string }`. Errors: `404 pair_code_unknown_or_expired`.

### `GET /api/rooms/:id/devices` *(member required)*
Response: `DeviceList` —
```json
{ "devices": [{ "id": "uuid", "pairedAt": ISO8601, "lastSeenAt": ISO8601 }] }
```

### `DELETE /api/rooms/:id/devices/:deviceId` *(admin required)*
Sets `revoked_at` on the device row; the panel's next poll renders the
"PANEL UNPAIRED" screen. Re-pairing requires the admin to delete the row
entirely (no API for that yet — open question if needed).
Response: `{ ok: true }`.

### `GET /api/device/sign.png?w=&h=` *(device bearer)*
Bearer is the panel's persistent UUID (firmware-generated). Returns SVG.
Three render branches selected automatically:
- No `device` row → unpaired panel with the rotating 6-char code
- Row with `room_id` set → paired room sign
- Row with `revoked_at` set → "PANEL UNPAIRED" screen

`w` / `h` query params override the default 800×480 (clamped 100..4096).

---

## Health

### `GET /api/health`
Probes D1 + KV. `200 { ok: true, components: { d1: true, kv: true } }`
when both work; `503` with the failing component flagged otherwise.

---

## Stretch (stubbed)

- `POST /api/parties`, `PATCH /api/parties/:id`, `DELETE /api/parties/:id` —
  return `404 not_implemented` for now. Schema exists; UI is feature-flagged.
