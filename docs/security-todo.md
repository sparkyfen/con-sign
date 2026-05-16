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

## ~~H0. `/api/trmnl/setup` returned api_key on any MAC handshake~~ ✅ landed `407b6cc`

`device.api_key` is now a separate column from `device.id` (migration
`0009_device_api_key.sql`). `/setup` returns a `status: 202` "awaiting
claim" stub by default and only releases the api_key when (a) the
request presents matching `ACCESS_TOKEN` (re-pair) or (b) a 5-minute
post-claim pending window is open (one-shot hand-off). `/display` and
`/log` require `ACCESS_TOKEN`; MAC fallback removed. `claimDevice`
rotates the api_key on every successful claim so a prior holder
can't ride into a new pairing. Smoke-verified in prod.

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

## L1. Device bearer (`api_key`) is plaintext on-panel, rotatable on re-claim

**State.** A claimed panel persists its `device.api_key` (a UUID) in
non-volatile firmware config. Physical theft + storage dump leaks
that api_key. The attacker can then poll `/api/trmnl/display`,
`/api/trmnl/log`, and `/api/device/sign.png?d=<api_key>` for that
device.

**Risk (post-H0 model, see commit 407b6cc).**
- `/sign.png` returns the same GUEST-tier projection that any
  QR-scanner in the corridor already sees. No incremental
  confidentiality loss vs. baseline threat.
- `/log` lets the attacker write 1 KB of arbitrary JSON into the
  device's KV log entry that admins read when triaging. Telemetry
  corruption surface; bounded by `LOG_MAX_BYTES`.
- `/display` returns the envelope; no extra data.
- **Persistence is bounded by admin action.** Admin clicks revoke
  in the dashboard → re-claim via pair-code OTP → `claimDevice`
  mints a *fresh* api_key, invalidating the stolen one. Recovery
  is one dashboard action, no D1 edit needed.

**Accepted** per the original threat model. No code change required.

**Revisit if any of:**
- Device endpoints start exposing data above GUEST tier.
- `/log` payloads start driving anything beyond admin-triage UI
  (e.g., automated alerts that an attacker could spoof).
- We add a "reset device" admin affordance (revoke + claim in one
  click) that wants to clear `api_key` directly rather than going
  through the OTP path — UX work, not security.

---

## L2. Visitor unlock is per-cookie, not identity-bound — accepted, tracked in PLAN.md

**State.** The visitor `cs_unlock_<roomId>` cookie is additive: anyone
who has the cookie sees the unlocked roommates. Not tied to a logged-in
identity by design — visitors don't log in.

**Risk.** A cookie shared intentionally or leaked accidentally
(DevTools export, screenshare slip, browser sync to a shared device)
hands unlock access to the recipient. The current revoke mechanism is
per-roommate passcode rotation — admin-driven, by snapshot, manual.

**Accepted** per the visitor model. The improvement path is
**identity-tied ACLs** that augment the passcode tier with allowlists
keyed off `identity`. Tracked in `PLAN.md` under the deferred
stretch-goal list (search for "Identity-tied ACLs"), gated on the
`/login` page existing on the frontend so visitors can opt into
logging in.

---

## ~~M4. `AVATAR_RL` keyed on IP — hotel-NAT fragile during a con~~ ✅ landed (this session)

Rate-limit now keys on the `cs_visitor` cookie minted by `/api/r/:slug`
(`apps/worker/src/routes/avatar.ts:32-37`). Hundreds of attendees on
one venue Wi-Fi each get their own bucket. Cookieless / direct-API
hits fall through to `avatar:ip:<CF-Connecting-IP>` as the original
Bot-API-quota guard. Budget dropped from 60/60s to 30/60s — generous
per-visitor since the edge cache absorbs every duplicate before this
limiter is reached. Cookie name centralized in `auth/session.ts` as
`VISITOR_ID_COOKIE`.

---

## M6. `/api/auth/{bsky,telegram}` has no rate-limit — deferred

**State.** Both login start/callback endpoints rely solely on
Cloudflare-edge absorption. No app-level limit; no Turnstile gate.

**Risk.** Burns Worker CPU during a flood; no credential leak (the
OAuth state/HMAC checks fail closed). Realistic exploit is nuisance,
not compromise.

