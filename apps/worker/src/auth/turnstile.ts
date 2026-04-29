/**
 * Cloudflare Turnstile siteverify. Called when a slug has accumulated 3+
 * unlock failures — the next attempt must include a fresh Turnstile token.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string | undefined,
  secret: string,
  remoteip?: string,
): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteip) body.set('remoteip', remoteip);
  const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
  if (!res.ok) return false;
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}
