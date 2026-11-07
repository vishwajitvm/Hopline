import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { ProtocolError } from '@hopline/cli/src/core/errors.js';
import { lanInterfaces } from '@hopline/cli/src/utils/network.js';
import { CHUNK_BYTES, DIRECT_VERSION, KEY_BYTES, Msg, Role, SecureChannel, isId, parseJson } from './wire.js';

const CONNECT_TIMEOUT_MS = 3000;
/**
 * A link whose receiver confirms no progress for this long is treated as dead (e.g. a firewall that lets
 * the connection open but throttles or drops its data), and the file falls back to WebRTC.
 */
const STALL_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 5000;
const KEEPALIVE_MS = 15_000;
const MAX_ADDRESSES = 16;

/** The link to the receiver died (network change, app closed): the caller falls back to WebRTC. */
export class LinkLostError extends Error {
  name = 'LinkLostError';
  constructor(message = 'The direct link was lost.') {
    super(message);
  }
}

/**
 * Addresses a peer may ask us to connect to: private LAN ranges, CGNAT/Tailscale (100.64/10) and loopback.
 * Never link-local (169.254.x.x includes cloud metadata endpoints) or public addresses, so a hostile peer
 * can't point our app at arbitrary hosts.
 */
export function isAllowedAddress(address) {
  if (net.isIPv4(address) === false) return false;
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function connectOne(address, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => socket.destroy(new Error('timed out')), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Which of the receiver's addresses to dial. If it lists one of our own addresses it runs on this machine,
 * so use loopback only (fastest, and no firewall involved). Otherwise dial only its remote LAN addresses,
 * never loopback (which would reach some other program on our own machine).
 */
export function pickTargets(addresses, interfaces = lanInterfaces()) {
  const allowed = addresses.filter(isAllowedAddress).slice(0, MAX_ADDRESSES);
  const own = new Set(interfaces.map((iface) => iface.address));
  if (allowed.some((address) => own.has(address))) return ['127.0.0.1'];
  // Remote receivers must be on one of our own subnets (or a 100.64/10 overlay such as Tailscale): a hostile
  // peer can't point us at arbitrary hosts or at services on our own machine.
  return allowed.filter(
    (address) =>
      !address.startsWith('127.') &&
      (isOverlay(address) || interfaces.some((iface) => sameSubnet(address, iface))),
  );
}

const toInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
const isOverlay = (address) => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
function sameSubnet(address, { address: mine, netmask }) {
  if (!net.isIPv4(mine) || !net.isIPv4(netmask ?? '')) return false;
  const mask = toInt(netmask);
  return (toInt(address) & mask) >>> 0 === (toInt(mine) & mask) >>> 0;
}

/** Tries every address at once; the first to connect wins, the rest are closed. */
async function connectAny(addresses, port) {
  const attempts = addresses.map((address) => connectOne(address, port));
  let winner;
  try {
    winner = await Promise.any(attempts);
  } catch {
    throw new LinkLostError('Could not reach the other device directly.');
  }
  for (const attempt of attempts) {
    attempt.then((socket) => socket !== winner && socket.destroy()).catch(() => {});
  }
  return winner;
}

/**
 * The sending end of one Direct link. Streams files from disk, one at a time, hashing as it reads.
 *
 * Events: 'progress' { id, bytes } (bytes the receiver confirmed written), 'closed' { error? }.
 */
export class DirectLink extends EventEmitter {
  #channel;
  #closed = false;
  #current = null;
  #queue = Promise.resolve();
  /** Files already settled: a late PROGRESS/RESULT for them (e.g. crossing a SKIP) is harmless. */
  #finished = new Set();

  #stallTimeoutMs = STALL_TIMEOUT_MS;

  static async connect({ addresses, port, key }, { stallTimeoutMs = STALL_TIMEOUT_MS } = {}) {
    const keyBytes = Buffer.from(String(key ?? ''), 'base64');
    if (keyBytes.length !== KEY_BYTES) throw new ProtocolError('Invalid key.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProtocolError('Invalid port.');
    const targets = pickTargets(Array.isArray(addresses) ? addresses : []);
    if (targets.length === 0) throw new LinkLostError('No reachable address for the other device.');
    const socket = await connectAny(targets, port);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, KEEPALIVE_MS);
    socket.on('error', () => {});
    const channel = new SecureChannel(socket, keyBytes, Role.SENDER);
    try {
      await channel.sendJson(Msg.HELLO, { v: DIRECT_VERSION });
      const timer = setTimeout(() => socket.destroy(), READY_TIMEOUT_MS);
      const ready = await channel.next().finally(() => clearTimeout(timer));
      if (ready.type !== Msg.READY) throw new ProtocolError('Bad greeting.');
    } catch (err) {
      socket.destroy();
      throw err instanceof ProtocolError ? err : new LinkLostError();
    }
    const link = new DirectLink(channel);
    link.#stallTimeoutMs = stallTimeoutMs;
    return link;
  }

  constructor(channel) {
    super();
    this.#channel = channel;
    void this.#readLoop();
  }

  get closed() {
    return this.#closed;
  }

  /** Sends one file (queued behind any file already sending). Resolves to { ok, error?, cancelled? }. */
  sendFile({ id, path, size }) {
    const run = this.#queue.then(() => this.#send({ id, path, size }));
    this.#queue = run.catch(() => {});
    return run;
  }

  cancel(id) {
    if (this.#current?.id === id) this.#current.cancelled = true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.close();
  }

  async #send({ id, path, size }) {
    if (this.#closed) throw new LinkLostError();
    if (!isId(id)) throw new Error('Invalid file id.');
    const info = await stat(path);
    if (!info.isFile() || info.size !== size) throw new Error('The file changed since it was offered.');

    let settle;
    const outcome = new Promise((resolve, reject) => (settle = { resolve, reject }));
    outcome.catch(() => {}); // the link can die before we start awaiting it; we still await it below
    const current = { id, cancelled: false, skipped: false, settle, lastProgress: Date.now() };
    this.#current = current;
    const watchdog = setInterval(() => {
      if (Date.now() - current.lastProgress > this.#stallTimeoutMs) this.close();
    }, 1000);
    try {
      await this.#channel.sendJson(Msg.FILE, { id, size });
      const hash = createHash('sha256');
      let sent = 0;
      const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });
      try {
        for await (const chunk of stream) {
          if (current.cancelled || current.skipped || this.#closed) break;
          if (sent + chunk.length > size) throw new Error('The file grew while it was being sent.');
          hash.update(chunk);
          await this.#channel.send(Msg.CHUNK, chunk);
          sent += chunk.length;
        }
      } finally {
        stream.destroy();
      }
      if (this.#closed) throw new LinkLostError();
      if (current.cancelled || current.skipped) {
        await this.#channel.sendJson(Msg.ABORT, { id });
        if (current.cancelled && !current.skipped) settle.resolve({ ok: false, cancelled: true });
      } else {
        if (sent !== size) throw new Error('The file shrank while it was being sent.');
        await this.#channel.sendJson(Msg.END, { sha256: hash.digest('hex') });
      }
      return await outcome;
    } catch (err) {
      if (err instanceof LinkLostError || this.#closed) throw new LinkLostError();
      // A local read error mid-file: the stream can't be resynced, so end the link (the caller falls back).
      this.close();
      throw err;
    } finally {
      clearInterval(watchdog);
      this.#finished.add(id);
      if (this.#current === current) this.#current = null;
    }
  }

  async #readLoop() {
    try {
      for (;;) {
        const { type, body } = await this.#channel.next();
        const msg = parseJson(body);
        const current = this.#current;
        if (!isId(msg.id)) throw new ProtocolError('Message without a valid file id.');
        if (current?.id !== msg.id) {
          if (this.#finished.has(msg.id)) continue;
          throw new ProtocolError('Message for an unknown file.');
        }
        current.lastProgress = Date.now();
        if (type === Msg.PROGRESS) {
          if (Number.isSafeInteger(msg.bytes) && msg.bytes >= 0)
            this.emit('progress', { id: msg.id, bytes: msg.bytes });
        } else if (type === Msg.RESULT) {
          current.settle.resolve({
            ok: msg.ok === true,
            error: typeof msg.error === 'string' ? msg.error.slice(0, 200) : undefined,
          });
        } else if (type === Msg.SKIP) {
          current.skipped = true;
          const error = typeof msg.error === 'string' ? msg.error.slice(0, 200) : null;
          current.settle.resolve(error ? { ok: false, error } : { ok: false, cancelled: true });
        } else {
          throw new ProtocolError(`Unexpected message ${type}.`);
        }
      }
    } catch (err) {
      const wasClosed = this.#closed;
      this.#closed = true;
      this.#channel.close();
      this.#current?.settle.reject(new LinkLostError());
      if (!wasClosed) this.emit('closed', { error: err?.message });
    }
  }
}
