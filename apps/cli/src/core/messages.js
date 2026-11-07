import { encodeFrame, writeWithBackpressure } from './framing.js';
import { ProtocolError } from './errors.js';

/**
 * Encrypted messages exchanged after the handshake. Plaintext layout: [1-byte type][body].
 *
 *   receiver → HELLO                 proves the receiver knows the code
 *   sender   → MANIFEST {files,total} proves the sender knows the code; lists what's coming
 *   receiver → ACCEPT | REJECT
 *   sender   → CHUNK × N             raw file bytes, files in manifest order
 *   sender   → DONE
 *   receiver → DONE                  everything was written to disk
 */
export const MessageType = Object.freeze({
  HELLO: 1,
  MANIFEST: 2,
  ACCEPT: 3,
  REJECT: 4,
  CHUNK: 5,
  DONE: 6,
});

const EMPTY = Buffer.alloc(0);

export async function writeMessage(socket, cipher, type, body = EMPTY) {
  const sealed = cipher.seal(Buffer.of(type), body);
  await writeWithBackpressure(socket, encodeFrame(sealed));
}

export async function readMessage(reader, cipher) {
  const plain = cipher.open(await reader.readFrame());
  if (plain.length === 0) throw new ProtocolError('Received an empty message.');
  return { type: plain[0], body: plain.subarray(1) };
}

/** Reads the next message and fails unless it has one of the expected types. */
export async function expectMessage(reader, cipher, ...types) {
  const message = await readMessage(reader, cipher);
  if (!types.includes(message.type)) {
    throw new ProtocolError(`Unexpected message type ${message.type} (expected ${types.join(' or ')}).`);
  }
  return message;
}

export const encodeJson = (value) => Buffer.from(JSON.stringify(value), 'utf8');

export function decodeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ProtocolError('Received malformed JSON.');
  }
}
