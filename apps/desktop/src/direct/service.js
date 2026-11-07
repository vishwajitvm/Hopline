import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { toSafePathSegments } from '@hopline/cli/src/utils/files.js';
import { SafeFileWriter } from '@hopline/cli/src/utils/safe-write.js';
import { DirectReceiver } from './receiver.js';
import { DirectLink, LinkLostError } from './sender.js';
import { isId } from './wire.js';

const MAX_OPEN_FILES = 64;
const token = () => randomBytes(16).toString('hex');

/** "Hopline 2026-11-07 18-30-12": a new folder per session, so a sender can never touch existing files. */
export function datedFolderName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Hopline ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/**
 * Everything the desktop app's renderer may ask the main process to do for Direct mode. The renderer is
 * treated as untrusted: it never passes raw paths to read or write.
 *  - Files to send are registered from real File objects (by the preload) and referred to by token.
 *  - Files are only written into folders the user picked (or the default dated Downloads folder), by
 *    folder id, under sanitised relative paths, with the CLI's safe-write rules.
 *
 * Emits 'event' with plain objects for the renderer:
 *   { type: 'progress', id, bytes }   { type: 'received', id, ok, savedAs?, error?, cancelled?, lost? }
 *   { type: 'sent-progress', id, bytes }   { type: 'link-closed' }
 */
export class DirectService extends EventEmitter {
  #downloadsDir;
  #folders = new Map();
  #defaultFolder = null;
  #paths = new Map();
  #receiver = null;
  #link = null;
  #linkKey = null;
  #sending = new Map();
  #files = new Map();
  #opening = 0;
  /** Bumped by reset(), so work that started before it can tell it's stale. */
  #generation = 0;

  constructor({ downloadsDir }) {
    super();
    this.#downloadsDir = downloadsDir;
  }

  // ── Folders and files ───────────────────────────────────────────────────

  /** Registers a folder the user picked in a native dialog. Returns { folderId, label }. */
  registerFolder(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid folder.');
    const folderId = token();
    this.#folders.set(folderId, path);
    return { folderId, label: path };
  }

  /** The session's default folder: Downloads/Hopline <date> (created on first use). */
  defaultFolder() {
    if (!this.#defaultFolder) {
      this.#defaultFolder = this.registerFolder(join(this.#downloadsDir, datedFolderName()));
    }
    return this.#defaultFolder;
  }

  /** Registers a file the user chose (path from webUtils.getPathForFile in the preload). Returns a token. */
  async registerPath(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    try {
      if (!(await lstat(path)).isFile()) return null;
    } catch {
      return null;
    }
    const id = token();
    this.#paths.set(id, path);
    return id;
  }

  async #target(folderId, relativePath) {
    const root = this.#folders.get(folderId);
    if (!root) throw new Error('Unknown folder.');
    await mkdir(root, { recursive: true });
    return { root, segments: toSafePathSegments(relativePath) };
  }

  // ── Receiving over a Direct link ───────────────────────────────────────

  /** Listening details for the sender (fresh listener when there's no live link). */
  async listen() {
    if (!this.#receiver) {
      const receiver = new DirectReceiver();
      receiver.on('progress', ({ id, bytes }) => this.emit('event', { type: 'progress', id, bytes }));
      receiver.on('result', (result) => {
        // The renderer gets the path relative to its folder, never an absolute path.
        const { id, ok, savedAs, error, cancelled, lost } = result;
        this.emit('event', { type: 'received', id, ok, savedAs, error, cancelled, lost });
      });
      receiver.on('closed', () => {
        if (this.#receiver === receiver) this.#receiver = null;
        receiver.close();
      });
      this.#receiver = receiver;
    }
    return this.#receiver.listen();
  }

  async expect({ id, folderId, path, size }) {
    if (!isId(id)) throw new Error('Invalid file id.');
    if (!this.#receiver) throw new Error('Not listening.');
    const { root, segments } = await this.#target(folderId, path);
    this.#receiver.expect({ id, root, segments, size });
  }

  // ── Sending over a Direct link ─────────────────────────────────────────

  /** Connects to the receiver's listener (reusing the link to the same listener). */
  async connect(info) {
    const key = String(info?.key ?? '');
    if (this.#link && !this.#link.closed && this.#linkKey === key) return true;
    this.#link?.close();
    const link = await DirectLink.connect(info);
    link.on('progress', ({ id, bytes }) => this.emit('event', { type: 'sent-progress', id, bytes }));
    link.on('closed', () => {
      if (this.#link === link) this.#link = null;
      this.emit('event', { type: 'link-closed' });
    });
    this.#link = link;
    this.#linkKey = key;
    return true;
  }

  /** Sends a registered file. Resolves to { ok, error?, cancelled? } or { lost: true } (fall back). */
  async send({ id, fileToken, size }) {
    const path = this.#paths.get(fileToken);
    if (!path || !isId(id)) return { ok: false, error: 'Unknown file.' };
    const link = this.#link;
    if (!link || link.closed) return { lost: true };
    this.#sending.set(id, link);
    try {
      return await link.sendFile({ id, path, size });
    } catch (err) {
      if (err instanceof LinkLostError) return { lost: true };
      return { lost: true, error: err.message };
    } finally {
      this.#sending.delete(id);
    }
  }

  /** Cancels a file in either direction. */
  cancel(id) {
    this.#sending.get(id)?.cancel(id);
    this.#receiver?.cancel(id);
  }

  // ── Native files written over WebRTC (receiver chose a real folder) ──

  async openFile({ folderId, path }) {
    // Reserve the slot before any await, so parallel calls can't all slip past the cap.
    if (this.#files.size + this.#opening >= MAX_OPEN_FILES) throw new Error('Too many open files.');
    this.#opening++;
    const generation = this.#generation;
    try {
      const { root, segments } = await this.#target(folderId, path);
      const writer = new SafeFileWriter(root, segments);
      await writer.open();
      if (generation !== this.#generation) {
        await writer.abort(); // reset() ran meanwhile: this file belongs to a page that's gone
        throw new Error('Cancelled.');
      }
      const handle = token();
      this.#files.set(handle, { writer, root });
      return handle;
    } finally {
      this.#opening--;
    }
  }

  async writeFile(handle, bytes) {
    const file = this.#files.get(handle);
    if (!file) throw new Error('Unknown file handle.');
    await file.writer.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  async commitFile(handle) {
    const file = this.#files.get(handle);
    if (!file) throw new Error('Unknown file handle.');
    this.#files.delete(handle);
    const savedPath = await file.writer.commit();
    // relative() rather than slicing: a drive root ("D:\") has no extra separator to skip.
    return relative(file.root, savedPath).split(/[\\/]/).join('/');
  }

  async abortFile(handle) {
    const file = this.#files.get(handle);
    this.#files.delete(handle);
    await file?.writer.abort();
  }

  /** Absolute path of a saved file (to show it in the file manager). */
  savedPath(folderId, savedAs) {
    const root = this.#folders.get(folderId);
    if (!root || typeof savedAs !== 'string') return null;
    return join(root, ...toSafePathSegments(savedAs));
  }

  /** The page reloaded or the session ended: drop links, listeners, partial files and tokens. */
  async reset() {
    this.#generation++;
    this.#receiver?.close();
    this.#receiver = null;
    this.#link?.close();
    this.#link = null;
    this.#sending.clear();
    this.#paths.clear();
    const files = [...this.#files.values()];
    this.#files.clear();
    await Promise.all(files.map((file) => file.writer.abort()));
    this.#defaultFolder = null;
  }
}
