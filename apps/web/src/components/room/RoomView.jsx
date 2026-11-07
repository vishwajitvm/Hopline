import { SaveLocation } from '../../services/storage/sinks.js';
import { TransferStatus } from '../../services/transfer/transfer-manager.js';
import { Phase } from '../../state/session-reducer.js';
import { ConnectionBadge } from './ConnectionBadge.jsx';
import { Dropzone } from './Dropzone.jsx';
import { IncomingOffers } from './IncomingOffers.jsx';
import { ReconnectBanner } from './ReconnectBanner.jsx';
import { SafetyCode } from './SafetyCode.jsx';
import { ShareCard } from './ShareCard.jsx';
import { StatusBadge } from './StatusBadge.jsx';
import { TransferList } from './TransferList.jsx';

const LEAVE_WARNING =
  'Files you received but haven’t saved yet will be deleted, and any transfer in progress will stop. Leave anyway?';

export function RoomView({ session }) {
  const { phase, code, notice, transfers, connection, safetyCode, peerOnline, serverOnline } = session;
  const ended = phase === Phase.ENDED;
  const inRoom = phase === Phase.CONNECTED || phase === Phase.RECONNECTING;

  const handleLeave = () => {
    const unsaved = transfers.some(
      (t) =>
        (t.direction === 'in' && t.status === TransferStatus.DONE && t.savedTo !== SaveLocation.FOLDER) ||
        t.status === TransferStatus.SENDING ||
        t.status === TransferStatus.RECEIVING,
    );
    if (unsaved && !window.confirm(LEAVE_WARNING)) return;
    session.leave();
  };

  return (
    <section className="room">
      <div className="room-bar">
        <StatusBadge phase={phase} />
        {code && (
          <span className="room-code-label">
            Room <code>{code}</code>
          </span>
        )}
        {phase === Phase.CONNECTED && <ConnectionBadge connection={connection} />}
        <button type="button" className="btn btn-ghost" onClick={handleLeave}>
          {ended ? 'Start over' : 'Leave'}
        </button>
      </div>

      {phase === Phase.CONNECTED && <SafetyCode code={safetyCode} />}
      {phase === Phase.RECONNECTING && (
        <ReconnectBanner peerOnline={peerOnline} serverOnline={serverOnline} />
      )}
      {notice && !ended && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}

      {phase === Phase.WAITING && <ShareCard code={code} />}

      {phase === Phase.CONNECTING && (
        <div className="card card-center">
          <span className="spinner" aria-hidden="true" />
          <p>Opening a secure connection…</p>
          <p className="muted">Across continents or strict networks this can take a few seconds.</p>
        </div>
      )}

      {inRoom && (
        <IncomingOffers
          transfers={transfers}
          onAccept={session.acceptOffer}
          onDecline={session.declineOffer}
        />
      )}
      {inRoom && <Dropzone onFiles={session.sendFiles} disabled={phase === Phase.RECONNECTING} />}

      {ended && notice && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}

      {(inRoom || transfers.length > 0) && (
        <TransferList transfers={transfers} onCancel={session.cancelTransfer} />
      )}
    </section>
  );
}
