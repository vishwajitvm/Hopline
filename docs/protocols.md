# Protocols

Hopline has four protocols: signaling, the WebRTC data channel, Direct mode (desktop app ↔ desktop app over TCP)
and the CLI wire protocol. Constants for the first two live in `packages/protocol/src`. Change them there and both
the server and the web app pick up the change.

## Signaling (WebSocket `/ws`)

> Source: `packages/protocol/src/signaling.js` · Diagrams:
> [03-webrtc-connection-sequence.mmd](../diagrams/03-webrtc-connection-sequence.mmd),
> [14-reconnect-and-resume.mmd](../diagrams/14-reconnect-and-resume.mmd)

JSON text messages, each with a string `type`. Max 64 KiB per message, 20 per second per connection with bursts of
120 (enough for the offers, answers and ICE candidates of the main connection and its lanes).

### Client → server (`ClientMessage`)

| `type`   | Fields          | Effect                                                                                        |
| -------- | --------------- | --------------------------------------------------------------------------------------------- |
| `create` | —               | Create a room; reply `created`                                                                |
| `join`   | `code`          | Join a room (case, spaces and dashes don't matter). Wrong codes cost from a per-client budget |
| `rejoin` | `code`, `token` | Reclaim your seat after a dropped connection (within `RECONNECT_GRACE_SECONDS`)               |
| `signal` | `data` (object) | Relay `data` to the other peer                                                                |
| `leave`  | —               | Leave on purpose: the room closes and the other side gets `peer-left`                         |
| `ping`   | —               | Keep-alive (every 25 s)                                                                       |

### Server → client (`ServerMessage`)

| `type`              | Fields                                     | Sent when                                                             |
| ------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `created`           | `code`, `token`, `iceServers` (STUN only)  | Your room exists                                                      |
| `joined`            | `code`, `token`, `iceServers` (incl. TURN) | You joined a room                                                     |
| `peer-joined`       | `iceServers` (incl. TURN)                  | Someone joined your room; you (the creator) send the WebRTC offer     |
| `rejoined`          | `code`, `peerPresent`, `iceServers`        | Your rejoin worked                                                    |
| `peer-disconnected` | —                                          | The other side's connection dropped; it may come back                 |
| `peer-reconnected`  | —                                          | It came back                                                          |
| `peer-left`         | —                                          | The other side left (or didn't come back in time); the room is closed |
| `signal`            | `data`                                     | Relayed from the other peer                                           |
| `error`             | `reason`, `message`                        | See below                                                             |

`token` is a 192-bit secret per seat; `iceServers` follow the WebRTC `RTCIceServer` shape. TURN credentials are
short-lived and only issued once a room has two members.

### Errors (`ErrorReason`)

| `reason`        | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `bad-message`   | Not JSON, binary frame, or `signal` without an object           |
| `unknown-type`  | Unrecognised `type` (including prototype keys like `__proto__`) |
| `invalid-code`  | Code isn't 6 characters from the room alphabet                  |
| `not-found`     | No room with that code                                          |
| `room-full`     | Room already has two devices                                    |
| `expired`       | Nobody joined before `ROOM_TTL_MINUTES`                         |
| `rate-limited`  | Too many messages, or too many wrong codes/tokens               |
| `not-in-room`   | `signal` sent before creating/joining                           |
| `rejoin-failed` | Room gone or token wrong                                        |

### `signal.data` payloads (opaque to the server)

Every WebRTC message carries a `session` id, so messages from an older connection attempt are ignored:

```json
{ "session": "9f2c…", "description": { "type": "offer", "sdp": "v=0…" } }
{ "session": "9f2c…", "candidate": { "candidate": "candidate:…", "sdpMid": "0", "sdpMLineIndex": 0 } }
{ "reconnect": true }
```

`reconnect` is sent by the guest to ask the host (who makes offers) to start a fresh connection.

Session ids are 16 hex characters. A **lane** connection (see below) uses `<main id>.L<n>` with `n` from 1 to 3,
e.g. `"9f2c4b1a7d3e5f60.L2"`. The guest accepts lane offers only for its **current** main session id; lanes of an
older session are ignored.

## Data channel (file transfer), protocol v3

> Source: `packages/protocol/src/transfer.js`, `apps/web/src/services/transfer/transfer-manager.js`,
> `apps/web/src/services/transfer/frames.js` · Diagrams:
> [04-browser-file-transfer-sequence.mmd](../diagrams/04-browser-file-transfer-sequence.mmd),
> [14-reconnect-and-resume.mmd](../diagrams/14-reconnect-and-resume.mmd)

### Channels and lanes

| Channel     | Label                                 | Carries                                              |
| ----------- | ------------------------------------- | ---------------------------------------------------- |
| Main        | `hopline` (`DATA_CHANNEL_LABEL`)      | Every JSON control message, plus binary file frames  |
| Lanes (0–3) | `hopline-lane` (`LANE_CHANNEL_LABEL`) | Binary file frames only; text messages are discarded |

Every channel is reliable and lives on its **own `RTCPeerConnection`**. The main channel is ordered; lanes are
**unordered** (frames carry their offset and the receiver reorders them), so one lost packet never holds back
later frames on that lane. Once the main
channel is open, the host (room creator) opens up to `MAX_LANES − 1` = 3 lane connections with session ids
`<main id>.L1` … `<main id>.L3` (see the `signal.data` payloads above), started 400 ms apart. Each lane is a
separate SCTP association with its own congestion control, so several lanes fill a long, lossy (e.g.
intercontinental) path better than one association can. On a fast local path the CPU is the limit instead, and lanes
change little.

**Lane authentication**: each device uses one DTLS certificate (ECDSA P-256, generated once per session) for the
main connection and all its lanes. When a lane's channel opens, each side compares the lane's remote certificate
fingerprint (from `getStats`) with the main connection's and closes the lane if they differ, so only a lane that
reaches the same device as the main connection carries frames. The safety code, computed from the main
connection's certificates, therefore covers the lanes. Without a certificate, no lanes are opened.

Lanes are best effort: a lane that hasn't opened after 20 s is given up, a failing lane never affects the main
connection, and all lanes close with the main connection. Control messages stay on the main channel so their order
is preserved. Both directions are independent: both peers can send at the same time and share the lanes.

### Messages

| Message                                                                                                                    | Direction                         | Purpose                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `{ t: "sync", v: 3, instance, direct, partial: [{id, offset}], done: [{id, ok, verified}], decided: [{batchId, accept}] }` | both, first on every main channel | What I've received; the peer resumes from there. `direct: true` = desktop app (Direct mode possible) |
| `{ t: "offer", batchId, files: [{id, name, path, size, mime}], total }`                                                    | sender → receiver                 | Ask permission                                                                                       |
| `{ t: "answer", batchId, accept }`                                                                                         | receiver → sender                 | User's decision                                                                                      |
| `{ t: "start", id, offset, slot }`                                                                                         | sender → receiver                 | Begin (or resume at `offset`) a file; `slot` tags its frames                                         |
| binary frames                                                                                                              | sender → receiver, any lane       | Exactly `size − offset` payload bytes in total, in any order                                         |
| `{ t: "end", id, sha256 }`                                                                                                 | sender → receiver                 | SHA-256 of the whole file (hex); may overtake the last frames                                        |
| `{ t: "progress", id, bytes }`                                                                                             | receiver → sender                 | Contiguous bytes durably written (drives flow control and retransmits)                               |
| `{ t: "ack", id, ok, verified, error? }`                                                                                   | receiver → sender                 | Final result                                                                                         |
| `{ t: "cancel", id }`                                                                                                      | either                            | Stop one file                                                                                        |
| `{ t: "direct-request", id }`                                                                                              | sender → receiver                 | Desktop apps only: may I send this accepted file over a Direct link? (instead of `start`)            |
| `{ t: "direct-ready", id, ok, link?: { port, addresses, key } }`                                                           | receiver → sender                 | Yes (listener details + one-time key), or no (`ok: false`: use `start`)                              |

A mismatching `v` in `sync` stops the session with a "different version" message. Messages whose `t` isn't one of
the known `TransferMessage` values are dropped before dispatch (`KNOWN_TYPES` in `transfer-manager.js`), so a
missing constant can never match an `undefined` type.

`direct-request` / `direct-ready` are only used when both sides announced `direct: true`; see
[Direct mode](#direct-mode-desktop--desktop-over-tcp) below.

### Binary frames

```
byte 0    uint32  slot          ┐
byte 4    uint32  offset high   ├ 12-byte header (FRAME_HEADER_BYTES), big-endian
byte 8    uint32  offset low    ┘
byte 12   payload               1 … CHUNK_BYTES − 12 = 65,524 bytes
```

- `offset` (`high · 2³² + low`) is where the payload sits in the file, so every frame is self-describing and can take
  any lane. A frame with no payload or an offset beyond `Number.MAX_SAFE_INTEGER` is dropped.
- `CHUNK_BYTES` (64 KiB) is the whole frame, header included: the SCTP message size every browser must accept.
- `slot` names one `start`. The sender's counter grows with every `start`, resumes included, so frames left over
  from an earlier attempt are recognised. Slots are 0 … 2³² − 1.

### Sender

- Reads 1 MiB blocks and **hashes them in file order**, whichever lane each frame then takes.
- Each frame goes to the open lane (main included) with the **emptiest send buffer**, provided that buffer is
  under the per-lane high-water mark: `HIGH_WATER_BYTES / open channels`, at least 2 MiB. Lanes share the buffer
  budget so the window's bytes sit on the network, not in local buffers.
- It waits (`bufferedamountlow` on any lane, or the next `progress`) when no lane has room, or when the bytes sent
  but not confirmed written, summed over **all files and lanes**, exceed `WINDOW_BYTES`.
- `end` goes out on the main channel as soon as the last frame is handed to a lane.
- **Retransmission**: for every frame sent on an extra lane the sender keeps a record (slot, offset, length). When
  that lane closes (or `send()` throws), every record that is still live (same `start`, file not finished or
  cancelled, not yet covered by `progress`) is **re-read from the file and resent on the remaining lanes**.
  Resends go before any new data. Frames on the main channel need no records: if it drops, everything resyncs.

### Receiver

- Frames are matched to a file by `slot`:
  - a slot newer than every `start` seen so far: a lane overtook the main channel, so the frame is **held** until
    its `start` arrives (at most 4,096 such slots and 2 × `WINDOW_BYTES` in total, beyond that the session stops as a
    flood);
  - an older slot: left over from an earlier attempt (already covered by a resync), dropped.
- A `start` whose slot isn't greater than the highest one seen is ignored (slots only grow), and held frames of
  older slots are discarded.
- Within a file: a frame past the declared size fails the file; a frame wholly below the contiguous offset is a
  duplicate (a resend) and is dropped, a partly overlapping one is trimmed; a frame ahead of it waits in a
  **reorder buffer keyed by offset**. Bytes are hashed and written **strictly in order**.
- The file finishes when contiguous bytes equal the size **and** `end` has arrived, in either order. The SHA-256 is
  then compared **before** the file is committed; a mismatch discards it.
- **Flow control is enforced on the receiver**: if bytes not yet on disk (reordered + unwritten) exceed
  2 × `WINDOW_BYTES`, or a frame lands more than 2 × `WINDOW_BYTES` ahead of the contiguous offset, the file fails
  ("ignored flow control"). More than 4 × `WINDOW_BYTES` (or 100,000 messages) queued unprocessed stops the session.

### Sync and resume

On every main channel open (the first connect and each reconnect), each side first sends `sync`; a sender sends
nothing else until it has the peer's. `partial` reports only **contiguous bytes flushed to disk**.

When the main connection drops, both sides drop its lanes, the in-flight records and every reorder buffer and held
frame. After the new connection's `sync`, the sender re-hashes bytes `0 … offset` locally and sends a new `start` at
the receiver's contiguous offset **with a new slot**, so any frame still arriving from the old attempt is ignored.
An epoch counter, bumped on every main channel change, makes send loops from the old connection stop instead of
sending. Losing only a lane needs no resync: retransmission covers it.

**The other page reloaded.** `instance` is a random id per page (per `TransferManager`). A different id from the
same room means the peer's page reloaded and remembers nothing. The side that noticed then:

- resets what it tracks of the peer's sending (the new page's slots start at 0 again), and fails files the old
  page was sending with "The other device reloaded the page…";
- puts every unfinished file it was sending (or that the old page had accepted) back to **awaiting** and offers it
  again, so the reloaded page shows the approval prompt again and the file is sent from the start.

### Limits (`TransferLimits`)

| Constant                               | Value         | Purpose                                                                                        |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `CHUNK_BYTES`                          | 64 KiB        | Size of each binary frame, header included                                                     |
| `FRAME_HEADER_BYTES`                   | 12            | Frame header: slot (4) + offset (8)                                                            |
| `MAX_LANES`                            | 4             | Main channel + up to 3 lane connections                                                        |
| `READ_BYTES`                           | 4 MiB         | Disk read size before splitting into frames                                                    |
| `HIGH_WATER_BYTES` / `LOW_WATER_BYTES` | 8 MiB / 1 MiB | Pause / resume on local channel buffers (shared across lanes, at least 2 MiB per lane)         |
| `WINDOW_BYTES`                         | 32 MiB        | Max bytes sent but not confirmed written, across all files and lanes (≈128 MB/s at 250 ms RTT) |
| `PROGRESS_EVERY_BYTES`                 | 2 MiB         | Receiver progress reports                                                                      |
| `WRITE_BATCH_BYTES`                    | 1 MiB         | Receiver disk write size                                                                       |
| `MAX_FILES_PER_OFFER`                  | 10,000        | Bound on one offer                                                                             |
| `MAX_FILE_BYTES`                       | 1 TiB         | Bound on a declared size                                                                       |
| `MAX_CONTROL_MESSAGE_BYTES`            | 2 MiB         | Bound on one JSON message                                                                      |

The buffering bounds (4,096 early slots, 2 × window across all files with 1 KiB charged per held frame) and the 2 MiB per-lane minimum are constants in
`transfer-manager.js`.

## Direct mode (desktop ↔ desktop over TCP)

> Source: `apps/desktop/src/direct/wire.js` (message table in its header), `receiver.js`, `sender.js`,
> `service.js`; data-channel side in `transfer-manager.js` (`#sendDirect`, `#onDirectRequest`) · Diagram:
> [16-direct-mode-sequence.mmd](../diagrams/16-direct-mode-sequence.mmd)

Between two desktop apps, a file's bytes can bypass WebRTC and go over a TCP connection between the two main
processes. The data channel still carries the offer, the answer and the handoff.

### Handoff on the data channel

1. Both pages announce `direct: true` in `sync` (the page has `window.hopline.direct`).
2. For an accepted file starting at offset 0, the sender sends `{ t: "direct-request", id }` instead of `start`
   (only if the file has a path on disk).
3. The receiver answers `ok: true` only if the file is in a batch it **accepted** into a native folder and is still
   queued. Its main process then listens (if not already) and expects exactly that file (folder id, sanitised path,
   exact size):

   ```json
   {
     "t": "direct-ready",
     "id": "f1",
     "ok": true,
     "link": { "port": 53817, "addresses": ["192.168.1.20", "127.0.0.1"], "key": "<base64 of 32 bytes>" }
   }
   ```

   The sender's page validates the reply (integer port, at most 16 addresses of at most 64 characters, key at most
   64 characters) and the engine checks it again (32-byte key, port 1–65535).

4. No valid reply within 10 s, `ok: false`, or a failed connect: the sender sends a normal `start`. A `start` for a
   file the receiver expects over Direct **cancels** that expectation. A `start` for a file it already saved (the
   link died before the sender heard the result) gets its `progress` + `ack` repeated.

The key is a fresh random 256-bit value per listener. It only travels over the DTLS-protected data channel (which
the safety code authenticates), never through the signaling server.

### Connecting

- The receiver listens on `0.0.0.0` (IPv4 only), random port, and advertises its non-loopback IPv4 addresses plus
  `127.0.0.1`.
- The sender keeps only addresses in `10/8`, `172.16/12`, `192.168/16`, `100.64/10` and `127/8` (never link-local
  or public), at most 16. If one of them is **its own** address, the receiver is on the same machine and it dials
  `127.0.0.1` only. Otherwise it dials only addresses on one of its own subnets (or in `100.64/10`), never
  loopback. All targets are tried at once (3 s timeout); the first to connect wins.
- **One connection per key**: the listener accepts exactly one connection that proves the key, then closes the
  listening socket and drops every other pending one. A key is never used for two connections, so counter nonces
  never repeat.

### Framing

The CLI's framing and cipher (see [CLI frames](#frames)): `uint32 length ‖ AES-256-GCM(type ‖ body) ‖ tag`, nonce =
direction (sender 0, receiver 1) ‖ 64-bit counter, frames over 1 MiB rejected. The key is the 32-byte Direct key
itself (no handshake: it already came over an authenticated channel). A missing, reordered, replayed or altered
frame fails authentication and ends the link. JSON bodies are capped at 4 KiB; ids match `[A-Za-z0-9_-]{1,64}`.

### Messages (`Msg`, version 1)

| Type       | Value | From     | Body                  | Meaning                                                                    |
| ---------- | ----- | -------- | --------------------- | -------------------------------------------------------------------------- |
| `HELLO`    | 1     | sender   | `{ "v": 1 }`          | First frame; decrypting it proves the sender holds the key                 |
| `READY`    | 2     | receiver | empty                 | Authenticated; files may follow                                            |
| `FILE`     | 3     | sender   | `{ id, size }`        | Start a file the receiver's user accepted (must match the expected size)   |
| `CHUNK`    | 4     | sender   | raw bytes (≤ 512 KiB) | File data, in order                                                        |
| `END`      | 5     | sender   | `{ sha256 }`          | SHA-256 of the whole file (hex), verified before the file is committed     |
| `ABORT`    | 6     | sender   | `{ id }`              | The sender cancelled this file (also sent after a `SKIP`)                  |
| `PROGRESS` | 7     | receiver | `{ id, bytes }`       | Bytes durably written (every 8 MiB, and at the end)                        |
| `RESULT`   | 8     | receiver | `{ id, ok, error? }`  | Verified and committed, or why not                                         |
| `SKIP`     | 9     | receiver | `{ id, error? }`      | Stop sending this file: cancelled by the user, or `error` (e.g. disk full) |

One file at a time per link; later files reuse the link. The receiver accepts `FILE` only for an id it expects, at
exactly that size, never two at once, and never more `CHUNK` bytes than announced; anything else is a protocol
error that closes the link. After a `SKIP` the receiver discards what it wrote and drains the remaining chunks until
`END`/`ABORT`, to keep the stream in sync.

### Writing and verifying

The receiver writes with the CLI's `SafeFileWriter` (`apps/cli/src/utils/safe-write.js`): sanitised path segments
inside the chosen folder, symlinked folders refused, an exclusive `.hopline-part` temp file, and a commit that never
overwrites (a name that already exists becomes `name (1).ext`, and so on). SHA-256 is compared with `timingSafeEqual` **before** the commit; a
mismatch deletes the temp file.

### Timeouts and loss

| Rule                          | Value                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Connect timeout (per address) | 3 s                                                                          |
| `READY` timeout               | 5 s                                                                          |
| Unauthenticated socket        | hard 10 s deadline; max 8 pending (oldest evicted), max 2 per remote address |
| Stall watchdog (sender)       | no `PROGRESS` / `RESULT` / `SKIP` for 20 s → link closed                     |
| TCP keep-alive                | 15 s                                                                         |

When the link is lost, the receiver deletes the partial file and reports it as lost, and the sender's page sends the
file again over WebRTC from the start (Direct mode stays off for the rest of the session).

## CLI wire protocol v2

> Source: `apps/cli/src/core/*` · Diagrams: [09-cli-transfer-sequence.mmd](../diagrams/09-cli-transfer-sequence.mmd),
> [10-cli-key-derivation.mmd](../diagrams/10-cli-key-derivation.mmd)

### Discovery (UDP, port 41899)

```json
{ "app": "hopline", "v": 1, "nameplate": "42", "port": 53211 }
```

Broadcast once per second by the sender. Only the number is public; the three words never leave the device. Ports
outside 1–65535 are ignored. Override with `HOPLINE_DISCOVERY_PORT` on both sides.

### Handshake: CPace over ristretto255 (cleartext, then key confirmation)

| From     | Bytes                                             |
| -------- | ------------------------------------------------- |
| Sender   | `"HOPL"` ‖ `0x02` ‖ senderNonce (16)              |
| Receiver | `"HOPL"` ‖ `0x02` ‖ receiverNonce (16) ‖ Y_r (32) |
| Sender   | Y_s (32)                                          |

```
G          = ristretto255.hash_to_curve(len(code) ‖ code ‖ senderNonce ‖ receiverNonce, DST = "hopline/v2/cpace-ristretto255")
Y_i        = y_i · G                       (y_i random, non-zero, per connection)
K          = y_s · Y_r = y_r · Y_s          (identity points rejected)
sessionKey = HKDF-SHA256(K, salt = senderNonce ‖ receiverNonce, info = "hopline/v2 session key" ‖ Y_s ‖ Y_r)
```

Implemented with the audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) library.