**Decision.** Defer. Adding Turnstile to every login click is
over-correcting for an availability concern that hasn't materialized,
and the JA3/JA4 fingerprint Rate Limit Rule needs a Pro zone we
don't have. Edge absorption is the load-bearing defense for now.

**Trigger to revisit (any of):**
- `wrangler tail` shows sustained login traffic that the Worker
  CPU budget can't absorb (i.e. real users start seeing slow
  logins during a flood).
- One IP / JA3 fingerprint completes >100 failed BSky/Telegram
  callbacks in an hour — actual login-brute behavior.
- Zone plan moves to Pro (unlocks JA3/JA4 Rate Limit Rules without
  any application-layer change).

**Fix when triggered.**
- **A:** Stage Turnstile only after N failed callbacks per visitor
  cookie, mirroring the `/unlock` 3-failures → Turnstile pattern in
  `apps/worker/src/routes/visitor.ts:28`. ~1 h.
- **B:** JA3/JA4 fingerprint Rate Limit Rule at the zone layer once
  the plan supports it. Zero application code.

---

## L3. BSky link flow has no explicit "are you linking?" confirmation — deferred until dashboard

**State.** `/api/auth/bsky/start` infers link-vs-login intent from
the presence of a `cs_session` cookie. If a logged-in user clicks a
crafted start URL with `?handle=<attacker handle>`, the callback
attaches the attacker's identity to the victim's user record (via
`linkToUserId`), enabling subsequent attacker-side login as victim.

**Risk.** Practical exploit requires the victim to complete a
BlueSky consent flow as an attacker-controlled handle — which means
the victim would need to log into BSky AS the attacker. The
`IdentityCollisionError` path catches the case where the attacker's
DID is already linked to someone else. Real-world likelihood is
very low absent significant social engineering.

**Decision.** Defer. The clean fix is a dashboard "Link account"
affordance that mints a short-TTL nonce, and `/start` rejects link
intent without that nonce. That can only land once the dashboard
frontend exists — there's nothing to attach the affordance to today
(the web app is splash-only).

**Trigger to revisit.** When the dashboard ships an "Account
settings → Linked accounts" screen (or equivalent), bundle the
nonce-gated link flow with it.

**Fix when triggered.**
- Dashboard mints a one-shot nonce in KV (`bsky:link:<nonce>` →
  `userId`, 5-min TTL), redirects to
  `/api/auth/bsky/start?handle=…&link=<nonce>`.
- `/start` requires `link=` for `linkToUserId` to take effect.
  Without it, an existing `cs_session` is ignored and the flow is
  treated as a fresh login (which collides on the existing identity
  → no silent attach).

---

## L4. Pair-code KV consumption is not strictly atomic across reads

**State.** `consumePairCode` (`apps/worker/src/auth/pair-code.ts:67`)
does a get-then-delete sequence. Two concurrent claim requests for
the same code could both observe the device_id before either delete
lands.

**Risk.** Race collapses at the DB layer: `claimDevice`'s
`ON CONFLICT(id) DO UPDATE … WHERE device.room_id IS NULL OR
revoked_at IS NOT NULL` makes only one INSERT/UPDATE succeed; the
loser gets `meta.changes === 0` → 409 `device_already_claimed`. So
double-pairing can't actually happen; the KV race is cosmetic.

**Fix.** None needed. Documented here so future work that decouples
the DB step doesn't inadvertently widen the window.

---

## Intentional behaviors (not vulnerabilities)

- **Revoked devices retain a working `api_key`** for `/sign.png`
  and `/log`. By design — the firmware needs to authenticate to
  render the revoke notice and self-heal. The credential rotates
  on re-claim (`claimDevice` overwrites `api_key`), so prior
  holders get cut off the moment a new pairing happens. State
  classifier owns this in `apps/worker/src/devices/state.ts`.
- **Telegram payload zod schema strips unknown fields.** If
  Telegram adds a payload field in future, HMAC verification fails
  closed (the data-check-string excludes the new field but
  Telegram included it in the hash). Denial of the new field's
  flow, never a bypass.
- **MAC alone is not a credential anywhere** (see H0). MAC is
  printed on panel chassis and visible on Wi-Fi; the codebase
  treats it as identity only.

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
