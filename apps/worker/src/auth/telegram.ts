import type { TelegramLoginPayload } from '@con-sign/shared';
import { telegramLoginPayloadSchema } from '@con-sign/shared';

/**
 * Verify a Telegram Login Widget payload per
 * https://core.telegram.org/widgets/login#checking-authorization
 *
 * Returns the parsed payload on success, throws on tamper / expired auth.
 */
export async function verifyTelegramLogin(
  payload: unknown,
  botToken: string,
  now: number = Date.now(),
): Promise<TelegramLoginPayload> {
  const parsed = telegramLoginPayloadSchema.parse(payload);

  const { hash, ...fields } = parsed;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${(fields as Record<string, unknown>)[k]}`)
    .join('\n');

  // Per Telegram docs: secret_key = SHA-256(bot_token); HMAC-SHA-256 of the
  // data-check-string with that key, hex-encoded, must equal `hash`.
  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString)),
  );
  const expected = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');

  if (!constantTimeEqual(expected, hash)) {
    throw new TelegramAuthError('bad_hash');
  }

  // Reject auth_date older than 24h to limit replay window.
  const ageMs = now - parsed.auth_date * 1000;
  if (ageMs > 24 * 60 * 60 * 1000) throw new TelegramAuthError('expired');
  if (ageMs < -5 * 60 * 1000) throw new TelegramAuthError('future_dated');

  return parsed;
}

/** Stream-proxy a user's current Telegram profile photo. */
export async function fetchTelegramAvatar(
  tgUserId: number,
  botToken: string,
): Promise<Response | null> {
  // 1. Find the largest version of the most recent profile photo.
  const photosRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${tgUserId}&limit=1`,
  );
  if (!photosRes.ok) return null;
  const photos = (await photosRes.json()) as {
    ok: boolean;
    result?: { photos?: Array<Array<{ file_id: string; width: number; height: number }>> };
  };
  if (!photos.ok || !photos.result?.photos?.[0]?.length) return null;
  const variants = photos.result.photos[0];
  const largest = variants.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));

  // 2. Resolve file_id → file_path.
  const fileRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(largest.file_id)}`,
  );
  if (!fileRes.ok) return null;
  const file = (await fileRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };
  if (!file.ok || !file.result?.file_path) return null;

  // 3. Stream the file. Bot file URLs include the bot token — we never expose
  // this URL to clients; we proxy the bytes ourselves.
  const dl = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${file.result.file_path}`,
  );
  if (!dl.ok || !dl.body) return null;

  return new Response(dl.body, {
    headers: {
      'Content-Type': dl.headers.get('Content-Type') ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export class TelegramAuthError extends Error {
  constructor(public readonly reason: 'bad_hash' | 'expired' | 'future_dated') {
    super(reason);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
