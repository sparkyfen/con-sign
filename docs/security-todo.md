# Security backlog

Running list of known weaknesses in the worker, ordered by severity. Each
entry has the current state of the code, the risk, and a proposed fix
with a rough effort estimate. Update as items land.

Severity scale:
- **High** — exploitable today, fix soon.
- **Medium** — fix before public launch / before the project sees real
  multi-tenant traffic.
- **Low** — defense-in-depth; nice to have.

---

## ~~H1. `POST /api/rooms/:id/devices/claim` is not rate-limited~~ ✅ landed `2c0cc18`

New `CLAIM_RL` binding (namespace 1002, 30 attempts/60s, keyed by userId).
Returns 429 `claim_rate_limited`. Zone-level rule still optional as a
slug-global backstop; not added since the per-user limit covers the
realistic attack.

---

## ~~H2. `claimDevice` has a TOCTOU race on KV reads~~ ✅ landed `27eeebc`

Option A: SQL upsert now carries `WHERE device.room_id IS NULL OR
device.revoked_at IS NOT NULL` on the conflict branch. Loser sees
`meta.changes === 0` → handler returns 409 `device_already_claimed`. The
KV race window still exists but the SQL is now the atomic gate so
double-pairing can't actually happen. Option B (D1-as-truth for the
code itself) deferred — not worth the migration unless we decide to
drop KV from this flow.

---

## ~~M1. No CSRF protection on state-changing endpoints~~ ✅ landed `8c4a1de`

`csrfOriginCheck` middleware mounted globally. Every POST/PATCH/PUT/DELETE
must arrive with an Origin header whose host equals the request URL's
host; missing or mismatched gets 403. GET/HEAD/OPTIONS pass through
(BSky's OAuth callback is GET). Token-based CSRF deferred — not needed
unless we ever take non-browser body-bearing requests on these routes.

---

## ~~M2. BlueSky OAuth has a single signing key, no rotation~~ ✅ landed `e0e5f29`

Loader accepts `BSKY_PRIVATE_JWKS` (JSON array). First key signs new
tokens, all keys publish on `/jwks.json` so in-flight refresh tokens
verify across the rotation window. Legacy `BSKY_PRIVATE_JWK` still
accepted (wrapped into a 1-element array). `keygen-bsky.mjs --jwks`
prints the new array form. Rotation procedure documented in
`apps/worker/README.md`. Per ATProto spec, 24h overlap is wildly
conservative (refresh tokens are single-use and rotate per call).

---

## ~~M3. No audit log of pairing / revocation / admin actions~~ ✅ landed (this session)

`audit_log` table (migration `0003_audit_log.sql`) + `src/db/audit.ts`
helper. All 9 Level-3 admin actions write: room.create, room.rename,
room.invite_created, room.member_joined, room.member_removed,
device.claim, device.revoke, roommate.passcode_rotated,
roommate.visibility_changed. Reads:
- `GET /api/rooms/:id/audit` (member-readable; the room's history)
- `GET /api/me/audit` (caller's own actions across all rooms)

`recordAudit` swallows write failures (logged via console.error) so a
broken audit table never breaks the underlying request. UI consumer
deferred — no Activity screen in the mockup, but the read endpoints are
useful for `wrangler d1 execute` during incident response right now.

---

## L1. Device bearer (`device_id`) is plaintext, persistent, panel-stealable

**State.** A panel's bearer is its UUID, set once at first boot and
reused forever. If the panel is physically stolen and the firmware
storage is dumped, the attacker can poll `/api/device/sign.png` with
that UUID forever.

**Risk.** The endpoint only returns a guest-tier projection (no
personal data, by design — see `PLAN.md`). The attacker learns the
public room view, which is information any QR-scanner already has.
Acceptable per the original threat model.

**Fix.** Not currently planned. If we ever expose more than guest-tier
data through the device endpoint, revisit and consider rotating
`device_id` on demand, or require an admin to re-pair a stolen device.

**Effort.** N/A unless threat model changes.

---

## L2. Visitor unlock is per-cookie, not identity-bound

**State.** The visitor `cs_unlock_<roomId>` cookie is additive — anyone
who has the cookie sees the unlocked roommates. Not tied to a logged-in
identity (by design — visitors don't log in).

**Risk.** An admin who shares an unlock cookie (intentionally or
accidentally — DevTools export, screenshare slip) effectively shares
unlock access. Per-roommate passcode rotation revokes by snapshot, but
that's a manual lever.

**Fix.** Already designed in PLAN.md as a stretch item: identity-tied
ACLs that augment passcodes with allowlists keyed off `identity`.
Tracked separately from this doc.

---

## Already mitigated (kept for reference)

- **Per-roommate passcode brute force.** `UNLOCK_RL` (per-cookie 10/60s)
  + zone Rate Limiting Rule on `/api/r/*/unlock` (200/hr) + Turnstile
  after 3 failures. Verified live 2026-05-08.
- **No IP-based blocking.** Hotel NAT means IP ≠ user; we deliberately
  don't ban IPs.
- **Pair-code single-use guarantee.** `consumePairCode` deletes both KV
  keys before returning the device_id. The race window in H2 is the
  remaining gap; the single-use property holds outside concurrent
  attacks.
