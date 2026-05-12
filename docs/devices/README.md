# Supported devices

con-sign treats the e-ink panel as a dumb HTTP client: it fetches an
image (currently SVG, soon also PNG/BMP), shows it, sleeps, repeats.
That keeps the firmware side simple and lets us support many panels
without per-device backend changes.

This directory holds device-specific design notes and setup
instructions. Each subdir owns one device family.

## Currently planned

| Device | Status | Plan |
|---|---|---|
| TRMNL (7.5", 800×480) | Plan drafted, no code | [`trmnl/PLAN.md`](./trmnl/PLAN.md) |

## Probably later (no plan yet)

- ESP32 boards (Seeed XIAO ePaper, Inkplate, M5Paper) — needs firmware
- Raspberry Pi Zero 2 W + Waveshare HAT — small Python daemon
- Android tablet kiosk — overkill but cheap on the used market

## Adding a new device

1. Create `docs/devices/<name>/PLAN.md` (mirror `trmnl/PLAN.md`'s
   structure: goal, image format, auth model, decision log, open
   questions).
2. If backend work is needed for that device specifically (custom
   endpoints, new bindings), it lands under
   `apps/worker/src/routes/devices/<name>.ts` so the scoping is
   obvious. Generic device behaviour stays in `routes/device.ts`.
3. If firmware is needed (currently zero devices), add it under a new
   top-level `firmware/<name>/` directory rather than inside this
   repo's existing pnpm workspace — toolchains don't mix cleanly.
4. Once the device pairs end-to-end with a real unit, write a
   `SETUP.md` next to the PLAN documenting the steps a user follows
   to provision their own.

## Shared infrastructure

The bits every device leans on:

- `GET /api/device/sign.png` — single route, dispatches on the
  device's state (unpaired with OTP / paired / revoked).
- Render pipeline at `apps/worker/src/render/` — SVG today; PNG and
  1-bit BMP land alongside as soon as a device needs them.
- Pair-code OTP from `apps/worker/src/auth/pair-code.ts`.
- Audit log writes on every claim/revoke.

Device-specific protocol adapters (BYOS endpoints, manufacturer
heartbeat formats) sit on top of those, never inside them.
