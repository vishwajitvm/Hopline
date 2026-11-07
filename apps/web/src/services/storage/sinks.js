import { TransferLimits } from '@hopline/protocol';
import { Emitter } from '../../utils/emitter.js';
import { splitExtension, toSafeSegments } from '../../utils/paths.js';

export const SaveLocation = Object.freeze({
  FOLDER: 'folder', // written straight into a folder the user picked (File System Access API)
  BROWSER: 'browser', // browser's private on-disk storage (OPFS) — user clicks Save afterwards
  MEMORY: 'memory', // last resort: RAM
});

const OPFS_DIR = 'hopline-incoming';
const COMPACT_EVERY_BYTES = 64 * 1024 * 1024;

function concat(parts, total) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Base class for where received bytes go. Callers `write()` synchronously (bytes are queued);
 * small chunks are batched into larger writes, and writes run strictly one after another.
 *
 * Events: 'written' (total durable bytes), 'error' (Error).
 * `bytesWritten` only counts bytes the storage has accepted, so it's safe to report as progress and to
 * resume from after a disconnect.
 */
export class BufferedSink extends Emitter {
  #batch = [];
  #batchBytes = 0;
  #chain;
  #error = null;
  #batchLimit;
  bytesWritten = 0;

  constructor({ batchBytes = TransferLimits.WRITE_BATCH_BYTES } = {}) {
    super();
    this.#batchLimit = batchBytes;
    this.#chain = Promise.resolve().then(() => this.open());
    this.#chain.catch((err) => this.#fail(err));
  }

  get failed() {
    return this.#error;
  }

