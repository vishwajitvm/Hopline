import { useEffect } from 'react';
import { TransferStatus } from '../services/transfer/transfer-manager.js';

const BUSY = new Set([
  TransferStatus.QUEUED,
  TransferStatus.SENDING,
  TransferStatus.RECEIVING,
  TransferStatus.VERIFYING,
]);

/**
 * While files are moving:
 *  - warns before the tab is closed or reloaded (which would stop the transfer), and
 *  - keeps the screen awake (where the Wake Lock API is available), because a sleeping laptop or phone
 *    drops the connection mid-transfer.
 */
export function useTransferGuards(transfers) {
  const busy = transfers.some((t) => BUSY.has(t.status));

  useEffect(() => {
    if (!busy) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  useEffect(() => {
    if (!busy || !navigator.wakeLock) return undefined;
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const acquired = await navigator.wakeLock.request('screen');
        // The browser drops the lock whenever the page is hidden; forget it then so we take it again on return.
        acquired.addEventListener('release', () => {
          if (lock === acquired) lock = null;
        });
        lock = acquired;
        if (cancelled) await acquired.release();
      } catch {
        lock = null; // not allowed (e.g. battery saver) — transfers still work
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !lock) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [busy]);
}
