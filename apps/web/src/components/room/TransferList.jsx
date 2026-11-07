import { useEffect, useState } from 'react';
import { TransferStatus, isMovingStatus } from '../../services/transfer/transfer-manager.js';
import { TransferItem } from './TransferItem.jsx';

/** Re-renders once a second while something is moving, so speed and time-left stay current. */
function useTicker(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

export function TransferList({ transfers, onCancel }) {
  const visible = transfers.filter((t) => t.status !== TransferStatus.OFFERED);
  useTicker(visible.some((t) => isMovingStatus(t.status)));

  if (visible.length === 0) {
    return <p className="empty-state">Files you send or receive will show up here.</p>;
  }
  const ordered = [...visible].reverse(); // newest first
  return (
    <section aria-label="Transfers">
      <h2 className="section-title">Transfers</h2>
      <ul className="transfer-list">
        {ordered.map((transfer) => (
          <TransferItem key={transfer.id} transfer={transfer} onCancel={onCancel} />
        ))}
      </ul>
    </section>
  );
}
