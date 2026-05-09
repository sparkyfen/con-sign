import QRCode from 'qrcode';
import type { PasscodeIssued } from '@con-sign/shared';

/**
 * Build the share URL + QR data URL for a freshly-issued roommate passcode.
 * The passcode lives in the URL fragment (`#k=...`) so it's never sent to
 * any server other than the page the user navigates to — the visitor app's
 * JS reads the fragment and POSTs it to /unlock.
 *
 * QR is emitted as an SVG data URL. `qrcode.toDataURL`'s PNG path resolves
 * to the package's browser entrypoint inside the Worker runtime and tries
 * to draw to a `<canvas>` element that doesn't exist; `toString({type:'svg'})`
 * is a pure string render with no DOM dependency. The frontend can stick
 * the data URL straight into an `<img src>` either way.
 */
export async function buildShareArtifacts(args: {
  origin: string;
  qrSlug: string;
  passcode: string;
}): Promise<PasscodeIssued> {
  const shareUrl = `${args.origin}/r/${args.qrSlug}#k=${encodeURIComponent(args.passcode)}`;
  const svg = await QRCode.toString(shareUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
  });
  const qrDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return {
    passcode: args.passcode,
    shareUrl,
    qrDataUrl,
  };
}
