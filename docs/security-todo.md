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

## H1. `POST /api/rooms/:id/devices/claim` is not rate-limited

**State.** The endpoint requires an admin session (`requireUser` +
`requireAdmin`), but does not consult the `UNLOCK_RL` binding or any
zone-level Rate Limiting Rule. A logged-in attacker (or an attacker who
phishes one session) can submit codes as fast as the worker accepts.

**Risk.** The pair-code keyspace is 32⁶ ≈ 10⁹. An attacker who has any
admin session could brute-force every active 5-minute code in seconds —
once they hit a real one, they pair *that device* into *their own* room
and the panel starts displaying their content.

**Fix.** Add a per-user limit on `/devices/claim` using the existing
Workers Rate Limiting binding (or a second binding with a tighter window
— e.g. 30 attempts/min per cookie). Return 429 with a clear error code.
A zone-level Rate Limiting Rule on the path is also worth adding as a
slug-global backstop, mirroring what we already have for `/api/r/*/unlock`.

**Effort.** ~30 minutes plus a test.

**Files.** `apps/worker/src/routes/rooms.ts` (`/devices/claim` handler),
`apps/worker/wrangler.toml` (potentially a new RL binding), Cloudflare
dashboard (zone rule).

---

## H2. `claimDevice` has a TOCTOU race on KV reads

**State.** `consumePairCode` does `kv.get(codeKey)` → `kv.delete(codeKey)`
→ `kv.delete(deviceKey)`. Between the get and the deletes, two concurrent
requests can both observe the same code. KV has no atomic
compare-and-delete primitive.

**Risk.** Two admins who both hold the same code (e.g. a phished code
forwarded to a confederate) can both claim the same device. The second
`INSERT ... ON CONFLICT DO UPDATE` in `claimDevice` will then overwrite
the first claim's `room_id`, silently transferring the device to the
loser of the race.

**Fix.** Two possible hardenings:
- **Option A (cheap):** Make the second insert conditional. Move from the
  current `ON CONFLICT DO UPDATE SET room_id = excluded.room_id` to a
  CTE that only updates when the existing `room_id` is NULL or
  `revoked_at` is set. Fail closed (409) on the loser. The first claim
  wins, the second gets a clean error.
- **Option B (thorough):** Use D1 as the authoritative store for the
  pair code itself — a `pair_code` table with `(code PRIMARY KEY,
  device_id, expires_at)`. INSERT is the atomic gate; on claim, run
  `DELETE FROM pair_code WHERE code = ? RETURNING device_id`. SQLite has
  RETURNING. KV becomes a cache rather than truth.

**Recommendation.** Option A first (small diff, fixes the race in
practice). Option B if/when we want to drop KV from this flow entirely.

**Effort.** Option A: ~45 minutes plus a concurrency test using
Promise.all to fire two claims simultaneously. Option B: ~2 hours plus
migration.

**Files.** `apps/worker/src/db/queries.ts` (`claimDevice`), test additions.

---

## M1. No CSRF protection on state-changing endpoints

**State.** All `POST` / `PATCH` / `DELETE` endpoints rely on the
`cs_session` cookie alone for authentication. The cookie is `SameSite=Lax`,
which prevents most cross-origin form submissions but does not prevent a
top-level navigation from a malicious site to e.g.
`https://cons.social/api/rooms/.../devices/claim` if a logged-in admin
clicks a crafted link. (Lax allows top-level GET; we don't accept GET on
state-changing endpoints, so the actual exposure is narrower than it
looks, but it's not zero.)

**Risk.** An attacker can craft a page that auto-submits a JSON POST
from a logged-in admin's browser, claiming a device the attacker is
running into the admin's room without their consent — or revoking
devices, or changing room metadata.

**Fix.** Two options:
- Require `Origin` header matches the worker's host on all
  state-changing endpoints. Browsers always send `Origin` on
  cross-origin requests; checking it is one middleware.
- Add a double-submit token (`csrf_token` cookie + `X-CSRF-Token`
  header), generated on login.

**Recommendation.** Origin check first — it's a 10-line middleware and
covers the realistic attack. Token-based CSRF if we decide to support
non-browser clients with a different cookie strategy.

**Effort.** ~30 minutes including a test.

**Files.** New `apps/worker/src/auth/csrf.ts`, `index.ts` to wire it,
plus tests.

---

## M2. BlueSky OAuth has a single signing key, no rotation

**State.** `BSKY_PRIVATE_JWK` is one ES256 key, served as the only entry
in the JWKS document. The JWKS spec supports multiple keys (with
overlapping validity windows) precisely so you can rotate without
breaking outstanding tokens.

**Risk.** If we ever need to rotate this key (suspected compromise,
periodic hygiene, scheduled rotation), the only path is to mint a new
key and immediately invalidate every active session — there's no
overlap window where both old and new signatures verify. In a real
incident this means user-visible downtime.

**Fix.** Accept a JSON array of JWKs in `BSKY_PRIVATE_JWKS` (replacing
the singular). Sign with the first key, but publish all of them on
`/jwks.json`. To rotate: prepend the new key, deploy, wait the longest
session lifetime + slop, then drop the old key on the next deploy.

**Effort.** ~45 minutes plus a test.

**Files.** `apps/worker/src/auth/bsky/client.ts`,
`apps/worker/src/types.ts`, key-gen helper script.

---

## M3. No audit log of pairing / revocation / admin actions

**State.** The worker writes nothing about who paired which device into
which room, who promoted whom, who rotated which passcode, etc.

**Risk.** Forensics after a compromise are limited to whatever
Cloudflare logs give us (HTTP-level, not application semantic). For a
multi-tenant app where multiple admins share a room, an admin acting in
bad faith leaves no in-app trail.

**Fix.** Add an `audit_log` table: `(id, actor_user_id, room_id, action,
target_id, metadata_json, at)`. Write entries from every admin-action
endpoint. A small admin "Activity" view in the dashboard renders these.

**Effort.** ~3 hours: migration, helper, write-sites in 6-8 endpoints,
read endpoint, tests.

**Files.** New migration `0003_audit_log.sql`, new
`apps/worker/src/db/audit.ts`, updates to most admin-action handlers.

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
