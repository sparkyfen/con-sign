# PLAN — Telegram bot

Status: **outline only, not implemented**. Lives here so we can pick it up
later without re-deriving the design.

## Goal

Let a roommate change their door-sign status from their phone in three
taps, without leaving Telegram. The splash promises "update your status
from your phone" — today that means opening cons.social and tapping
through the dashboard. A bot collapses that to one DM.

Everything else (profile editing, visibility map, device pairing) stays
on the web app where it belongs.

## Non-goals

- Replacing the web dashboard. Anything that needs structured input
  (fursona, pronouns, per-field visibility, claim codes) is bad UX over
  chat.
- Group chats. The bot only responds to DMs.
- Bot-to-panel pairing. Admins are already at the panel + dashboard
  when they pair; chat doesn't help.
- Public-facing search / inline mode. The bot has one audience: a
  con-sign user with a paired Telegram identity.

## Architecture

```
┌───────────────┐  webhook POST  ┌─────────────────┐
│  Telegram     │ ─────────────▶ │ Worker          │
│  user via DM  │                │ /api/tg/webhook │
└───────────────┘ ◀───────────── │  → dispatch     │
                  sendMessage    │  → existing D1  │
                                 └─────────────────┘
```

- Worker exposes `POST /api/tg/webhook` (new). Telegram signs the
  request with the `secret_token` header we register at webhook
  setup; the handler rejects anything missing or mismatched. No
  CSRF Origin check applies (webhook is a server-to-server POST,
  not a browser; carve it out in `csrfOriginCheck` by allowlisting
  this specific path).
- Bot identity (`TG_BOT_TOKEN`) is already a Worker secret in prod —
  shipped for the Login Widget. Reuse it.
- A dispatch table maps `/command` → handler. Unknown command → friendly
  hint. Handlers are short async functions that talk to D1 / KV via
  the same query helpers the rest of the Worker uses.
