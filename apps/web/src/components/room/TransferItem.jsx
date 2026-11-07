import { memo } from 'react';
import { SaveLocation, nativeBridge } from '../../services/storage/sinks.js';
import {
  TransferStatus as S,
  isActiveStatus,
  isMovingStatus,
} from '../../services/transfer/transfer-manager.js';
import { formatBytes, formatDuration } from '../../utils/format.js';
import { Icon } from '../common/Icon.jsx';

function progressPercent({ bytes, size, status }) {
  if (status === S.DONE) return 100;
  if (!size) return 0;
  return Math.min(100, Math.floor((bytes / size) * 100));
}

/** Speed since the transfer last (re)started, so a pause for reconnecting doesn't drag the average down. */
function bytesPerSecond({ bytes, segmentStartedAt, segmentStartBytes }) {
  if (!segmentStartedAt) return 0;
  const seconds = (Date.now() - segmentStartedAt) / 1000;
  return seconds > 1 ? (bytes - segmentStartBytes) / seconds : 0;
}

function statusLabel(t) {
  const out = t.direction === 'out';
  switch (t.status) {
    case S.AWAITING:
      return 'Waiting for them to accept';
    case S.OFFERED:
      return 'Waiting for you to accept';
    case S.QUEUED:
      return t.bytes > 0 ? 'Paused — resuming' : 'Queued';
    case S.SENDING:
      return 'Sending';
    case S.RECEIVING:
      return 'Receiving';
    case S.VERIFYING:
      return out ? 'Verifying on their device' : 'Verifying';
    case S.DONE:
      if (out) return 'Delivered';
      return t.savedTo === SaveLocation.FOLDER
        ? `Saved to your folder as ${t.savedAs ?? t.path}`
        : 'Received';
    case S.FAILED:
      return t.error ? `Failed: ${t.error}` : 'Failed';
    case S.CANCELLED:
      return 'Cancelled';
    case S.DECLINED:
      return 'Declined';
    default:
      return t.status;
  }
}

/** Memoized: snapshots keep their identity until the transfer changes, so idle rows don't re-render. */
export const TransferItem = memo(function TransferItem({ transfer: t, onCancel }) {
  const percent = progressPercent(t);
  const moving = isMovingStatus(t.status);
  const speed = moving ? bytesPerSecond(t) : 0;
  const eta = speed > 0 ? (t.size - t.bytes) / speed : NaN;
  const showPreview = t.url && t.mime.startsWith('image/') && t.size < 50 * 1024 * 1024;
  const cancellable = isActiveStatus(t.status) && t.status !== S.OFFERED;
  const folderPath = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';

  return (
    <li className={`transfer transfer--${t.status}`}>
      <div className={`transfer-icon transfer-icon--${t.direction}`}>
        {showPreview ? <img src={t.url} alt="" /> : <Icon name={t.direction === 'out' ? 'up' : 'down'} />}
      </div>

      <div className="transfer-body">
        <div className="transfer-row">
          <span className="transfer-name" title={t.path}>
            {t.name}
            {folderPath && <span className="transfer-folder"> in {folderPath}</span>}
          </span>
          <span className="transfer-size">{formatBytes(t.size)}</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-label={`${t.name} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="progress-fill" style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
        <div className="transfer-row transfer-meta">
          <span className="transfer-status">
            {t.status === S.DONE && t.verified && (
              <span className="verified" title="SHA-256 checksum matched on both devices">
                <Icon name="shield" size={13} /> Verified
              </span>
            )}
            {statusLabel(t)}
            {t.via === 'direct' && moving && (
              <span
                className="direct-tag"
                title="Sent over a direct encrypted link between the two desktop apps"
              >
                <Icon name="bolt" size={12} /> Direct link
              </span>
            )}
          </span>
          {moving && (
            <span>
              {percent}%{speed > 0 && ` · ${formatBytes(speed)}/s`}
              {Number.isFinite(eta) && ` · ${formatDuration(eta)} left`}
            </span>
          )}
        </div>
      </div>

      <div className="transfer-actions">
        {t.folderId && t.status === S.DONE && nativeBridge() && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void nativeBridge().showItem(t.folderId, t.savedAs)}
          >
            Show
          </button>
        )}
        {t.url && t.status === S.DONE && (
          <a className="btn btn-small" href={t.url} download={t.name}>
            Save
          </a>
        )}
        {cancellable && (
          <button
            type="button"
            className="btn btn-small btn-ghost btn-icon"
            onClick={() => onCancel(t.id)}
            aria-label={`Cancel ${t.name}`}
            title="Cancel"
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </li>
  );
});
