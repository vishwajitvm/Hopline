import { ConnectionClosedError, ProtocolError } from './errors.js';

/** Largest frame we accept: a 256 KiB file chunk plus headroom for the header and auth tag. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Length-prefixed frame: [uint32 big-endian length][payload]. */
export function encodeFrame(payload) {
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Resolves once the socket can take more data; rejects if it closes first. */
export function waitForDrain(socket) {
  if (socket.destroyed) return Promise.reject(new ConnectionClosedError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('drain', onDrain);
      socket.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ConnectionClosedError());
    };
    socket.on('drain', onDrain);
    socket.on('close', onClose);
  });
}

/** Writes with backpressure: waits when the kernel buffer is full instead of growing memory without bound. */
export async function writeWithBackpressure(socket, data) {
  if (!socket.write(data)) await waitForDrain(socket);
}

/**
 * Reads exact byte counts and whole frames from a stream. Pull-based (async iterator),
 * so the socket is naturally paused while we're busy writing to disk.
 */
export class FrameReader {
  #iterator;
  #chunks = [];
  #buffered = 0;

  constructor(stream) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async readExact(length) {
    while (this.#buffered < length) {
      const { value, done } = await this.#iterator.next();
      if (done) throw new ConnectionClosedError();
      this.#chunks.push(value);
      this.#buffered += value.length;
    }
    this.#buffered -= length;

    // Fast path: the bytes are all in the first chunk — return a view, no copy.
    const first = this.#chunks[0];
    if (first.length >= length) {
      if (first.length === length) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }

    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.#chunks[0];
      const take = Math.min(chunk.length, length - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    return out;
  }

  async readFrame(maxBytes = MAX_FRAME_BYTES) {
    const header = await this.readExact(4);
    const length = header.readUInt32BE(0);
    if (length > maxBytes)
      throw new ProtocolError(`Frame of ${length} bytes exceeds the ${maxBytes}-byte limit.`);
    return this.readExact(length);
  }
}
