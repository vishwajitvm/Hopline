import { DATA_PROTOCOL_VERSION, TransferLimits, TransferMessage } from '@hopline/protocol';
import { Emitter } from '../../utils/emitter.js';
import { createId } from '../../utils/id.js';
import { baseName, safeMimeType, toSafePath } from '../../utils/paths.js';
import { createSha256, hashBlobRange } from '../crypto/sha256.js';
import { SaveLocation, createSink as defaultCreateSink } from '../storage/sinks.js';
import { ChannelPort } from './channel-port.js';
import { CancelledError, ChannelLostError, StoppedError } from './errors.js';
import { decodeFrame, encodeFrame } from './frames.js';
import { TransferStatus as S, TransferStore, isActiveStatus } from './transfer-store.js';

export { TransferStatus, isActiveStatus, isMovingStatus } from './transfer-store.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PENDING_OFFERS = 20;
const MAX_INCOMING_FILES = 50_000;
const MAX_SLOT = 2 ** 32 - 1;
/** Distinct not-yet-started slots we hold early frames for (a lane can overtake the main channel). */
const MAX_EARLY_SLOTS = 4096;
/** Each lane may buffer at least this much, however many lanes share HIGH_WATER_BYTES. */
const MIN_LANE_HIGH_WATER = 2 * 1024 * 1024;
/**
 * Bookkeeping cost charged per held (out-of-order or early) frame on top of its payload, so a peer can't
 * exhaust memory with millions of 1-byte frames that look small by byte count.
 */
const HELD_FRAME_OVERHEAD = 1024;
/** Prune a lane's in-flight records once this many accumulate (~512 are live at a 32 MiB window). */
const LANE_RECORDS_PRUNE_AT = 2048;
const TERMINAL = new Set([S.DONE, S.FAILED, S.CANCELLED, S.DECLINED]);
const KNOWN_TYPES = new Set(Object.values(TransferMessage).filter((type) => typeof type === 'string'));
const FLOODED = 'The other device sent data faster than allowed, so the connection was closed.';
const isTerminal = (status) => TERMINAL.has(status);
const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isSlot = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_SLOT;
const isByteCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
/** How long a sender waits for the receiver to answer a direct-mode request before using WebRTC. */
const DIRECT_REPLY_TIMEOUT_MS = 10_000;
const shortText = (value, fallback) => (typeof value === 'string' && value ? value.slice(0, 200) : fallback);

/**
 * Sends and receives files over WebRTC data channels (protocol: @hopline/protocol/transfer).
 *
 * Lives for the whole session and survives reconnects: `detach()` when the main channel drops,
 * `attach(channel)` with the replacement. Partially sent files continue from the last byte the receiver
 * confirmed was written.
 *
 *  - Speed: file frames are spread over the main channel plus extra "lanes" (`addLane`), each a separate
 *    connection with its own congestion control. The busiest lane gets the fewest frames.
 *  - Nothing lost: frames carry their offset; the receiver reorders them and hashes/writes strictly in order.
 *    When a lane closes, every frame it carried that isn't confirmed written is sent again on another lane.
 *  - Consent: incoming batches wait for accept()/decline() before any byte is stored.
 *  - Flow control: at most WINDOW_BYTES (all files, all lanes) beyond what the receiver has durably written.
 *  - Integrity: every file is SHA-256 hashed on both ends and verified before it's committed.
 *  - Untrusted input: every field from the peer is validated; names become safe relative paths.
 *
 * Emits 'change' with immutable transfer snapshots, 'offer' (batchId) for new incoming batches,
 * 'lanes' (count of open data channels), and 'stopped' (reason) when it had to end the session itself
 * (incompatible peer, protocol abuse), so the UI can say so instead of looking connected.
 */
export class TransferManager extends Emitter {
  #limits;
  #createSink;
  #createHasher;
  #store = new TransferStore();
  #port;
  #mainLane;
  /** Extra lanes by channel: { channel, records: [{ job, slot, offset, length }], listeners } */
  #lanes = new Map();
  /** Bumped whenever the main channel changes; a send loop from an older epoch stops instead of sending. */
  #epoch = 0;
  #signalWaiters = [];

  /** Outgoing: id → { row, file, resumeOffset, sent, acked, cancelled, slot } */
  #jobs = new Map();
  #sendQueue = [];
  #pumping = false;
  #nextSlot = 0;
  /** Jobs that may have bytes sent but not yet confirmed written (they count against the window). */
  #inFlight = new Set();
  /** Frames to send again because the lane carrying them closed. */
  #retransmits = [];
  #retransmitting = false;

  /** batchId → { direction, rowIds, accept: null | boolean, destination } */
  #batches = new Map();

  /** Incoming in progress: sender's id → entry (see #openIncoming) */
  #incoming = new Map();
  /** Incoming row id by the sender's id. */
  #incomingRows = new Map();
  /** Finished incoming files (reported in SYNC so a reconnecting sender doesn't resend them). */
  #completed = new Map();
  /** Incoming files receiving right now, by the slot of their `start`. */
  #slots = new Map();
  #maxSlot = -1;
  /** slot → { frames, bytes }: frames that arrived before their `start`. */
  #early = new Map();
  #earlyBytes = 0;

  #inbox = [];
  #inboxHead = 0;
  #inboxBytes = 0;
  #draining = false;

  #synced = false;
  #peerSync = null;
  #stopped = false;
  /** Random id of this page's manager; a different one in the peer's SYNC means the other page reloaded. */
  #instance = createId();
  #peerInstance = null;

  /** Direct mode bridge (desktop app only, else null) and what we know about the peer's support. */
  #direct;
  #peerDirect = false;
  #directDisabled = false;
  /** Receiving: incoming files currently arriving over a direct link (sender's id → row). */
  #directIn = new Map();
  /** Sending: id → resolve, for the receiver's direct-ready answer. */
  #directReplies = new Map();
  #unsubscribeDirect = null;

