import QRCode from 'qrcode';
import type { PasscodeIssued } from '@con-sign/shared';

/**
 * Build the share URL + QR data URL for a freshly-issued roommate passcode.
 * The passcode lives in the URL fragment (`#k=...`) so it's never sent to
 * any server other than the page the user navigates to — the visitor app's
 * JS reads the fragment and POSTs it to /unlock.
 */
export async function buildShareArtifacts(args: {
  origin: string;
  qrSlug: string;
  passcode: string;
}): Promise<PasscodeIssued> {
  const shareUrl = `${args.origin}/r/${args.qrSlug}#k=${encodeURIComponent(args.passcode)}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 6,
  });
  return {
    passcode: args.passcode,
    shareUrl,
    qrDataUrl,
  };
}