- No new tables. We already have `identity (provider='telegram',
  provider_id=tg user id, user_id)` from the Login Widget; that
  resolves a Telegram `from.id` to a con-sign `user_id` to a
  `roommate` row (if they're in a room).

## Auth model

- Telegram signs the webhook with the `secret_token` we picked at
  setup (new secret `TG_WEBHOOK_SECRET`, a random 64-char string).
  Any request without a matching `X-Telegram-Bot-Api-Secret-Token`
  header → 401.
- Inside a verified webhook, we trust `update.message.from.id` as the
  Telegram user.
- Look up `identity WHERE provider='telegram' AND provider_id = ?`.
  - Found → the user is linked. Proceed.
  - Not found → `/start` walks them through `https://cons.social/login`
    so they can finish the link via the existing widget. All other
    commands reply "I don't recognize you — DM me /start first."
- Roommate context: a user can be a member of multiple rooms. Reply
  with the most-recently-joined room by default; commands that take
  a room can pass `?room=<slug>` (the bot stores per-user
  "preferred room" in KV for next time). MVP: just use most-recent.

## Commands

### Tier 1 — the actual pitch (build first)

| Command | Behavior |
|---|---|
| `/start` | Onboard. If linked, "Hi, you're set up." If not, deep-link to `cons.social/login?from=tg`. |
| `/here`, `/lobby`, `/dealers`, `/panels`, `/away`, `/sleep` | Set the caller's status to the matching `status_preset`. Replies with confirmation + the time. |
| `/custom <text>` | Set custom status (1..140 chars; same as the web editor). |
| `/status` | Show your current status + `statusUpdatedAt`. |
| `/who` | Roommate list with current statuses, privacy-projected the same way the visitor view projects (caller sees what they're authorized to see). |

### Tier 2 — useful, lower urgency

| Command | Behavior |
|---|---|
| `/share` | DM back the share URL + QR (the existing `PasscodeIssued.qrDataUrl`). |
| `/rotate` | Rotate the passcode, return new share URL. |
| `/whoami` | Show linked con-sign user (display name + identity list). |
| `/unlink` | Soft-disconnect: delete the Telegram identity row. The user can re-link via `/start`. |

### Tier 3 — admin only, less great over chat

| Command | Behavior |
|---|---|
| `/audit` | Last 20 audit entries for the caller's room (reuses `listAuditForRoom`). |
| `/devices` | List paired panels for the caller's room with `last_seen_at`. |

### Probably never

- Profile editing (fursona/species/pronouns/handles)
- Visibility-map editing
- Device pair-code claim

## Implementation sketch

```
apps/worker/src/
  routes/
    telegram.ts            # POST /api/tg/webhook handler
  bot/                     # bot-specific logic (kept out of routes/)
    dispatch.ts            # command -> handler map
    handlers/
      start.ts             # /start
      status.ts            # /here, /lobby, /custom, /status
      who.ts               # /who (member-readable projection)
      share.ts             # /share, /rotate (Tier 2)
      admin.ts             # /audit, /devices (Tier 3)
    send.ts                # sendMessage wrapper (text + Markdown V2 escape)
    verify.ts              # secret_token check
    types.ts               # narrowed Update types we care about
```

- One new route in `index.ts`: `app.route('/api/tg', telegramRoutes)`.
- The CSRF middleware needs an opt-out for `/api/tg/webhook` (webhook
  isn't a browser request, has no Origin). Cleanest: the webhook
  handler trusts only its own `secret_token` header — we can exempt
  the path inside `csrfOriginCheck`.
- All handlers reuse the existing query helpers + audit log writes.
  Setting a status from chat should produce an audit row exactly like
  the web `PATCH /api/rooms/:id/roommates/:rid` does — single source
  of truth at the `updateRoommateProfile` level, not at the route.

## Data model

**No new tables.** All commands work against `identity`, `user`,
`roommate`, `room`, `device`, `audit_log`. New write paths just call
the existing helpers with different arguments.

The bot might want to remember a "preferred room" per user when
they're in multiple rooms; that's a KV key (`tg:prefroom:<user_id>`
→ room_id) and only relevant once we have multi-room users in the
wild. Defer.

## Webhook + setup steps

1. `wrangler secret put TG_WEBHOOK_SECRET` — random 64-char hex.
   New secret; can't be derived from `TG_BOT_TOKEN`.
2. Deploy the worker so `/api/tg/webhook` exists.
3. Register the webhook with Telegram (one-time):
   ```bash
   curl -s "https://api.telegram.org/bot$TG_BOT_TOKEN/setWebhook" \
     -d "url=https://cons.social/api/tg/webhook" \
     -d "secret_token=$TG_WEBHOOK_SECRET"
   ```
4. Set the in-app command menu (one-time):
   ```bash
   curl -s "https://api.telegram.org/bot$TG_BOT_TOKEN/setMyCommands" \
     -H 'Content-Type: application/json' \
     -d '{"commands":[
       {"command":"start","description":"Sign in / re-link"},
       {"command":"status","description":"Show your current status"},
       {"command":"here","description":"Set status: in the room"},
       {"command":"lobby","description":"Set status: in the lobby"},
       {"command":"dealers","description":"Set status: dealers'\''s den"},
       {"command":"panels","description":"Set status: at panels"},
       {"command":"away","description":"Set status: out"},
       {"command":"sleep","description":"Set status: asleep"},
       {"command":"custom","description":"Set custom status text"},
       {"command":"who","description":"Show roommates and their statuses"}
     ]}'
   ```
5. (Tier 2+ adds `/share`, `/rotate`, etc. to the same payload.)

## Open questions

- **Markdown vs HTML output.** Telegram's MarkdownV2 escaping rules
  are annoying; HTML mode is simpler. Pick one before writing
  handlers (recommend HTML — strict escape, no surprises).
- **Multi-room disambiguation.** When a user is in two rooms, does
  `/here` set status in both, or only the "current" one? MVP:
  current only (most-recent). Add `/use <room-slug>` to switch.
- **Rate limiting.** Telegram itself rate-limits bots (30 msg/sec
  global, 1/sec per chat). The webhook side could use the existing
  Workers Rate Limiting binding pattern (new `TG_RL` binding keyed
  by `from.id`) — 30 commands/min is generous.
- **Error visibility.** When a handler throws, the user gets a
  generic "something broke" reply but the full error needs to land
  in `wrangler tail`. Same shape as the global `onError`.

## Stretch

- **Nightly check-in DM.** Cron sends "you're DAY 03 of Anthrocon;
  status is still 'panels' from 5 hours ago — still accurate?" with
  inline keyboard buttons. Quality-of-life, zero new endpoints.
- **Status-change notifications to roommates.** Opt-in via
  `/notify on`. When someone in your room changes status, you get a
  one-line DM. Heads-up: this is a real privacy lever — make sure
  the recipient's `field_visibility.status` ≥ the source's tier.
- **`/help`** — autogenerated from the dispatch table.

## When to revisit

Build Tier 1 once the web `/login` page exists (the bot can't
onboard new users until the Login Widget is reachable). Until then,
this PLAN is a parking spot.
