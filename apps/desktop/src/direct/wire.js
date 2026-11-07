import { Direction, FrameCipher } from '@hopline/cli/src/core/crypto.js';
import { ProtocolError } from '@hopline/cli/src/core/errors.js';
import { FrameReader, encodeFrame, writeWithBackpressure } from '@hopline/cli/src/core/framing.js';

/**
 * Direct-mode wire protocol: one TCP connection per direction between two desktop apps.
 *
 * The receiver creates a fresh random 256-bit key per listener and hands it to the sender over the
 * WebRTC data channel (end-to-end encrypted and authenticated; the safety code verifies it). Every message
 * is a length-prefixed AES-256-GCM frame with counter nonces (the CLI's FrameCipher), so a missing,
 * reordered, replayed or altered frame fails authentication. A listener accepts exactly one authenticated
 * connection and then stops listening, so a key is never used for two connections (no nonce reuse).
 *
 *   sender   → HELLO { v }                 proves it holds the key
 *   receiver → READY
 *   sender   → FILE { id, size }           a file the receiver's user accepted (announced via the data channel)
 *   sender   → CHUNK × n                   raw bytes, ≤ CHUNK_BYTES each
 *   sender   → END { sha256 }              SHA-256 of the whole file, verified before the file is committed
 *   sender   → ABORT { id }                the sender cancelled this file
 *   receiver → PROGRESS { id, bytes }      bytes durably written
 *   receiver → RESULT { id, ok, error? }   verified and committed (or why not)
 *   receiver → SKIP { id }                 the receiver cancelled this file: stop sending it
 */
export const DIRECT_VERSION = 1;
export const KEY_BYTES = 32;
/** Plaintext bytes per CHUNK frame (the frame limit is 1 MiB including header and tag). */
export const CHUNK_BYTES = 512 * 1024;
/** JSON message bodies are tiny; anything bigger is hostile. */
const MAX_JSON_BYTES = 4096;

export const Msg = Object.freeze({
  HELLO: 1,
  READY: 2,
  FILE: 3,
  CHUNK: 4,
  END: 5,
  ABORT: 6,
  PROGRESS: 7,
  RESULT: 8,
  SKIP: 9,
});

export const Role = Object.freeze({ SENDER: Direction.SENDER, RECEIVER: Direction.RECEIVER });

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
export const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** An authenticated, encrypted message channel over one TCP socket. */
export class SecureChannel {
  #socket;
  #cipher;
  #reader;

  constructor(socket, key, role) {
    this.#socket = socket;
    this.#cipher = new FrameCipher(key, role);
    this.#reader = new FrameReader(socket);
  }

  get socket() {
    return this.#socket;
  }

  /**
   * Seals and writes synchronously (so frames hit the socket in counter order even when several async
   * callers send), then resolves once the kernel buffer has room again.
   */
  send(type, body = Buffer.alloc(0)) {
    return writeWithBackpressure(this.#socket, encodeFrame(this.#cipher.seal(Buffer.of(type), body)));
  }

  sendJson(type, value) {
    return this.send(type, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /** The next message: { type, body }. Throws on tampering, truncation or a closed socket. */
  async next() {
    const plain = this.#cipher.open(await this.#reader.readFrame());
    if (plain.length === 0) throw new ProtocolError('Received an empty message.');
    return { type: plain[0], body: plain.subarray(1) };
  }

  close() {
    this.#socket.destroy();
  }
}

export function parseJson(body) {
  if (body.length > MAX_JSON_BYTES) throw new ProtocolError('Message too large.');
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ProtocolError('Received malformed JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Received a malformed message.');
  }
  return value;
}
