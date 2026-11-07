# Architecture

> Diagrams: [01-system-overview.mmd](../diagrams/01-system-overview.mmd),
> [02-repository-structure.mmd](../diagrams/02-repository-structure.mmd)

## Goals

1. **File data never passes through a server.** The server only helps devices find each other.
2. **Works with nothing installed.** Any modern browser is a client.
3. **Works with no server at all** on a local network (CLI).
4. **Easy to run**: one Docker command, or `npm install && npm run dev`.

## The pieces

| Piece    | Folder              | Role                                                                                      | Talks to                                           |
| -------- | ------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Protocol | `packages/protocol` | Shared constants, message types, room-code rules                                          | Imported by server and web                         |
| Backend  | `apps/server`       | Signaling: rooms, relays WebRTC setup messages, health check, optional static hosting     | Web and desktop clients over WebSocket             |
| Frontend | `apps/web`          | React UI, WebRTC connection, file transfer engine                                         | Signaling server, then the other peer directly     |
| Desktop  | `apps/desktop`      | Electron window around the frontend build, plus Direct mode (native TCP) and real folders | Same as the frontend; another desktop app over TCP |
| CLI      | `apps/cli`          | Discovery + encrypted TCP transfer on a LAN                                               | Another CLI directly                               |

The CLI depends on nothing else in the repo. Its only dependency is the audited `@noble/curves` library, used for the
CPace key exchange. The desktop app's Direct mode reuses the CLI's frame cipher, framing, path sanitising and
safe-write code (`@hopline/cli`), so there is one implementation of each.

## Three transport paths

### 1. Web and desktop: WebRTC

```
Device A ──(WebSocket: create/join, offer/answer, ICE)──▶ Signaling server ◀──(WebSocket)── Device B
Device A ◀════════════════ WebRTC data channel, DTLS-encrypted, direct ════════════════▶ Device B
Device A ◀════════ + up to 3 "lane" connections carrying file frames (same route rules) ═══════▶ Device B
```

The main connection carries control messages and file data. Once it is open, the host adds up to three extra
**lane** connections, each a separate `RTCPeerConnection` with its own congestion control, to fill long or lossy
routes faster. Frames carry their file offset, so the receiver reorders them and verifies SHA-256 before saving.
Details: [protocols.md](protocols.md#data-channel-file-transfer-protocol-v3).

- Signaling sequence: [03-webrtc-connection-sequence.mmd](../diagrams/03-webrtc-connection-sequence.mmd)
- File transfer sequence: [04-browser-file-transfer-sequence.mmd](../diagrams/04-browser-file-transfer-sequence.mmd)
- Reconnect and resume: [14-reconnect-and-resume.mmd](../diagrams/14-reconnect-and-resume.mmd)

STUN servers let each browser learn its public address. When two networks block direct connections, a TURN
server relays the encrypted traffic. The signaling server hands out short-lived relay credentials (see [turn.md](turn.md)).

### 2. Desktop ↔ desktop: Direct mode (TCP)

```
App A ◀════ WebRTC data channel: offer/answer, direct-request → direct-ready { port, addresses, key } ════▶ App B
App A main process ═══════ TCP, AES-256-GCM per frame (one-time 256-bit key), SHA-256 per file ═══════▶ App B
```

When both sides run the desktop app, the pages still pair over WebRTC, but each accepted file's bytes go over a TCP
link between the two **main processes**, straight from disk to disk (about 120 MiB/s measured, versus ~13 MB/s
for a WebRTC data channel). The key travels only over the authenticated data channel. If the apps can't reach each
other (different networks, firewall) or the link drops or stalls, the file goes over WebRTC instead. Details:
[desktop.md](desktop.md#direct-mode), [protocols.md](protocols.md#direct-mode-desktop--desktop-over-tcp),
[16-direct-mode-sequence.mmd](../diagrams/16-direct-mode-sequence.mmd).

### 3. CLI: direct TCP on the LAN

```
Sender ──(UDP broadcast: "nameplate 42 is on port 53211")──▶ Receiver
Sender ◀═══════ TCP, CPace PAKE (ristretto255) + AES-256-GCM per message ═══════▶ Receiver
```

- Sequence: [09-cli-transfer-sequence.mmd](../diagrams/09-cli-transfer-sequence.mmd)
- Key derivation: [10-cli-key-derivation.mmd](../diagrams/10-cli-key-derivation.mmd)

## Design principles used throughout

| Principle                              | Where you can see it                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Single source of truth** for formats | `@hopline/protocol` is imported by both server and web; nothing hard-codes message strings                                         |
| **Layering**: UI ↔ lifecycle ↔ network | Web: `components` → `hooks` → `services`. Server: `app` → `signaling` → `lib`                                                      |
| **Pure, testable cores**               | `RoomRegistry`, `TokenBucket`, `session-reducer`, `FrameCipher`, `FrameReader` take injected clocks/randomness and have no I/O     |
| **Validate at the boundary**           | Server config (`config.js`), signaling messages, room codes, peer-supplied file names and sizes, CLI manifests                     |
| **Backpressure everywhere**            | Per-lane data channel high/low water marks + a 32 MiB window across lanes; CLI waits for socket `drain`; file writes wait for disk |
| **Fail loudly, recover gracefully**    | Clear errors to the user; a lost signaling connection after peers connect doesn't end the session                                  |
| **No unnecessary dependencies**        | Server: `ws` only. CLI: `@noble/curves` (PAKE). Web: React, `qrcode` and `hash-wasm` (both lazy-loaded)                            |

## Request lifecycles (web)

1. `useHoplineSession` opens a `SignalingClient` and sends `create` or `join`.
2. When both peers are in the room, the creator's `PeerSession` makes a WebRTC offer, relayed by the server.
3. When the data channel opens, a `TransferManager` is attached to it and the UI moves to **Connected**. The host
   then opens up to three lane connections; each open lane is added to the `TransferManager`.
4. Files are queued, framed and streamed over all open lanes. Each received file is verified and acknowledged.
   Between two desktop apps, each file first tries a Direct link (TCP between the main processes) and uses the
   lanes only if that isn't possible.
5. If the main channel closes, the UI shows **Reconnecting** and a new connection resumes the transfers. If the peer
   leaves (or nothing reconnects in time), the session ends and received files stay saveable until **Start over**.

Phases are in [05-session-state-machine.mmd](../diagrams/05-session-state-machine.mmd); per-file states are in
[06-transfer-status-states.mmd](../diagrams/06-transfer-status-states.mmd).

## Deployment shapes

| Shape                            | Processes                                     | When to use                             |
| -------------------------------- | --------------------------------------------- | --------------------------------------- |
| Docker Compose                   | `web` (nginx) + `server` (Node)               | Default; matches production             |
| `npm start`                      | One Node process serving UI + signaling       | Simple VPS or local demo without Docker |
| `npm run dev`                    | Server + Vite dev server                      | Development                             |
| Static hosting + separate server | Any CDN for `apps/web/dist`, server elsewhere | Set `VITE_SIGNALING_URL` at build time  |

See [11-docker-deployment.mmd](../diagrams/11-docker-deployment.mmd).
