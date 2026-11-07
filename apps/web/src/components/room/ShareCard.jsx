import { useMemo } from 'react';
import { isLoopbackHost } from '../../config/runtime.js';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard.js';
import { buildInviteLink } from '../../hooks/useInviteLink.js';
import { useQrCode } from '../../hooks/useQrCode.js';

export function ShareCard({ code }) {
  const inviteLink = useMemo(() => buildInviteLink(code), [code]);
  const qrCode = useQrCode(inviteLink);
  const [copied, copy] = useCopyToClipboard();

  return (
    <div className="card share-card">
      <div className="share-details">
        <p className="eyebrow">Your room code</p>
        <p className="room-code" aria-label={`Room code ${code.split('').join(' ')}`}>
          {code}
        </p>
        <p className="muted">
          On the other device, open Hopline and enter this code{qrCode ? ', or scan the QR code' : ''}.
        </p>
        {inviteLink && (
          <button type="button" className="btn" onClick={() => copy(inviteLink)}>
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
        )}
        {inviteLink && isLoopbackHost() && (
          <p className="hint">
            Scanning from a phone? Open Hopline using this computer’s network address (printed when the server
            starts) so the link works on other devices.
          </p>
        )}
      </div>
      {qrCode && (
        <img className="qr-code" src={qrCode} alt="QR code that opens this room" width="220" height="220" />
      )}
    </div>
  );
}