  write(bytes) {
    if (this.#error) throw this.#error;
    this.#batch.push(bytes);
    this.#batchBytes += bytes.length;
    if (this.#batchBytes >= this.#batchLimit) this.#flushBatch();
  }

  /** Waits until everything written so far is stored. */
  async flush() {
    this.#flushBatch();
    await this.#chain;
    if (this.#error) throw this.#error;
  }

  /** Finishes the file. Resolves to `{ location, url }` (url is null when saved straight to a folder). */
  async close() {
    await this.flush();
    return this.finalize();
  }

  /** Throws away everything (cancel, failure). Never throws. */
  async abort() {
    this.#batch = [];
    this.#batchBytes = 0;
    try {
      await this.#chain;
    } catch {
      // already failed; we're discarding anyway
    }
    try {
      await this.discard();
    } catch {
      // best effort
    }
  }

  #flushBatch() {
    if (this.#batchBytes === 0) return;
    const parts = this.#batch;
    const size = this.#batchBytes;
    this.#batch = [];
    this.#batchBytes = 0;
    this.#chain = this.#chain.then(async () => {
      if (this.#error) return;
      await this.store(concat(parts, size));
      this.bytesWritten += size;
      this.emit('written', this.bytesWritten);
    });
    this.#chain.catch((err) => this.#fail(err));
  }

  #fail(err) {
    if (this.#error) return;
    this.#error = err instanceof Error ? err : new Error(String(err));
    this.emit('error', this.#error);
  }

  // Subclass hooks
  async open() {}
  async store(_bytes) {}
  async finalize() {
    return { location: SaveLocation.MEMORY, url: null };
  }
  async discard() {}
}

/** Keeps the file in memory. Folds parts into Blobs every 64 MiB so the browser can page them out of the heap. */
export class MemorySink extends BufferedSink {
  #blobs = [];
  #pending = [];
  #pendingBytes = 0;
  #url = null;

  constructor({ mime = '', ...options } = {}) {
    super(options);
    this.mime = mime;
  }

  async store(bytes) {
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;
    if (this.#pendingBytes >= COMPACT_EVERY_BYTES) {
      this.#blobs.push(new Blob(this.#pending));
      this.#pending = [];
      this.#pendingBytes = 0;
    }
  }

  async finalize() {
    const blob = new Blob([...this.#blobs, ...this.#pending], {
      type: this.mime || 'application/octet-stream',
    });
    this.#blobs = [];
    this.#pending = [];
    this.#url = URL.createObjectURL(blob);
    return { location: SaveLocation.MEMORY, url: this.#url };
  }

  async discard() {
    this.#blobs = [];
    this.#pending = [];
    if (this.#url) URL.revokeObjectURL(this.#url);
  }
}

/**
 * Each open tab stores incoming files in its own sub-folder, guarded by a Web Lock it holds for its whole
 * life. Cleanup removes only folders whose lock is free — i.e. whose tab is gone — so two tabs never
 * delete each other's downloads.
 */
const tabKey = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
const lockName = (key) => `hopline-storage-${key}`;
let tabLockTaken = false;

function holdTabLock() {
  if (tabLockTaken || !navigator.locks) return;
  tabLockTaken = true;
  navigator.locks.request(lockName(tabKey), () => new Promise(() => {})).catch(() => {});
}

async function opfsDirectory() {
  holdTabLock();
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  return base.getDirectoryHandle(tabKey, { create: true });
}

/** Streams into the browser's private file system (on disk, not RAM). The user saves it afterwards. */
export class OpfsSink extends BufferedSink {
  #name;
  #mime;
  #dir = null;
  #handle = null;
  #writable = null;
  #url = null;

  constructor({ id, mime = '', ...options }) {
    super(options);
    this.#name = `${id}.part`;
    this.#mime = mime;
  }

  async open() {
    this.#dir = await opfsDirectory();
    this.#handle = await this.#dir.getFileHandle(this.#name, { create: true });
    this.#writable = await this.#handle.createWritable({ keepExistingData: false });
  }

  async store(bytes) {
    await this.#writable.write(bytes);
  }

  async finalize() {
    await this.#writable.close();
    this.#writable = null;
    const file = await this.#handle.getFile();
    const typed = this.#mime ? new File([file], file.name, { type: this.#mime }) : file;
    this.#url = URL.createObjectURL(typed);
    return { location: SaveLocation.BROWSER, url: this.#url };
  }

  async discard() {
    if (this.#url) URL.revokeObjectURL(this.#url);
    if (this.#writable) await this.#writable.abort().catch(() => {});
    if (this.#dir) await this.#dir.removeEntry(this.#name).catch(() => {});
  }
}

/** Writes straight into a folder the user picked, recreating sub-folders. Never overwrites an existing file. */
export class DirectorySink extends BufferedSink {
  #root;
  #segments;
  #parent = null;
  #fileName = null;
  #writable = null;

  constructor({ directory, path, ...options }) {
    super(options);
    this.#root = directory;
    this.#segments = toSafeSegments(path);
  }

  async open() {
    let dir = this.#root;
    for (const segment of this.#segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    this.#parent = dir;
    this.#fileName = await uniqueName(dir, this.#segments[this.#segments.length - 1]);
    const handle = await dir.getFileHandle(this.#fileName, { create: true });
    // Writes go to a hidden swap file; the real file only appears, complete, on close().
    this.#writable = await handle.createWritable({ keepExistingData: false });
  }

  async store(bytes) {
    await this.#writable.write(bytes);
  }

  async finalize() {
    await this.#writable.close();
    this.#writable = null;
    return {
      location: SaveLocation.FOLDER,
      url: null,
      savedAs: [...this.#segments.slice(0, -1), this.#fileName].join('/'),
    };
  }

  async discard() {
    if (this.#writable) await this.#writable.abort().catch(() => {});
    if (this.#parent && this.#fileName) await this.#parent.removeEntry(this.#fileName).catch(() => {});
  }
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const [stem, ext] = splitExtension(name);
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error(`Too many files named "${name}" in that folder.`);
}

// ── Capabilities ──────────────────────────────────────────────────────────

/** Saving straight into a chosen folder: Chromium browsers and the desktop app, on HTTPS or localhost. */
export function canChooseFolder() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.showDirectoryPicker === 'function'
  );
}

/** On-disk browser storage: modern Chrome, Edge, Firefox and Safari, on HTTPS or localhost. */
export function canUseBrowserStorage() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

/** Free space the browser will let us use, in bytes (null when unknown). */
export async function availableBrowserStorage() {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return Math.max(0, quota - usage);
  } catch {
    return null;
  }
}

/** Deletes this tab's received files from browser storage (when the user starts over). */
export async function clearBrowserStorage() {
  if (!canUseBrowserStorage()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_DIR);
    await base.removeEntry(tabKey, { recursive: true });
  } catch {
    // nothing stored
  }
}

/** Deletes files left behind by tabs that were closed mid-transfer. Safe to call at startup. */
export async function cleanUpAbandonedStorage() {
  if (!canUseBrowserStorage() || !navigator.locks) return;
  try {
    holdTabLock();
    const { held = [] } = await navigator.locks.query();
    const live = new Set(held.map((lock) => lock.name));
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    for await (const name of base.keys()) {
      if (name !== tabKey && !live.has(lockName(name))) await base.removeEntry(name, { recursive: true });
    }
  } catch {
    // best effort
  }
}

/**
 * Desktop app: writes into a real folder through the main process (folder id + sanitised relative path),
 * with the same safe-write rules as Direct mode and the CLI (exclusive temp file, no overwrite, no symlinks).
 */
export class NativeSink extends BufferedSink {
  #bridge;
  #folderId;
  #path;
  #handle = null;

  constructor({ bridge, folderId, path, ...options }) {
    super(options);
    this.#bridge = bridge;
    this.#folderId = folderId;
    this.#path = path;
  }

  async open() {
    this.#handle = await this.#bridge.openFile({ folderId: this.#folderId, path: this.#path });
  }

  async store(bytes) {
    await this.#bridge.writeFile(this.#handle, bytes);
  }

  async finalize() {
    const savedAs = await this.#bridge.commitFile(this.#handle);
    this.#handle = null;
    return { location: SaveLocation.FOLDER, url: null, savedAs };
  }

  async discard() {
    if (this.#handle) await this.#bridge.abortFile(this.#handle);
    this.#handle = null;
  }
}

/** The desktop app's native bridge, or null in a browser. */
export function nativeBridge() {
  return (typeof window !== 'undefined' && window.hopline?.direct) || null;
}

/**
 * Picks the sink for an accepted file:
 *   desktop folder → chosen folder → browser disk storage → memory.
 */
export function createSink({ row, destination }) {
  if (destination?.kind === 'native' && nativeBridge()) {
    return new NativeSink({ bridge: nativeBridge(), folderId: destination.folderId, path: row.path });
  }
  if (destination?.kind === SaveLocation.FOLDER && destination.directory) {
    return new DirectorySink({ directory: destination.directory, path: row.path });
  }
  if (canUseBrowserStorage()) return new OpfsSink({ id: row.id, mime: row.mime });
  return new MemorySink({ mime: row.mime });
}
