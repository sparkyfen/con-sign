/**
 * Translate con-sign's internal device state into the JSON envelope that
 * TRMNL's stock firmware expects from `/api/display`.
 *
 * Reference: TRMNL's BYOS contract — the device polls with an
 * `Access-Token` header and expects back a JSON document containing
 * (at minimum) the URL of the image to render and how long to sleep
 * before polling again.
 *
 * We resolve `image_url` to our generic `/api/device/sign.png` endpoint
 * with the device's UUID as the `?d=` bearer + `fmt=png` so the device
 * gets a real raster image. That keeps the underlying state machine
 * (unpaired / paired / revoked) in exactly one place.
 *
 * The `filename` field is what TRMNL caches against locally; mixing the
 * device id + the current minute so identical content doesn't redownload
 * but stale content (5-min OTP rotation, status changes) does.
 */

import { nextRefreshSec, type ConDates } from './refresh-policy.js';

export interface TrmnlDisplayEnvelope {
  filename: string;
  image_url: string;
  refresh_rate: number;
  reset_firmware?: boolean;
  update_firmware?: boolean;
  firmware_url?: string;
  special_function?: string;
}

export interface BuildEnvelopeArgs {
  deviceId: string;
  /** Absolute URL of the worker. Used to construct image_url. */
  origin: string;
  /** The room's con dates, if the device is paired to a room. */
  con: ConDates | null;
  /** When this poll happened. Injected for testability. */
  now?: Date;
  /** Panel native resolution. Defaults to 800×480 (TRMNL 7.5"). */
  width?: number;
  height?: number;
}

export function buildDisplayEnvelope(args: BuildEnvelopeArgs): TrmnlDisplayEnvelope {
  const { deviceId, origin, con, width = 800, height = 480 } = args;
  const now = args.now ?? new Date();
  const refresh_rate = nextRefreshSec(con, now);

  // Filename is a cache-bust hint to the device. Bucket per refresh
  // window so identical content within the window dedupes, but a new
  // window forces a re-fetch.
  const bucket = Math.floor(now.getTime() / (refresh_rate * 1000));
  const filename = `sign-${deviceId.slice(0, 8)}-${bucket}.png`;

  const url = new URL('/api/device/sign.png', origin);
  url.searchParams.set('d', deviceId);
  url.searchParams.set('fmt', 'png');
  url.searchParams.set('w', String(width));
  url.searchParams.set('h', String(height));

  return {
    filename,
    image_url: url.toString(),
    refresh_rate,
  };
}
