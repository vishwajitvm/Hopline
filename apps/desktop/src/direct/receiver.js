import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { relative } from 'node:path';
import { ProtocolError } from '@hopline/cli/src/core/errors.js';
import { SafeFileWriter } from '@hopline/cli/src/utils/safe-write.js';
import { lanAddresses } from '@hopline/cli/src/utils/network.js';
import { DIRECT_VERSION, KEY_BYTES, Msg, Role, SecureChannel, isId, isSha256, parseJson } from './wire.js';

/** Unauthenticated sockets get this long to prove the key. */
const AUTH_TIMEOUT_MS = 10_000;
/** At most this many connections may be trying to authenticate at once (junk from the LAN can't pile up). */
const MAX_PENDING_SOCKETS = 8;
/** …and at most this many from one address, so one host can't crowd out the real sender. */
const MAX_PENDING_PER_ADDRESS = 2;
/** TCP keep-alive probes notice a dead link between files without killing an idle healthy one. */
const KEEPALIVE_MS = 15_000;
/** Report durable progress to the sender this often. */
const PROGRESS_EVERY_BYTES = 8 * 1024 * 1024;

/**
 * The receiving end of a Direct link: listens on a random TCP port, accepts exactly one connection that
 * proves the key, then writes only the files the user accepted (`expect`) into their chosen folder.
 *
 * Events:
 *   'progress' { id, bytes }                          bytes durably written
 *   'result'   { id, ok, savedAs?, error?, cancelled? } final outcome of one file
 *   'closed'   { error? }                              the link ended (files in flight fall back to WebRTC)
 */
export class DirectReceiver extends EventEmitter {
  #key = randomBytes(KEY_BYTES);
  #server = null;
  #listening = null;
  #pending = new Set();
  #channel = null;
  /** id → { root, segments, size, cancelled } */
  #expected = new Map();
  #current = null;
  #closed = false;