  constructor({
    limits = TransferLimits,
    createSink = defaultCreateSink,
    createHasher = createSha256,
    direct = null,
  } = {}) {
    super();
    this.#limits = limits;
    this.#createSink = createSink;
    this.#createHasher = createHasher;
    this.#direct = direct;
    this.#unsubscribeDirect = direct?.onEvent((event) => this.#onDirectEvent(event)) ?? null;
    const port = new ChannelPort({ lowWaterBytes: limits.LOW_WATER_BYTES });
    port.on('message', (data) => this.#enqueue(data));
    port.on('drain', () => this.#signal());
    this.#port = port;
    this.#mainLane = {
      main: true,
      get isOpen() {
        return port.isOpen;
      },
      get bufferedAmount() {
        return port.bufferedAmount;
      },
    };
    this.#store.on('change', (snapshot) => this.emit('change', snapshot));
    this.#resetPeerSync();
  }

  get snapshot() {
    return this.#store.snapshot;
  }

  get hasActiveTransfers() {
    for (const row of this.#store.values()) if (isActiveStatus(row.status)) return true;
    return false;
  }

  /** Open data channels carrying file data (main + lanes). */
  get laneCount() {
    return this.#port.isOpen ? 1 + this.#lanes.size : 0;
  }

  /** A snapshot of internal state for troubleshooting (opt-in debug tools only). */
  diagnostics() {
    return {
      stopped: this.#stopped,
      synced: this.#synced,
      epoch: this.#epoch,
      mainBuffered: this.#port.bufferedAmount,
      lanes: [...this.#lanes.values()].map((l) => ({
        state: l.channel.readyState,
        buffered: l.bufferedAmount,
        records: l.records.length,
      })),
      unacked: this.#unackedBytes(),
      retransmits: this.#retransmits.length,
      retransmitting: this.#retransmitting,
      sendQueue: this.#sendQueue.length,
      inbox: this.#inbox.length - this.#inboxHead,
      inboxBytes: this.#inboxBytes,
      draining: this.#draining,
      maxSlot: this.#maxSlot,
      earlyBytes: this.#earlyBytes,
      incoming: [...this.#incoming.values()].map((e) => ({
        slot: e.slot,
        received: e.received,
        written: e.sink.bytesWritten,
        reorder: e.reorder.size,
        expectedSha: e.expectedSha !== null,
      })),
    };
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  /** Starts (or resumes) work on an open main data channel. */
  attach(channel) {
    if (this.#stopped) return;
    this.#resetConnection();
    this.#port.attach(channel);
    this.#resetPeerSync();
    void this.#sendSync();
    this.emit('lanes', this.laneCount);
  }

  /** The main channel dropped: pause everything, keep all progress. */
  detach() {
    this.#port.detach();
    this.#resetConnection();
    this.#resetPeerSync();
    this.#store.notify(true);
    this.emit('lanes', this.laneCount);
  }

  /** Adds an extra open data channel for file frames (it belongs to the current main connection). */
  addLane(channel) {
    if (this.#lanes.has(channel)) return false;
    if (
      this.#stopped ||
      !this.#port.isOpen ||
      channel.readyState !== 'open' ||
      this.#lanes.size >= this.#limits.MAX_LANES - 1
    ) {
      // Close it: a lane only one side uses would swallow the other side's frames.
      channel.close();
      return false;
    }
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.#limits.LOW_WATER_BYTES;
    const lane = {
      main: false,
      channel,
      records: [],
      get isOpen() {
        return channel.readyState === 'open';
      },
      get bufferedAmount() {
        return channel.bufferedAmount;
      },
      listeners: {
        // Lanes carry only frames; control messages must stay on the main channel to keep their order.
        message: (event) => typeof event.data !== 'string' && this.#enqueue(event.data),
        bufferedamountlow: () => this.#signal(),
        close: () => this.removeLane(channel),
        error: () => this.removeLane(channel),
      },
    };
    for (const [type, fn] of Object.entries(lane.listeners)) channel.addEventListener(type, fn);
    this.#lanes.set(channel, lane);
    this.#signal();
    this.emit('lanes', this.laneCount);
    return true;
  }

  /** A lane closed: whatever it carried that isn't confirmed is sent again on the others. */
  removeLane(channel) {
    const lane = this.#lanes.get(channel);
    if (lane) this.#dropLane(lane, true);
  }

  /** Ends the session for good. Finished files stay available to save. */
  stop(reason = 'The connection was closed.') {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#port.detach();
    this.#retransmits = [];
    for (const lane of [...this.#lanes.values()]) this.#dropLane(lane, false);
    this.#peerSync.reject(new StoppedError(reason));
    for (const entry of this.#incoming.values()) void entry.sink.abort();
    this.#incoming.clear();
    this.#slots.clear();
    this.#early.clear();
    this.#directIn.clear();
    for (const resolve of this.#directReplies.values()) resolve(null);
    this.#directReplies.clear();
    void this.#direct?.reset().catch(() => {});
    this.#unsubscribeDirect?.();
    this.#unsubscribeDirect = null;
    this.#signal();
    for (const row of this.#store.values()) {
      if (isActiveStatus(row.status))
        this.#store.update(row, { status: S.FAILED, error: reason, finishedAt: Date.now() });
    }
    this.#store.notify(true);
  }

  /** Stops because of something the peer did, and tells the UI why. */
  #abort(reason) {
    if (this.#stopped) return;
    this.stop(reason);
    this.emit('stopped', reason);
  }

  /** Releases received files (object URLs). */
  dispose() {
    this.stop();
    for (const row of this.#store.values()) if (row.url) URL.revokeObjectURL(row.url);
    this.#store.dispose();
    this.removeAllListeners();
  }

  /** Forgets everything tied to the previous main connection (its lanes, in-flight frames, reorder buffers). */
  #resetConnection() {
    this.#epoch++;
    this.#retransmits = [];
    for (const lane of [...this.#lanes.values()]) this.#dropLane(lane, false);
    this.#inFlight.clear();
    // SYNC reports only contiguous bytes; the sender resends the rest under a new slot, so out-of-order data
    // from the old connection is useless now.
    for (const entry of this.#incoming.values()) this.#unmapSlot(entry);
    this.#early.clear();
    this.#earlyBytes = 0;
    this.#signal();
  }

  #dropLane(lane, requeue) {
    for (const [type, fn] of Object.entries(lane.listeners)) lane.channel.removeEventListener(type, fn);
    this.#lanes.delete(lane.channel);
    // Both sides must stop using it, or the peer keeps sending frames we no longer read.
    if (lane.channel.readyState === 'open' || lane.channel.readyState === 'connecting') lane.channel.close();
    if (requeue) for (const record of lane.records) if (this.#isLive(record)) this.#retransmits.push(record);
    lane.records = [];
    this.#signal();
    if (this.#retransmits.length > 0) void this.#runRetransmits();
    this.emit('lanes', this.laneCount);
  }

  // ── Wake-ups: lane drained, progress arrived, lane added/removed, cancel, stop, reconnect ──

  #signal() {
    const waiters = this.#signalWaiters;
    this.#signalWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #nextSignal() {
    return new Promise((resolve) => this.#signalWaiters.push(resolve));
  }

  // ── Public actions ──────────────────────────────────────────────────────

  /** Offers files to the peer. Items are File objects or { file, path } for files inside folders. */
  send(items) {
    if (this.#stopped || items.length === 0) return;
    const batchId = createId();
    const rowIds = [];
    for (const item of items.slice(0, this.#limits.MAX_FILES_PER_OFFER)) {
      const file = item instanceof Blob ? item : item.file;
      const path = toSafePath(item.path || file.webkitRelativePath || file.name, {
        maxSegmentLength: this.#limits.MAX_FILE_NAME_LENGTH,
      }).slice(0, this.#limits.MAX_PATH_LENGTH);
      const row = this.#store.create({
        id: createId(),
        direction: 'out',
        batchId,
        name: baseName(path),
        path,
        size: file.size,
        mime: typeof file.type === 'string' ? file.type.slice(0, 255) : '',
        status: S.AWAITING,
      });
      this.#jobs.set(row.id, {
        row,
        file,
        resumeOffset: 0,
        sent: 0,
        acked: 0,
        cancelled: false,
        slot: null,
        via: null,
      });
      rowIds.push(row.id);
    }
    this.#batches.set(batchId, { direction: 'out', rowIds, accept: null });
    this.#store.notify(true);
    if (this.#synced) this.#sendOffer(batchId);
  }

  /** Accepts an incoming batch. `destination` = { kind: 'folder', directory } | { kind: 'browser' }. */
  accept(batchId, destination = { kind: 'browser' }) {
    const batch = this.#batches.get(batchId);
    if (!batch || batch.direction !== 'in' || batch.accept !== null || this.#stopped) return;
    batch.accept = true;
    batch.destination = destination;
    for (const id of batch.rowIds) {
      const row = this.#store.get(id);
      if (row.status === S.OFFERED) this.#store.update(row, { status: S.QUEUED });
    }
    this.#port.trySendJson({ t: TransferMessage.ANSWER, batchId, accept: true });
    this.#store.notify(true);
  }

  decline(batchId) {
    const batch = this.#batches.get(batchId);
    if (!batch || batch.direction !== 'in' || batch.accept !== null) return;
    batch.accept = false;
    for (const id of batch.rowIds) {
      const row = this.#store.get(id);
      if (row.status === S.OFFERED) this.#store.update(row, { status: S.DECLINED, finishedAt: Date.now() });
    }
    this.#port.trySendJson({ t: TransferMessage.ANSWER, batchId, accept: false });
    this.#store.notify(true);
  }

  cancel(rowId) {
    const row = this.#store.get(rowId);
    if (!row || isTerminal(row.status)) return;
    if (row.direction === 'out') {
      const job = this.#jobs.get(rowId);
      job.cancelled = true;
      if (job.via === 'direct') this.#direct.cancel(rowId);
      this.#signal();
      this.#store.update(row, { status: S.CANCELLED, finishedAt: Date.now() }, true);
      this.#port.trySendJson({ t: TransferMessage.CANCEL, id: rowId });
    } else {
      this.#endIncoming(row.remoteId, { status: S.CANCELLED });
      this.#port.trySendJson({ t: TransferMessage.CANCEL, id: row.remoteId });
    }
  }

  // ── Sync (both directions) ──────────────────────────────────────────────

  #resetPeerSync() {
    this.#peerSync?.reject(new ChannelLostError());
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    this.#synced = false;
    this.#peerSync = { promise, resolve, reject };
  }

  /** Waits until the peer's SYNC arrived on the current channel. Survives channel swaps; throws when stopped. */
  async #whenSynced() {
    for (;;) {
      if (this.#stopped) throw new StoppedError();
      // The channel can be closing before its 'close' event (and our detach()) arrives. Treat that as
      // unsynced right away, or a sender would retry on a resolved promise in a tight loop.
      if (this.#synced && !this.#port.isOpen) this.#resetPeerSync();
      try {
        await this.#peerSync.promise;
        if (this.#port.isOpen) return;
      } catch (err) {
        if (!(err instanceof ChannelLostError)) throw err;
      }
    }
  }

  async #sendSync() {
    const channelAtStart = this.#peerSync;
    // Make sure every received byte is on disk, so the offsets we report are exact.
    for (const entry of this.#incoming.values()) {
      try {
        await entry.sink.flush();
      } catch (err) {
        this.#failIncoming(entry, `Could not save the file: ${err.message}`);
      }
    }
    if (this.#peerSync !== channelAtStart) return; // channel changed meanwhile; the new attach syncs
    const partial = [...this.#incoming].map(([id, entry]) => ({ id, offset: entry.received }));
    const done = [...this.#completed].map(([id, result]) => ({ id, ...result }));
    const decided = [...this.#batches]
      .filter(([, batch]) => batch.direction === 'in' && batch.accept !== null)
      .map(([batchId, batch]) => ({ batchId, accept: batch.accept }));
    this.#port.trySendJson({
      t: TransferMessage.SYNC,
      v: DATA_PROTOCOL_VERSION,
      instance: this.#instance,
      direct: Boolean(this.#direct),
      partial,
      done,
      decided,
    });
  }

  #onSync(msg) {
    if (msg.v !== DATA_PROTOCOL_VERSION) {
      this.#abort('The other device runs a different version of Hopline. Ask them to reload the page.');
      return;
    }
    const instance = isId(msg.instance) ? msg.instance : null;
    if (this.#peerInstance !== null && instance !== this.#peerInstance) this.#onPeerRestarted();
    this.#peerInstance = instance;
    this.#peerDirect = msg.direct === true;

    const partial = new Map();
    for (const p of Array.isArray(msg.partial) ? msg.partial : []) {
      if (isId(p?.id) && Number.isSafeInteger(p.offset) && p.offset >= 0) partial.set(p.id, p.offset);
    }
    const done = new Map();
    for (const d of Array.isArray(msg.done) ? msg.done : []) if (isId(d?.id)) done.set(d.id, d);
    for (const d of Array.isArray(msg.decided) ? msg.decided : []) {
      if (isId(d?.batchId) && typeof d.accept === 'boolean') this.#applyAnswer(d.batchId, d.accept);
    }

    // Reconcile outgoing files that were mid-flight when the previous channel dropped.
    const resume = [];
    for (const job of this.#jobs.values()) {
      const { row } = job;
      if (job.cancelled && partial.has(row.id))
        this.#port.trySendJson({ t: TransferMessage.CANCEL, id: row.id });
      if (row.status !== S.SENDING && row.status !== S.VERIFYING) continue;
      if (job.via === 'direct') continue; // its TCP link is independent of the WebRTC connection
      const result = done.get(row.id);
      if (result) {
        this.#finishOutgoing(job, result.ok === true, result.verified === true, result.error);
        continue;
      }
      const offset = Math.min(partial.get(row.id) ?? 0, row.size);
      job.resumeOffset = offset;
      job.sent = offset;
      job.acked = offset;
      job.slot = null;
      this.#store.update(row, { status: S.QUEUED, bytes: offset });
      resume.push(row.id);
    }
    this.#sendQueue.unshift(...resume);

    this.#synced = true;
    this.#peerSync.resolve();
    for (const [batchId, batch] of this.#batches) {
      if (batch.direction === 'out' && batch.accept === null) this.#sendOffer(batchId);
    }
    this.#store.notify(true);
    void this.#pump();
  }

  /**
   * The other page reloaded (or was replaced): it remembers nothing of our files.
   *  - Files it was sending us can never finish: they fail with a clear reason.
   *  - Files we were sending it (or it had accepted) are offered again, so it gets the approval prompt back.
   */
  #onPeerRestarted() {
    const reason = 'The other device reloaded the page, so this file stopped. Ask them to send it again.';
    this.#maxSlot = -1; // its slot numbers start over
    this.#early.clear();
    this.#earlyBytes = 0;
    const reoffer = new Set();
    for (const batch of this.#batches.values()) {
      for (const id of batch.rowIds) {
        const row = this.#store.get(id);
        if (!row || isTerminal(row.status)) continue;
        if (batch.direction === 'in') {
          this.#endIncoming(row.remoteId, { status: S.FAILED, error: reason });
          continue;
        }
        const job = this.#jobs.get(id);
        if (job.via === 'direct') this.#direct.cancel(id);
        Object.assign(job, { resumeOffset: 0, sent: 0, acked: 0, slot: null });
        this.#inFlight.delete(job);
        this.#store.update(row, { status: S.AWAITING, bytes: 0, startedAt: 0 });
        batch.accept = null;
        reoffer.add(id);
      }
    }
    this.#sendQueue = this.#sendQueue.filter((id) => !reoffer.has(id));
    this.#retransmits = [];
    this.#store.notify(true);
    // Undecided batches (now including these) are offered again right after this SYNC is applied.
  }

  // ── Inbox: every message is handled strictly in arrival order ───────────

  #enqueue(data) {
    // A well-behaved peer never has more than the flow-control window in flight. Far beyond that, it's
    // flooding us: stop instead of buffering without limit.
    this.#inboxBytes += typeof data === 'string' ? data.length : data.byteLength;
    if (this.#inboxBytes > this.#limits.WINDOW_BYTES * 4 || this.#inbox.length - this.#inboxHead > 100_000) {
      this.#abort(FLOODED);
      return;
    }
    this.#inbox.push({ data, epoch: this.#epoch });
    if (!this.#draining) void this.#drain();
  }

  /** Index-based queue: Array#shift is O(n) and would make long backlogs quadratic. */
  #nextInbound() {
    const item = this.#inbox[this.#inboxHead];
    const { data } = item;
    this.#inbox[this.#inboxHead++] = undefined;
    if (this.#inboxHead > 4096 && this.#inboxHead * 2 > this.#inbox.length) {
      this.#inbox = this.#inbox.slice(this.#inboxHead);
      this.#inboxHead = 0;
    }
    this.#inboxBytes -= typeof data === 'string' ? data.length : data.byteLength;
    return item;
  }

  async #drain() {
    this.#draining = true;
    try {
      while (this.#inboxHead < this.#inbox.length && !this.#stopped) {
        const { data, epoch } = this.#nextInbound();
        // From a connection that's gone: the resync already accounts for it, and handling it now could
        // move offsets past what SYNC just reported.
        if (epoch !== this.#epoch) continue;
        try {
          const pending = this.#handle(data);
          if (pending) await pending;
        } catch (err) {
          console.warn('[hopline] ignored a bad message from the peer', err);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #handle(data) {
    if (this.#stopped) return undefined;
    if (typeof data !== 'string') return this.#onFrame(data);
    if (data.length > this.#limits.MAX_CONTROL_MESSAGE_BYTES) return undefined;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return undefined;
    }
    // A message needs a known string type. (Never let a missing type meet a missing constant: with a stale
    // protocol module, `undefined === undefined` once made two peers answer each other forever.)
    if (msg === null || typeof msg !== 'object' || typeof msg.t !== 'string' || !KNOWN_TYPES.has(msg.t)) {
      return undefined;
    }
    switch (msg.t) {
      case TransferMessage.SYNC:
        return this.#onSync(msg);
      case TransferMessage.OFFER:
        return this.#onOffer(msg);
      case TransferMessage.ANSWER:
        return isId(msg.batchId) && typeof msg.accept === 'boolean'
          ? this.#applyAnswer(msg.batchId, msg.accept)
          : undefined;
      case TransferMessage.START:
        return this.#onStart(msg);
      case TransferMessage.END:
        return this.#onEnd(msg);
      case TransferMessage.PROGRESS:
        return this.#onProgress(msg);
      case TransferMessage.ACK:
        return this.#onAck(msg);
      case TransferMessage.CANCEL:
        return this.#onCancel(msg);
      case TransferMessage.DIRECT_REQUEST:
        return this.#onDirectRequest(msg);
      case TransferMessage.DIRECT_READY:
        return this.#onDirectReady(msg);
      default:
        return undefined;
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  #sendOffer(batchId) {
    const batch = this.#batches.get(batchId);
    const rows = batch.rowIds.map((id) => this.#store.get(id)).filter((row) => row.status === S.AWAITING);
    if (rows.length === 0) return;
    this.#port.trySendJson({
      t: TransferMessage.OFFER,
      batchId,
      files: rows.map(({ id, name, path, size, mime }) => ({ id, name, path, size, mime })),
      total: rows.reduce((sum, row) => sum + row.size, 0),
    });
  }

  #applyAnswer(batchId, accept) {
    const batch = this.#batches.get(batchId);
    if (!batch || batch.direction !== 'out' || batch.accept !== null) return;
    batch.accept = accept;
    for (const id of batch.rowIds) {
      const row = this.#store.get(id);
      if (row.status !== S.AWAITING) continue;
      if (accept) {
        this.#store.update(row, { status: S.QUEUED });
        this.#sendQueue.push(id);
      } else {
        this.#store.update(row, { status: S.DECLINED, finishedAt: Date.now() });
      }
    }
    this.#store.notify(true);
    if (accept) void this.#pump();
  }

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#stopped && this.#sendQueue.length > 0) {
        const job = this.#jobs.get(this.#sendQueue.shift());
        if (job && job.row.status === S.QUEUED && !job.cancelled) await this.#sendFile(job);
      }
    } catch (err) {
      if (!(err instanceof StoppedError)) console.warn('[hopline] sender stopped unexpectedly', err);
    } finally {
      this.#pumping = false;
    }
  }

  /** Sends one file, riding out reconnects: after each one it continues from the receiver's confirmed offset. */
  async #sendFile(job) {
    for (;;) {
      await this.#whenSynced();
      if (job.cancelled || job.row.status !== S.QUEUED) return;
      if (job.resumeOffset === 0 && (await this.#sendDirect(job))) return;
      if (job.cancelled || job.row.status !== S.QUEUED) return;
      try {
        await this.#streamFile(job, job.resumeOffset);
        return;
      } catch (err) {
        if (err instanceof ChannelLostError) {
          // Yield to the event loop before retrying (lets close/detach events through); #onSync then sets
          // resumeOffset for the next round.
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        if (err instanceof StoppedError) throw err;
        if (err instanceof CancelledError) return;
        this.#failOutgoing(job, shortText(err.message, 'Could not read the file.'));
        return;
      }
    }
  }

  // ── Direct mode (desktop ↔ desktop over TCP) ────────────────────────────

  /**
   * Tries to send a whole file over a direct TCP link. Returns true when the file is finished (sent, failed
   * or cancelled), false to send it over WebRTC instead (not both desktop apps, not reachable, link lost).
   */
  async #sendDirect(job) {
    if (!this.#direct || !this.#peerDirect || this.#directDisabled) return false;
    const { row } = job;
    job.fileToken ??= await this.#direct.fileToken(job.file).catch(() => null);
    if (!job.fileToken || job.cancelled || row.status !== S.QUEUED) return false;

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), DIRECT_REPLY_TIMEOUT_MS);
      this.#directReplies.set(row.id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      if (!this.#port.trySendJson({ t: TransferMessage.DIRECT_REQUEST, id: row.id })) resolve(null);
    });
    this.#directReplies.delete(row.id);
    if (!reply?.ok || job.cancelled || row.status !== S.QUEUED) return false;
    try {
      await this.#direct.connect(reply.link);
    } catch {
      // Not reachable directly (other network, firewall): stop trying for this session.
      this.#directDisabled = true;
      return false;
    }

    job.via = 'direct';
    const now = Date.now();
    this.#store.update(
      row,
      {
        status: S.SENDING,
        bytes: 0,
        startedAt: row.startedAt || now,
        segmentStartedAt: now,
        segmentStartBytes: 0,
        via: 'direct',
      },
      true,
    );
    let result;
    try {
      result = await this.#direct.send({ id: row.id, fileToken: job.fileToken, size: row.size });
    } catch {
      result = { lost: true };
    } finally {
      job.via = null;
    }
    if (row.status !== S.SENDING) return true; // cancelled, re-offered or stopped meanwhile
    if (result?.lost) {
      // The link died: send the whole file over WebRTC instead (its start cancels the receiver's direct copy).
      this.#directDisabled = true;
      this.#store.update(row, { status: S.QUEUED, bytes: 0, via: null }, true);
      return false;
    }
    if (result?.cancelled) {
      job.cancelled = true;
      this.#store.update(row, { status: S.CANCELLED, finishedAt: Date.now() }, true);
    } else {
      this.#finishOutgoing(job, result?.ok === true, result?.ok === true, result?.error);
    }
    return true;
  }

  #onDirectReady(msg) {
    if (!isId(msg.id)) return;
    const resolve = this.#directReplies.get(msg.id);
    if (!resolve) return;
    const link = msg.link;
    const valid =
      msg.ok === true &&
      link !== null &&
      typeof link === 'object' &&
      Number.isInteger(link.port) &&
      Array.isArray(link.addresses) &&
      link.addresses.length <= 16 &&
      link.addresses.every((a) => typeof a === 'string' && a.length <= 64) &&
      typeof link.key === 'string' &&
      link.key.length <= 64;
    resolve(valid ? { ok: true, link: { port: link.port, addresses: link.addresses, key: link.key } } : null);
  }

  /** The sender asks to deliver an accepted file over a direct link: listen and expect it, or say no. */
  async #onDirectRequest(msg) {
    if (!isId(msg.id)) return;
    const no = () => this.#port.trySendJson({ t: TransferMessage.DIRECT_READY, id: msg.id, ok: false });
    const row = this.#store.get(this.#incomingRows.get(msg.id));
    const batch = row && this.#batches.get(row.batchId);
    const destination = batch?.destination;
    if (
      !this.#direct ||
      !row ||
      batch.accept !== true ||
      row.status !== S.QUEUED ||
      destination?.kind !== 'native'
    ) {
      no();
      return;
    }
    let link;
    try {
      link = await this.#direct.listen();
      await this.#direct.expect({
        id: msg.id,
        folderId: destination.folderId,
        path: row.path,
        size: row.size,
      });
    } catch {
      no();
      return;
    }
    if (this.#stopped || row.status !== S.QUEUED) {
      this.#direct.cancel(msg.id);
      no();
      return;
    }
    this.#directIn.set(msg.id, row);
    const now = Date.now();
    this.#store.update(
      row,
      {
        status: S.RECEIVING,
        bytes: 0,
        startedAt: row.startedAt || now,
        segmentStartedAt: now,
        segmentStartBytes: 0,
        via: 'direct',
      },
      true,
    );
    this.#port.trySendJson({ t: TransferMessage.DIRECT_READY, id: msg.id, ok: true, link });
  }

  #onDirectEvent(event) {
    if (this.#stopped || event === null || typeof event !== 'object' || !isId(event.id ?? 'x')) return;
    if (event.type === 'sent-progress') {
      const job = this.#jobs.get(event.id);
      if (job?.via === 'direct' && Number.isSafeInteger(event.bytes) && !isTerminal(job.row.status)) {
        job.acked = event.bytes;
        this.#store.update(job.row, { bytes: Math.min(event.bytes, job.row.size) });
      }
      return;
    }
    const row = this.#directIn.get(event.id);
    if (!row) return;
    if (event.type === 'progress') {
      if (Number.isSafeInteger(event.bytes) && !isTerminal(row.status))
        this.#store.update(row, { bytes: Math.min(event.bytes, row.size) });
    } else if (event.type === 'received') {
      this.#directIn.delete(event.id);
      if (isTerminal(row.status)) return;
      if (event.lost) {
        // The sender will resend it over WebRTC.
        this.#store.update(row, { status: S.QUEUED, bytes: 0, via: null }, true);
      } else if (event.ok) {
        this.#completed.set(event.id, { ok: true, verified: true });
        const batch = this.#batches.get(row.batchId);
        this.#store.update(
          row,
          {
            status: S.DONE,
            bytes: row.size,
            verified: true,
            savedTo: SaveLocation.FOLDER,
            savedAs: typeof event.savedAs === 'string' ? event.savedAs : row.path,
            folderId: batch?.destination?.folderId ?? null,
            finishedAt: Date.now(),
          },
          true,
        );
      } else if (event.cancelled) {
        this.#endIncoming(event.id, { status: S.CANCELLED });
      } else {
        this.#endIncoming(event.id, {
          status: S.FAILED,
          error: shortText(event.error, 'Could not save the file.'),
        });
      }
    }
  }

  async #streamFile(job, offset) {
    const { row, file } = job;
    const { READ_BYTES, CHUNK_BYTES, FRAME_HEADER_BYTES } = this.#limits;
    const payloadBytes = CHUNK_BYTES - FRAME_HEADER_BYTES;
    const epoch = this.#epoch;
    const hasher = await this.#createHasher();
    // Resuming: rebuild the hash of the part the receiver already has (local disk read, fast).
    if (offset > 0) await hashBlobRange(file, 0, offset, hasher);
    if (epoch !== this.#epoch) throw new ChannelLostError(); // reconnected meanwhile: resync first
    if (job.cancelled || isTerminal(row.status)) throw new CancelledError();

    const slot = this.#nextSlot++;
    job.slot = slot;
    this.#port.sendJson({ t: TransferMessage.START, id: row.id, offset, slot });
    job.sent = offset;
    job.acked = offset;
    this.#inFlight.add(job);
    const now = Date.now();
    this.#store.update(
      row,
      {
        status: S.SENDING,
        bytes: offset,
        startedAt: row.startedAt || now,
        segmentStartedAt: now,
        segmentStartBytes: offset,
      },
      true,
    );

    // Bytes are hashed in file order here, whichever lane each frame then takes.
    for (let pos = offset; pos < row.size; pos += READ_BYTES) {
      const block = new Uint8Array(await file.slice(pos, Math.min(pos + READ_BYTES, row.size)).arrayBuffer());
      if (block.length === 0) throw new Error('The file changed or became unreadable while sending.');
      hasher.update(block);
      for (let i = 0; i < block.length; i += payloadBytes) {
        const lane = await this.#waitForLane(job, epoch);
        const payload = block.subarray(i, Math.min(i + payloadBytes, block.length));
        this.#sendFrame(lane, job, slot, pos + i, payload);
        job.sent += payload.length;
      }
    }
    if (job.sent !== row.size) throw new Error('The file changed while it was being sent.');
    if (epoch !== this.#epoch) throw new ChannelLostError();
    if (job.cancelled || isTerminal(row.status)) throw new CancelledError();
    // END can overtake frames still travelling on other lanes; the receiver waits for them.
    this.#port.sendJson({ t: TransferMessage.END, id: row.id, sha256: hasher.digest() });
    this.#store.update(row, { status: S.VERIFYING }, true);
  }

  /**
   * Backpressure: waits for a lane with room in its send buffer, while the receiver's unwritten bytes stay
   * within the window. Frames being resent go first.
   */
  async #waitForLane(job, epoch) {
    for (;;) {
      if (this.#stopped) throw new StoppedError();
      if (job.cancelled || isTerminal(job.row.status)) throw new CancelledError();
      if (epoch !== this.#epoch || !this.#port.isOpen) throw new ChannelLostError();
      const blocked = this.#retransmits.length > 0 || this.#unackedBytes() > this.#limits.WINDOW_BYTES;
      const lane = blocked ? null : this.#pickLane();
      if (lane) return lane;
      await this.#nextSignal();
    }
  }

  /** The open lane with the emptiest send buffer, if any has room. */
  #pickLane() {
    const { HIGH_WATER_BYTES } = this.#limits;
    // Lanes share the buffer budget: one huge buffer per lane would hold the window's bytes locally
    // instead of on the network.
    const limit = Math.min(
      HIGH_WATER_BYTES,
      Math.max(MIN_LANE_HIGH_WATER, Math.floor(HIGH_WATER_BYTES / (1 + this.#lanes.size))),
    );
    let best = this.#mainLane.isOpen && this.#mainLane.bufferedAmount <= limit ? this.#mainLane : null;
    const closed = [];
    for (const lane of this.#lanes.values()) {
      if (!lane.isOpen) closed.push(lane);
      else if (lane.bufferedAmount <= limit && (!best || lane.bufferedAmount < best.bufferedAmount))
        best = lane;
    }
    for (const lane of closed) this.#dropLane(lane, true);
    return best;
  }

  #sendFrame(lane, job, slot, offset, payload) {
    const frame = encodeFrame(slot, offset, payload);
    // The main channel needs no records: if it drops, the whole connection resyncs from the receiver's offset.
    if (lane.main) {
      this.#port.sendBinary(frame);
      return;
    }
    const record = { job, slot, offset, length: payload.length };
    try {
      lane.channel.send(frame);
    } catch {
      this.#retransmits.push(record);
      this.#dropLane(lane, true);
      return;
    }
    lane.records.push(record);
    if (lane.records.length > LANE_RECORDS_PRUNE_AT)
      lane.records = lane.records.filter((r) => this.#isLive(r));
  }

  /** Still worth (re)sending: same attempt of a live file, and not yet confirmed written. */
  #isLive({ job, slot, offset, length }) {
    return job.slot === slot && !job.cancelled && !isTerminal(job.row.status) && offset + length > job.acked;
  }

  #unackedBytes() {
    let total = 0;
    for (const job of this.#inFlight) {
      if (job.cancelled || isTerminal(job.row.status) || job.acked >= job.row.size)
        this.#inFlight.delete(job);
      else total += job.sent - job.acked;
    }
    return total;
  }

  /** Resends the frames of closed lanes (re-read from the file) on the remaining lanes. */
  async #runRetransmits() {
    if (this.#retransmitting) return;
    this.#retransmitting = true;
    try {
      while (this.#retransmits.length > 0 && !this.#stopped) {
        const record = this.#retransmits[0];
        if (!this.#isLive(record)) {
          this.#retransmits.shift();
          continue;
        }
        const epoch = this.#epoch;
        let bytes;
        try {
          const { file } = record.job;
          bytes = new Uint8Array(
            await file.slice(record.offset, record.offset + record.length).arrayBuffer(),
          );
          if (bytes.length !== record.length) throw new Error('The file changed while it was being sent.');
        } catch (err) {
          this.#failOutgoing(record.job, shortText(err.message, 'Could not read the file.'));
          continue;
        }
        let lane = null;
        while (!this.#stopped && epoch === this.#epoch && this.#port.isOpen && !(lane = this.#pickLane())) {
          await this.#nextSignal();
        }
        // A reconnect clears the queue: the resync resends from the receiver's offset instead.
        if (!lane) break;
        if (this.#retransmits[0] !== record) continue;
        this.#retransmits.shift();
        if (this.#isLive(record)) this.#sendFrame(lane, record.job, record.slot, record.offset, bytes);
      }
    } catch (err) {
      if (!(err instanceof ChannelLostError)) console.warn('[hopline] resend stopped unexpectedly', err);
    } finally {
      this.#retransmitting = false;
      this.#signal(); // new data may flow again
      // Records may have been queued for a newer connection while this loop was winding down.
      if (this.#retransmits.length > 0 && !this.#stopped && this.#port.isOpen) void this.#runRetransmits();
    }
  }

  #failOutgoing(job, error) {
    if (isTerminal(job.row.status)) return;
    this.#store.update(job.row, { status: S.FAILED, error, finishedAt: Date.now() }, true);
    this.#port.trySendJson({ t: TransferMessage.CANCEL, id: job.row.id });
    this.#signal();
  }

  #onProgress(msg) {
    const job = this.#jobs.get(msg.id);
    if (!job || !isByteCount(msg.bytes, job.row.size) || msg.bytes < job.acked) return;
    job.acked = msg.bytes;
    if (!isTerminal(job.row.status)) this.#store.update(job.row, { bytes: msg.bytes });
    this.#signal();
  }

  #onAck(msg) {
    const job = this.#jobs.get(msg.id);
    if (!job || isTerminal(job.row.status)) return;
    this.#finishOutgoing(job, msg.ok === true, msg.verified === true, msg.error);
  }

  #finishOutgoing(job, ok, verified, error) {
    if (isTerminal(job.row.status)) return;
    this.#store.update(
      job.row,
      ok
        ? { status: S.DONE, bytes: job.row.size, verified, finishedAt: Date.now() }
        : {
            status: S.FAILED,
            error: shortText(error, 'The other device could not save the file.'),
            finishedAt: Date.now(),
          },
      true,
    );
    this.#signal();
  }

  // ── Receiving ───────────────────────────────────────────────────────────

  #onOffer(msg) {
    const { MAX_FILES_PER_OFFER, MAX_FILE_BYTES, MAX_FILE_NAME_LENGTH, MAX_PATH_LENGTH } = this.#limits;
    if (!isId(msg.batchId) || !Array.isArray(msg.files) || msg.files.length === 0) return;
    if (msg.files.length > MAX_FILES_PER_OFFER) return;

    const known = this.#batches.get(msg.batchId);
    if (known) {
      // Our answer may have been lost in a disconnect: repeat it.
      if (known.direction === 'in' && known.accept !== null) {
        this.#port.trySendJson({ t: TransferMessage.ANSWER, batchId: msg.batchId, accept: known.accept });
      }
      return;
    }

    // A peer can't bury the user in offers: cap undecided offers and the total number of incoming rows.
    const undecided = [...this.#batches.values()].filter(
      (b) => b.direction === 'in' && b.accept === null,
    ).length;
    if (undecided >= MAX_PENDING_OFFERS || this.#incomingRows.size + msg.files.length > MAX_INCOMING_FILES) {
      this.#port.trySendJson({ t: TransferMessage.ANSWER, batchId: msg.batchId, accept: false });
      return;
    }

    const rows = [];
    for (const file of msg.files) {
      if (!isId(file?.id) || this.#incomingRows.has(file.id) || !isByteCount(file.size, MAX_FILE_BYTES))
        continue;
      const path = toSafePath(typeof file.path === 'string' ? file.path : file.name, {
        maxSegmentLength: MAX_FILE_NAME_LENGTH,
      }).slice(0, MAX_PATH_LENGTH);
      const row = this.#store.create({
        id: `in-${file.id}`,
        remoteId: file.id,
        direction: 'in',
        batchId: msg.batchId,
        name: baseName(path),
        path,
        size: file.size,
        // Only harmless image types survive; anything else (e.g. text/html) becomes a plain download, so a
        // received file can never be rendered as a page in the app's origin.
        mime: safeMimeType(file.mime),
        status: S.OFFERED,
      });
      this.#incomingRows.set(file.id, row.id);
      rows.push(row.id);
    }
    if (rows.length === 0) return;
    this.#batches.set(msg.batchId, { direction: 'in', rowIds: rows, accept: null, destination: null });
    this.#store.notify(true);
    this.emit('offer', msg.batchId);
  }

  async #onStart(msg) {
    // Slots only grow, so a replayed or stale start can't re-open anything.
    if (!isId(msg.id) || !isSlot(msg.slot) || msg.slot <= this.#maxSlot) return;
    this.#maxSlot = msg.slot;
    const early = this.#takeEarly(msg.slot);

    const row = this.#store.get(this.#incomingRows.get(msg.id));
    const batch = row && this.#batches.get(row.batchId);
    if (!row || batch?.accept !== true) return;
    if (row.status === S.CANCELLED || row.status === S.DECLINED) {
      this.#port.trySendJson({ t: TransferMessage.CANCEL, id: msg.id });
      return;
    }
    if (isTerminal(row.status)) {
      // Already finished here (e.g. saved over a direct link whose result never reached the sender): repeat
      // the outcome, or the sender would wait forever for an answer.
      const result = this.#completed.get(msg.id);
      if (result?.ok) this.#port.trySendJson({ t: TransferMessage.PROGRESS, id: msg.id, bytes: row.size });
      if (result) {
        this.#port.trySendJson({
          t: TransferMessage.ACK,
          id: msg.id,
          ok: result.ok,
          verified: result.verified,
        });
      }
      return;
    }
    if (!isByteCount(msg.offset, row.size)) return;
    if (this.#directIn.delete(msg.id)) this.#direct.cancel(msg.id);

    const epoch = this.#epoch;
    // A cancel, stop or reconnect can happen while we await below; then this start is void.
    const stale = () => this.#stopped || epoch !== this.#epoch || isTerminal(row.status);
    let entry = this.#incoming.get(msg.id);
    if (msg.offset === 0) {
      if (entry) {
        this.#unmapSlot(entry);
        this.#incoming.delete(msg.id);
        await entry.sink.abort();
        if (stale()) return;
      }
      entry = this.#openIncoming(msg.id, row, batch.destination);
      entry.hasher = await this.#createHasher();
      if (stale() || this.#incoming.get(msg.id) !== entry) {
        if (this.#incoming.get(msg.id) === entry) this.#incoming.delete(msg.id);
        void entry.sink.abort();
        return;
      }
    } else if (!entry || entry.received !== msg.offset) {
      this.#failIncoming(entry ?? { id: msg.id, row }, 'Could not resume this file. Send it again.');
      return;
    } else {
      this.#unmapSlot(entry);
    }
    entry.slot = msg.slot;
    this.#slots.set(msg.slot, entry);

    const now = Date.now();
    this.#store.update(
      row,
      {
        status: S.RECEIVING,
        bytes: entry.sink.bytesWritten,
        startedAt: row.startedAt || now,
        segmentStartedAt: now,
        segmentStartBytes: entry.sink.bytesWritten,
      },
      true,
    );
    for (const frame of early) this.#acceptFrame(entry, frame.offset, frame.payload);
  }

  #openIncoming(id, row, destination) {
    const sink = this.#createSink({ row, destination });
    const entry = {
      id,
      row,
      sink,
      hasher: null,
      /** Contiguous bytes hashed and handed to the sink (what SYNC reports). */
      received: 0,
      reported: 0,
      slot: null,
      /** offset → bytes that arrived ahead of `received` on a faster lane. */
      reorder: new Map(),
      reorderBytes: 0,
      /** The sender's SHA-256 once `end` arrived (it can overtake the last frames). */
      expectedSha: null,
    };
    sink.on('written', (written) => this.#onWritten(entry, written));
    sink.on('error', (err) => this.#failIncoming(entry, `Could not save the file: ${err.message}`));
    this.#incoming.set(id, entry);
    return entry;
  }

  #unmapSlot(entry) {
    if (entry.slot !== null && this.#slots.get(entry.slot) === entry) this.#slots.delete(entry.slot);
    entry.slot = null;
    entry.reorder.clear();
    entry.reorderBytes = 0;
    entry.expectedSha = null;
  }

  /** Removes held frames for this slot and any older one; returns this slot's. */
  #takeEarly(slot) {
    let frames = [];
    for (const [key, held] of this.#early) {
      if (key > slot) continue;
      if (key === slot) frames = held.frames;
      this.#earlyBytes -= held.bytes;
      this.#early.delete(key);
    }
    return frames;
  }

  #holdEarly(frame) {
    let held = this.#early.get(frame.slot);
    if (!held) {
      if (this.#early.size >= MAX_EARLY_SLOTS) return this.#abort(FLOODED);
      held = { frames: [], bytes: 0 };
      this.#early.set(frame.slot, held);
    }
    const cost = frame.payload.length + HELD_FRAME_OVERHEAD;
    held.frames.push(frame);
    held.bytes += cost;
    this.#earlyBytes += cost;
    if (this.#bufferedIncomingBytes() > this.#limits.WINDOW_BYTES * 2) this.#abort(FLOODED);
    return undefined;
  }

  #onWritten(entry, written) {
    if (this.#incoming.get(entry.id) !== entry) return;
    this.#store.update(entry.row, { bytes: written });
    if (written - entry.reported >= this.#limits.PROGRESS_EVERY_BYTES || written === entry.row.size) {
      entry.reported = written;
      this.#port.trySendJson({ t: TransferMessage.PROGRESS, id: entry.id, bytes: written });
    }
  }

  #onFrame(data) {
    const frame = decodeFrame(data);
    if (!frame) return undefined;
    const entry = this.#slots.get(frame.slot);
    if (!entry) {
      // Newer than any start: a lane overtook the main channel, so keep it until its start arrives.
      // Older: left over from an earlier attempt, already covered by the resync.
      return frame.slot > this.#maxSlot ? this.#holdEarly(frame) : undefined;
    }
    this.#acceptFrame(entry, frame.offset, frame.payload);
    return this.#maybeFinish(entry);
  }

  #acceptFrame(entry, frameOffset, frameBytes) {
    if (entry.row.status !== S.RECEIVING || this.#incoming.get(entry.id) !== entry) return;
    let offset = frameOffset;
    let bytes = frameBytes;
    const end = offset + bytes.length;
    if (end > entry.row.size) {
      this.#failIncoming(entry, 'The other device sent more data than it announced.');
      return;
    }
    if (end <= entry.received) return; // a duplicate (resent after a lane closed)
    if (offset < entry.received) {
      bytes = bytes.subarray(entry.received - offset);
      offset = entry.received;
    }
    if (offset > entry.received) {
      if (!entry.reorder.has(offset)) {
        entry.reorder.set(offset, bytes);
        entry.reorderBytes += bytes.length + HELD_FRAME_OVERHEAD;
      }
    } else if (this.#commit(entry, bytes)) {
      for (let next = entry.reorder.get(entry.received); next; next = entry.reorder.get(entry.received)) {
        entry.reorder.delete(entry.received);
        entry.reorderBytes -= next.length + HELD_FRAME_OVERHEAD;
        if (!this.#commit(entry, next)) return;
      }
    } else {
      return;
    }
    // Enforce the flow-control window on our side too: a sender ignoring it would make us buffer unboundedly
    // (out-of-order frames, or data waiting for the disk).
    const { WINDOW_BYTES } = this.#limits;
    if (
      entry.received + entry.reorderBytes - entry.sink.bytesWritten > WINDOW_BYTES * 2 ||
      offset - entry.received > WINDOW_BYTES * 2
    ) {
      this.#failIncoming(entry, 'The other device ignored flow control.');
      return;
    }
    // …and across all files at once: a peer can't multiply the bound by starting many files.
    if (this.#bufferedIncomingBytes() > WINDOW_BYTES * 2) this.#abort(FLOODED);
  }

  /** Received bytes held in memory: out-of-order frames, early frames, and data waiting for the disk. */
  #bufferedIncomingBytes() {
    let total = this.#earlyBytes;
    for (const entry of this.#incoming.values()) {
      total += entry.reorderBytes + Math.max(0, entry.received - entry.sink.bytesWritten);
    }
    return total;
  }

  /** Hashes and stores the next in-order bytes. */
  #commit(entry, bytes) {
    entry.hasher.update(bytes);
    try {
      entry.sink.write(bytes);
    } catch (err) {
      this.#failIncoming(entry, `Could not save the file: ${err.message}`);
      return false;
    }
    entry.received += bytes.length;
    return true;
  }

  #onEnd(msg) {
    const entry = isId(msg.id) ? this.#incoming.get(msg.id) : undefined;
    if (!entry || entry.slot === null || entry.row.status !== S.RECEIVING) return undefined;
    entry.expectedSha = typeof msg.sha256 === 'string' ? msg.sha256.toLowerCase() : '';
    return this.#maybeFinish(entry);
  }

  #maybeFinish(entry) {
    if (entry.expectedSha === null || entry.received !== entry.row.size) return undefined;
    if (entry.row.status !== S.RECEIVING || this.#incoming.get(entry.id) !== entry) return undefined;
    return this.#finishIncoming(entry);
  }

  async #finishIncoming(entry) {
    const { id } = entry;
    const expected = entry.expectedSha;
    this.#unmapSlot(entry);
    this.#store.update(entry.row, { status: S.VERIFYING }, true);
    // Verify BEFORE committing: a file that fails the checksum is discarded without ever appearing in the
    // user's folder (writes go to a hidden swap file until close()).
    if (entry.hasher.digest() !== expected) {
      this.#failIncoming(entry, 'Checksum mismatch: the file was corrupted, so it was discarded.');
      return;
    }
    let result;
    try {
      result = await entry.sink.close();
    } catch (err) {
      this.#failIncoming(entry, `Could not save the file: ${err.message}`);
      return;
    }
    if (this.#incoming.get(id) !== entry) return; // cancelled while closing
    this.#incoming.delete(id);
    this.#completed.set(id, { ok: true, verified: true });
    this.#store.update(
      entry.row,
      {
        status: S.DONE,
        bytes: entry.row.size,
        verified: true,
        url: result.url ?? null,
        savedTo: result.location,
        savedAs: result.savedAs ?? null,
        folderId: this.#batches.get(entry.row.batchId)?.destination?.folderId ?? null,
        finishedAt: Date.now(),
      },
      true,
    );
    this.#port.trySendJson({ t: TransferMessage.PROGRESS, id, bytes: entry.row.size });
    this.#port.trySendJson({ t: TransferMessage.ACK, id, ok: true, verified: true });
  }

  #failIncoming(entry, reason) {
    if (!entry) return;
    this.#endIncoming(entry.id, { status: S.FAILED, error: reason });
    this.#port.trySendJson({
      t: TransferMessage.ACK,
      id: entry.id,
      ok: false,
      verified: false,
      error: reason,
    });
  }

  /** Stops receiving a file (failed or cancelled) and discards what was stored. */
  #endIncoming(remoteId, fields) {
    if (this.#directIn.delete(remoteId)) this.#direct.cancel(remoteId);
    const entry = this.#incoming.get(remoteId);
    if (entry) {
      this.#incoming.delete(remoteId);
      this.#unmapSlot(entry);
      void entry.sink.abort();
    }
    this.#completed.set(remoteId, { ok: false, verified: false });
    const row = this.#store.get(this.#incomingRows.get(remoteId));
    if (row && !isTerminal(row.status)) this.#store.update(row, { ...fields, finishedAt: Date.now() }, true);
  }

  #onCancel(msg) {
    if (!isId(msg.id)) return;
    const job = this.#jobs.get(msg.id);
    if (job) {
      // The receiver cancelled one of my files.
      job.cancelled = true;
      if (job.via === 'direct') this.#direct.cancel(msg.id);
      this.#signal();
      if (!isTerminal(job.row.status))
        this.#store.update(job.row, { status: S.CANCELLED, finishedAt: Date.now() }, true);
      return;
    }
    // The sender cancelled a file it was sending me.
    if (this.#incomingRows.has(msg.id)) this.#endIncoming(msg.id, { status: S.CANCELLED });
  }
}
