import { Emitter } from '../../utils/emitter.js';

export const TransferStatus = Object.freeze({
  AWAITING: 'awaiting', // outgoing: waiting for the other person to accept
  OFFERED: 'offered', // incoming: waiting for my decision
  QUEUED: 'queued',
  SENDING: 'sending',
  RECEIVING: 'receiving',
  VERIFYING: 'verifying', // checksum + final write
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  DECLINED: 'declined',
});

const ACTIVE = new Set([
  TransferStatus.AWAITING,
  TransferStatus.OFFERED,
  TransferStatus.QUEUED,
  TransferStatus.SENDING,
  TransferStatus.RECEIVING,
  TransferStatus.VERIFYING,
]);

export const isActiveStatus = (status) => ACTIVE.has(status);
export const isMovingStatus = (status) =>
  status === TransferStatus.SENDING || status === TransferStatus.RECEIVING;

const NOTIFY_INTERVAL_MS = 100;

/**
 * Holds every transfer row and publishes immutable snapshots for the UI.
 * Updates are coalesced (at most one 'change' per 100 ms unless `immediate`), and a row's snapshot
 * object is reused until that row changes — so memoized list items skip re-rendering.
 */
export class TransferStore extends Emitter {
  #rows = new Map();
  #snapshots = new Map();
  #timer = null;

  create(fields) {
    const row = {
      bytes: 0,
      startedAt: 0,
      finishedAt: 0,
      segmentStartedAt: 0,
      segmentStartBytes: 0,
      verified: null,
      error: null,
      url: null,
      savedTo: null,
      savedAs: null,
      version: 0,
      ...fields,
    };
    this.#rows.set(row.id, row);
    return row;
  }

  get(id) {
    return this.#rows.get(id);
  }

  values() {
    return this.#rows.values();
  }

  update(row, fields, immediate = false) {
    // A finished row (done, failed, cancelled, declined) is final: late async work can't revive it.
    if (fields.status !== undefined && !ACTIVE.has(row.status) && ACTIVE.has(fields.status)) return;
    Object.assign(row, fields);
    row.version++;
    this.notify(immediate);
  }

  get snapshot() {
    return Array.from(this.#rows.values(), (row) => {
      const cached = this.#snapshots.get(row.id);
      if (cached && cached.version === row.version) return cached;
      const fresh = Object.freeze({ ...row });
      this.#snapshots.set(row.id, fresh);
      return fresh;
    });
  }

  notify(immediate = false) {
    if (immediate) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.emit('change', this.snapshot);
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.emit('change', this.snapshot);
    }, NOTIFY_INTERVAL_MS);
  }

  dispose() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.removeAllListeners();
  }
}
