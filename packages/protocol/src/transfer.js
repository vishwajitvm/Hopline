/**
 * File transfer protocol v3. Control messages are JSON strings on the main data channel ('hopline').
 * File bytes travel as binary frames on the main channel AND on up to MAX_LANES - 1 extra "lane" channels
 * (each on its own RTCPeerConnection, so each has its own SCTP congestion control: several lanes fill a
 * long, lossy intercontinental path far better than one). Both peers can send at the same time.
 *
 * Binary frame: [uint32 slot][uint32 offset high][uint32 offset low][payload], big-endian.
 * `slot` names one `start` (it increases with every start, including resumes), so frames left over from an
 * earlier attempt are recognised and dropped. Frames may arrive in any order and before their `start`; the
 * receiver reorders them and hashes/writes strictly in order. `end` may also overtake the last frames.
 *
 * On every main channel open (first connect and after each reconnect), each side first sends SYNC
 * describing what it has received. A sender sends nothing else until it has the peer's SYNC.
 *
 *   ⇄ { t: 'sync', v: 3, partial: [{ id, offset }], done: [{ id, ok, verified }], decided: [{ batchId, accept }] }
 *
 *   → { t: 'offer', batchId, files: [{ id, name, path, size, mime }], total }
 *   ← { t: 'answer', batchId, accept }
 *   → { t: 'start', id, offset, slot }    // offset > 0 resumes a partially received file
 *   → <frames> …                          // exactly size − offset payload bytes, on any lane
 *   → { t: 'end', id, sha256 }            // SHA-256 of the whole file (hex)
 *   ← { t: 'progress', id, bytes }        // contiguous bytes durably written; drives the flow-control window
 *   ← { t: 'ack', id, ok, verified, error? }
 *   ⇄ { t: 'cancel', id }                 // either side stops one file
 *
 * Direct mode (both peers are the desktop app; both say `direct: true` in SYNC). Instead of `start`:
 *   → { t: 'direct-request', id }                       // may I send this file over a direct TCP link?
 *   ← { t: 'direct-ready', id, ok, link?: { port, addresses, key } }
 * The receiver's app listens with a fresh 256-bit key that only ever travels over this data channel; the
 * sender's app connects and streams the file natively (AES-256-GCM, SHA-256 verified before commit). Any
 * failure falls back to a normal `start` over WebRTC, which also cancels the receiver's direct expectation.
 */

export const DATA_CHANNEL_LABEL = 'hopline';
export const DATA_PROTOCOL_VERSION = 3;
/** Label of the extra data channels that carry only file frames. */
export const LANE_CHANNEL_LABEL = 'hopline-lane';

export const TransferMessage = Object.freeze({
  SYNC: 'sync',
  OFFER: 'offer',
  ANSWER: 'answer',
  START: 'start',
  END: 'end',
  PROGRESS: 'progress',
  ACK: 'ack',
  CANCEL: 'cancel',
  DIRECT_REQUEST: 'direct-request',
  DIRECT_READY: 'direct-ready',
});

export const TransferLimits = Object.freeze({
  /**
   * Size of each binary frame, header included. 64 KiB is the SCTP message size every browser must accept
   * (RFC 8841's default when the peer doesn't announce one).
   */
  CHUNK_BYTES: 64 * 1024,
  /** Frame header: slot (4 bytes) + offset (8 bytes). */
  FRAME_HEADER_BYTES: 12,
  /** Main channel plus extra lane connections used for file data. */
  MAX_LANES: 4,
  /** Disk read size before splitting into frames (4 MiB reads measured ~2.5x faster than 1 MiB). */
  READ_BYTES: 4 * 1024 * 1024,
  /** Pause sending on a channel when its buffer exceeds this (browsers fail send() at 16 MiB)… */
  HIGH_WATER_BYTES: 8 * 1024 * 1024,
  /** …and resume once it drains below this. */
  LOW_WATER_BYTES: 1024 * 1024,
  /**
   * Max bytes sent but not yet confirmed written by the receiver, across all files and lanes. Bounds receiver
   * memory (reorder buffer + unwritten data), and with ~250 ms intercontinental RTT still allows ~128 MB/s.
   */
  WINDOW_BYTES: 32 * 1024 * 1024,
  /** Receiver reports durable progress at least this often. */
  PROGRESS_EVERY_BYTES: 2 * 1024 * 1024,
  /** Receiver batches small chunks into writes of this size. */
  WRITE_BATCH_BYTES: 1024 * 1024,
  MAX_FILE_NAME_LENGTH: 255,
  MAX_PATH_LENGTH: 1024,
  MAX_FILES_PER_OFFER: 10_000,
  /** Largest file accepted (1 TiB) — a sanity bound on peer-declared sizes. */
  MAX_FILE_BYTES: 1024 ** 4,
  /** Max control message size accepted from the peer. */
  MAX_CONTROL_MESSAGE_BYTES: 2 * 1024 * 1024,
});
