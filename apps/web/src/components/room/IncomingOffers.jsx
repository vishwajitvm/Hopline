import { useEffect, useMemo, useState } from 'react';
import { TransferStatus } from '../../services/transfer/transfer-manager.js';
import {
  availableBrowserStorage,
  canChooseFolder,
  canUseBrowserStorage,
  nativeBridge,
} from '../../services/storage/sinks.js';
import { formatBytes } from '../../utils/format.js';
import { Icon } from '../common/Icon.jsx';

const PREVIEW = 4;
const LARGE_FOR_MEMORY = 1024 ** 3; // 1 GiB

/** Groups incoming rows that still need a decision into one card per offer. */
function pendingOffers(transfers) {
  const byBatch = new Map();
  for (const row of transfers) {
    if (row.direction !== 'in' || row.status !== TransferStatus.OFFERED) continue;
    if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
    byBatch.get(row.batchId).push(row);
  }
  return [...byBatch].map(([batchId, files]) => ({
    batchId,
    files,
    total: files.reduce((sum, f) => sum + f.size, 0),
  }));
}

export function IncomingOffers({ transfers, onAccept, onDecline }) {
  const offers = useMemo(() => pendingOffers(transfers), [transfers]);
  if (offers.length === 0) return null;
  return (
    <div className="offers">
      {offers.map((offer) => (
        <OfferCard key={offer.batchId} offer={offer} onAccept={onAccept} onDecline={onDecline} />
      ))}
    </div>
  );
}

function OfferCard({ offer, onAccept, onDecline }) {
  const { batchId, files, total } = offer;
  // The desktop app saves straight to disk through the main process (no browser storage involved).
  const desktop = Boolean(nativeBridge());
  const folderSupported = desktop || canChooseFolder();
  const browserStorage = !desktop && canUseBrowserStorage();
  const [free, setFree] = useState(null);

  useEffect(() => {
    if (!browserStorage) return undefined;
    let active = true;
    availableBrowserStorage().then((bytes) => active && setFree(bytes));
    return () => {
      active = false;
    };
  }, [browserStorage]);

  const tooBigForBrowser = browserStorage && free !== null && total > free;
  const memoryWarning = !desktop && !browserStorage && total > LARGE_FOR_MEMORY;

  return (
    <article className="card offer" aria-label="Incoming files">
      <div className="offer-head">
        <Icon name="down" />
        <div>
          <h2>
            Incoming: {files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(total)}
          </h2>
          <ul className="offer-files">
            {files.slice(0, PREVIEW).map((file) => (
              <li key={file.id} title={file.path}>
                {file.path} <span className="muted">({formatBytes(file.size)})</span>
              </li>
            ))}
            {files.length > PREVIEW && <li className="muted">…and {files.length - PREVIEW} more</li>}
          </ul>
        </div>
      </div>

      <div className="offer-actions">
        {folderSupported && (
          <button type="button" className="btn btn-primary" onClick={() => onAccept(batchId, 'folder')}>
            <Icon name="folder" size={16} /> Save to a folder…
          </button>
        )}
        {!(tooBigForBrowser && folderSupported) && (
          <button
            type="button"
            className={folderSupported ? 'btn' : 'btn btn-primary'}
            onClick={() => onAccept(batchId, 'browser')}
          >
            Accept
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => onDecline(batchId)}>
          Decline
        </button>
      </div>

      {desktop && (
        <p className="hint">
          “Accept” saves them to Downloads › Hopline (date). Between two Hopline desktop apps on the same
          network, files take a direct link at full disk and network speed.
        </p>
      )}
      {folderSupported && !desktop && (
        <p className="hint">
          “Save to a folder” writes files straight to your disk — best for large transfers. “Accept” keeps
          them in this browser until you click Save.
        </p>
      )}
      {tooBigForBrowser && (
        <p className="hint hint--warning">
          This is more than the {formatBytes(free)} this browser can store.{' '}
          {folderSupported ? 'Save to a folder instead.' : 'Free up disk space or use the desktop app.'}
        </p>
      )}
      {memoryWarning && (
        <p className="hint hint--warning">
          This browser will hold these files in memory, which may fail for very large files. For big
          transfers, use Chrome or Edge over HTTPS, or the Hopline desktop app.
        </p>
      )}
    </article>
  );
}