### Frames

```
uint32 length (big-endian) ‖ AES-256-GCM( type (1 byte) ‖ body ) ‖ tag (16)
nonce = direction (uint32: sender 0, receiver 1) ‖ counter (uint64, starts at 0)
```

Frames above 1 MiB are rejected before allocation.

### Messages (`MessageType`)

| Type                | Value | From     | Body                                                            |
| ------------------- | ----- | -------- | --------------------------------------------------------------- |
| `HELLO`             | 1     | receiver | `{"v":2}` (key confirmation)                                    |
| `MANIFEST`          | 2     | sender   | `{"files":[{"path":"photos/a.jpg","size":123}],"total":123}`    |
| `ACCEPT` / `REJECT` | 3 / 4 | receiver | empty                                                           |
| `CHUNK`             | 5     | sender   | raw file bytes (≤ 256 KiB)                                      |
| `DONE`              | 6     | both     | empty: sender first, receiver confirms after writing everything |

## Versioning

- The CLI handshake carries a version byte; v1 and v2 refuse each other with a clear message.
- Direct mode's `HELLO` carries `v` (now 1); a mismatch drops the connection and the file falls back to WebRTC.
  `direct` in `sync` is optional, so a page without it simply never gets a `direct-request`.
- The data channel `sync` carries `v` (now 3); a mismatch stops the session cleanly, so a v2 tab and a v3 tab
  ask each other to reload instead of misreading frames.
- Signaling messages ignore unknown fields, so optional additions stay compatible.