  /** Starts listening (once). Resolves to what the sender needs: { port, addresses, key (base64) }. */
  listen() {
    if (this.#closed) return Promise.reject(new Error('Direct receiver closed.'));
    this.#listening ??= new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#onConnection(socket));
      this.#server = server;
      server.once('error', reject);
      // All interfaces: the sender may be anywhere on the LAN. Only a key holder gets past the first frame.
      // IPv4 on all interfaces: the LAN is where the sender is (no global IPv6 exposure).
      server.listen(0, '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', () => {});
        resolve({
          port: server.address().port,
          addresses: [...lanAddresses(), '127.0.0.1'],
          key: this.#key.toString('base64'),
        });
      });
    });
    return this.#listening;
  }

  /** Allows one file (accepted by the user) to arrive. `segments` must already be sanitised. */
  expect({ id, root, segments, size }) {
    if (!isId(id) || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file.');
    this.#expected.set(id, { root, segments, size, cancelled: false });
  }

  /** The user cancelled this file on our side: stop writing it and tell the sender to stop. */
  cancel(id) {
    const expected = this.#expected.get(id);
    if (expected) expected.cancelled = true;
    if (this.#current?.id === id && !this.#current.skip) {
      // Only mark it: the receive loop is the one place that touches the writer (it may be mid-write now),
      // and it discards the file at its next step.
      this.#current.skip = true;
      this.#channel?.sendJson(Msg.SKIP, { id }).catch(() => {});
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#server?.close();
    for (const socket of this.#pending) socket.destroy();
    this.#pending.clear();
    this.#channel?.close();
    void this.#current?.writer?.abort();
    this.#current = null;
    this.#expected.clear();
  }

  async #onConnection(socket) {
    const address = socket.remoteAddress;
    const fromSameAddress = [...this.#pending].filter((other) => other.remoteAddress === address);
    if (this.#closed || this.#channel || fromSameAddress.length >= MAX_PENDING_PER_ADDRESS) {
      socket.destroy();
      return;
    }
    // Full: drop the oldest unauthenticated socket rather than refusing the newcomer, so slow-drip junk
    // can't keep the real sender out.
    if (this.#pending.size >= MAX_PENDING_SOCKETS) this.#pending.values().next().value.destroy();
    this.#pending.add(socket);
    socket.setNoDelay(true);
    // A hard deadline (not an idle timeout): trickling one byte at a time doesn't keep a socket alive.
    const deadline = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(deadline);
      this.#pending.delete(socket);
    });
    const channel = new SecureChannel(socket, this.#key, Role.RECEIVER);
    try {
      const hello = await channel.next(); // a wrong key fails right here
      if (hello.type !== Msg.HELLO || parseJson(hello.body).v !== DIRECT_VERSION)
        throw new ProtocolError('Bad hello.');
    } catch {
      socket.destroy();
      return;
    }
    this.#pending.delete(socket);
    clearTimeout(deadline);
    if (this.#closed || this.#channel) {
      socket.destroy();
      return;
    }
    // One link per key, ever: stop listening and drop anyone else still trying.
    this.#channel = channel;
    this.#server.close();
    for (const other of this.#pending) other.destroy();
    this.#pending.clear();
    socket.setKeepAlive(true, KEEPALIVE_MS);
    await channel.send(Msg.READY).catch(() => {});
    try {
      for (;;) await this.#handle(channel, await channel.next());
    } catch (err) {
      const current = this.#current;
      this.#current = null;
      if (current) {
        await current.writer?.abort();
        this.emit('result', { id: current.id, ok: false, lost: true, error: 'The direct link was lost.' });
      }
      channel.close();
      if (!this.#closed) this.emit('closed', { error: err?.message });
    }
  }

  async #handle(channel, { type, body }) {
    switch (type) {
      case Msg.FILE:
        return this.#onFile(channel, parseJson(body));
      case Msg.CHUNK:
        return this.#onChunk(channel, body);
      case Msg.END:
        return this.#onEnd(channel, parseJson(body));
      case Msg.ABORT:
        return this.#onAbort(parseJson(body));
      default:
        throw new ProtocolError(`Unexpected message ${type}.`);
    }
  }

  async #onFile(channel, { id, size }) {
    if (this.#current) throw new ProtocolError('A file is already in progress.');
    const expected = isId(id) ? this.#expected.get(id) : undefined;
    // Only files our user accepted, at exactly the announced size.
    if (!expected || size !== expected.size) throw new ProtocolError('Unexpected file.');
    this.#expected.delete(id);
    const current = { id, size, remaining: size, hash: createHash('sha256'), skip: expected.cancelled };
    current.root = expected.root;
    current.reported = 0;
    this.#current = current;
    if (current.skip) {
      await channel.sendJson(Msg.SKIP, { id });
      return;
    }
    current.writer = new SafeFileWriter(expected.root, expected.segments);
    try {
      await current.writer.open();
    } catch (err) {
      current.skip = true;
      await current.writer.abort();
      current.writer = null;
      current.error = `Could not save the file: ${err.message}`;
      await channel.sendJson(Msg.SKIP, { id, error: current.error });
    }
  }

  async #onChunk(channel, bytes) {
    const current = this.#current;
    if (!current) throw new ProtocolError('Data without a file.');
    if (bytes.length > current.remaining) throw new ProtocolError('More data than announced.');
    current.remaining -= bytes.length;
    if (current.skip) {
      // Cancelled: discard what was written, then drain until END/ABORT to keep the stream in sync.
      if (current.writer) {
        await current.writer.abort();
        current.writer = null;
      }
      return;
    }
    current.hash.update(bytes);
    try {
      await current.writer.write(bytes);
    } catch (err) {
      // A disk problem (full, removed drive) is this file's failure, not a broken link: say so and skip it.
      current.skip = true;
      current.error = `Could not save the file: ${err.message}`;
      await current.writer.abort();
      current.writer = null;
      await channel.sendJson(Msg.SKIP, { id: current.id, error: current.error });
      return;
    }
    const written = current.writer.bytesWritten;
    if (written - current.reported >= PROGRESS_EVERY_BYTES) {
      current.reported = written;
      this.emit('progress', { id: current.id, bytes: written });
      await channel.sendJson(Msg.PROGRESS, { id: current.id, bytes: written });
    }
  }

  async #onEnd(channel, { sha256 }) {
    const current = this.#current;
    if (!current) throw new ProtocolError('End without a file.');
    if (current.remaining !== 0) throw new ProtocolError('The file arrived incomplete.');
    this.#current = null;
    const { id } = current;
    if (current.skip) {
      await current.writer?.abort();
      this.emit('result', { id, ok: false, cancelled: !current.error, error: current.error });
      await channel.sendJson(Msg.RESULT, { id, ok: false, error: current.error ?? 'Cancelled' });
      return;
    }
    const digest = current.hash.digest();
    const expected = isSha256(sha256) ? Buffer.from(sha256, 'hex') : null;
    // Verify BEFORE committing: a corrupted file never appears in the folder.
    if (!expected || !timingSafeEqual(digest, expected)) {
      await current.writer.abort();
      const error = 'Checksum mismatch: the file was corrupted, so it was discarded.';
      this.emit('result', { id, ok: false, error });
      await channel.sendJson(Msg.RESULT, { id, ok: false, error });
      return;
    }
    let savedPath;
    try {
      savedPath = await current.writer.commit();
    } catch (err) {
      await current.writer.abort();
      const error = `Could not save the file: ${err.message}`;
      this.emit('result', { id, ok: false, error });
      await channel.sendJson(Msg.RESULT, { id, ok: false, error });
      return;
    }
    const savedAs = relative(current.root, savedPath).split(/[\\/]/).join('/');
    this.emit('progress', { id, bytes: current.size });
    this.emit('result', { id, ok: true, savedAs, savedPath });
    await channel.sendJson(Msg.PROGRESS, { id, bytes: current.size });
    await channel.sendJson(Msg.RESULT, { id, ok: true });
  }

  async #onAbort({ id }) {
    const current = this.#current;
    if (!current || current.id !== id) throw new ProtocolError('Abort for an unknown file.');
    this.#current = null;
    await current.writer?.abort();
    this.emit('result', { id, ok: false, cancelled: true });
  }
}
