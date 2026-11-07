/**
 * Binary file frames (protocol v3): [uint32 slot][uint32 offset high][uint32 offset low][payload].
 * The offset makes every frame self-describing, so frames can travel on different lanes and arrive in any
 * order; the slot ties them to one `start` so leftovers from an earlier attempt are recognised.
 */
import { TransferLimits } from '@hopline/protocol';

export const { FRAME_HEADER_BYTES } = TransferLimits;
const TWO_32 = 2 ** 32;

/** Builds one frame. Copies the payload (the browser keeps the buffer until it's sent). */
export function encodeFrame(slot, offset, payload) {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, slot);
  view.setUint32(4, Math.floor(offset / TWO_32));
  view.setUint32(8, offset >>> 0);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/** Parses a frame from the peer. Returns null for anything malformed (too short, empty, unsafe offset). */
export function decodeFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length <= FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES);
  const offset = view.getUint32(4) * TWO_32 + view.getUint32(8);
  if (!Number.isSafeInteger(offset)) return null;
  return { slot: view.getUint32(0), offset, payload: bytes.subarray(FRAME_HEADER_BYTES) };
}
