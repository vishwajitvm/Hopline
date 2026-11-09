# Frontend: web app

> Code: `apps/web` · Diagrams: [08-frontend-architecture.mmd](../diagrams/08-frontend-architecture.mmd),
> [05-session-state-machine.mmd](../diagrams/05-session-state-machine.mmd),
> [06-transfer-status-states.mmd](../diagrams/06-transfer-status-states.mmd)

React 19 + Vite 6, plain JavaScript (JSX), no UI framework. Dependencies: `react`, `react-dom`, `qrcode`
(lazy-loaded) and `@hopline/protocol`.

## Folder layout

```
apps/web/
├── Dockerfile, nginx/default.conf.template   Docker image (see docker.md)
├── index.html, public/favicon.svg
├── vite.config.js                            Dev server (port 5290, /ws proxy), root .env, relative build paths
├── test/transfer-manager.test.js             Transfer engine tests (Node, fake data channels, malicious peers)
├── test/direct-mode.test.js                  TransferManager + the desktop's real TCP Direct engine, fallback cases
└── src/
    ├── main.jsx, app/App.jsx                 Mount; choose Home or Room view; storage cleanup at startup
    ├── components/                           Rendering only: no network code
    │   ├── layout/   Header, Footer, Logo
    │   ├── common/   Icon (inline SVG set)
    │   ├── home/     HomeView (create / join / "Hide my IP address")
    │   └── room/     RoomView, ShareCard, StatusBadge, ConnectionBadge, SafetyCode, ReconnectBanner,
    │                 IncomingOffers, Dropzone (files + folders), TransferList, TransferItem
    ├── hooks/
    │   ├── useHoplineSession.js              Whole lifecycle incl. automatic reconnection
    │   ├── useTransferGuards.js              Leave-page warning + screen wake lock while transferring
    │   ├── useInviteLink.js, useQrCode.js, useCopyToClipboard.js
    ├── state/session-reducer.js              Phase (incl. reconnecting), SessionAction, reducer
    ├── services/                             Network + storage logic, framework-free
    │   ├── signaling-client.js               Self-healing WebSocket (rejoin with seat token, heartbeat, queue)
    │   ├── connection-manager.js             Replaces broken WebRTC sessions; host offers, guest answers; lanes
    │   ├── peer-session.js                   One RTCPeerConnection (main or lane): route/RTT stats, safety code
    │   ├── transfer/
    │   │   ├── transfer-manager.js           Protocol v3: lanes, reorder, consent, flow control, SHA-256, resume
    │   │   ├── transfer-store.js             Rows + throttled immutable snapshots
    │   │   ├── frames.js                     encodeFrame / decodeFrame (12-byte slot + offset header)
│   │   ├── channel-port.js               Swappable main-channel handle for reconnects (emits drain)
    │   │   └── errors.js
    │   ├── storage/sinks.js                  Where bytes go: desktop folder → chosen folder → OPFS → memory
    │   └── crypto/sha256.js                  Streaming SHA-256 (hash-wasm, lazy-loaded)
    ├── config/runtime.js                     Signaling URL, fallback STUN
    ├── utils/                                emitter, format, id, paths (safe names, MIME allowlist), clipboard
    └── styles/global.css                     Design tokens (light/dark), components
```

## Layers and their rules

| Layer         | May use                                     | Must not                                         |
| ------------- | ------------------------------------------- | ------------------------------------------------ |
| `components/` | Props, other components, small UI hooks     | Open sockets, touch WebRTC, hold network objects |
| `hooks/`      | Services, reducer, config                   | Render markup                                    |
| `state/`      | Nothing (pure functions)                    | Have side effects                                |
| `services/`   | `utils/`, `@hopline/protocol`, browser APIs | Import React                                     |
| `utils/`      | Nothing app-specific                        | Depend on other layers                           |

These rules keep the transfer engine testable, and reusable outside React (the desktop app reuses it unchanged).

## Session lifecycle: `useHoplineSession`

Exposes `{ phase, code, error, notice, transfers, createRoom, joinRoom, sendFiles, leave }`.

- Network objects (`SignalingClient`, `PeerSession`, `TransferManager`) live in a **ref**, never in React state,
  so re-renders never recreate connections.
- State changes go through `sessionReducer`, so every transition is explicit and listed in one place.
- `disconnect()` closes connections but keeps received files. `reset()` also releases their memory.
- A dropped signaling socket rejoins in the background; it never interrupts a working data channel.
- The first server connection keeps trying for 90 s (a free-plan host can take 25–60 s to wake up) and the start
  screen says "Waking up the server…" after 3 s. If the server restarted and forgot the room (`rejoin-failed`) or the
  signaling socket is lost for good while the data channel is open, the session continues with a notice instead of
  ending; only a session that isn't connected ends.
- **Reloading the page keeps the room**: the seat (room code + rejoin token, role, "Hide my IP") is kept in
  `sessionStorage` (`utils/seat-storage.js`, this tab only). On load, if it's less than 110 s old (refreshed on
  `pagehide`; the server holds a seat for 120 s), the hook sends `rejoin` instead of showing the start screen, then
  reconnects. Leaving, ending or failing clears it.
- If the transfer engine has to stop by itself (incompatible version, protocol abuse) it emits `stopped` and the
  session ends with that reason on screen, instead of looking connected while nothing works.
- A dropped main data channel moves to `reconnecting`: transfers pause, a new connection is negotiated (up to 3 min), and transfers resume where they stopped. A dropped **lane** doesn't change the phase: its frames are resent on the other lanes.
- `ConnectionManager`'s `lane` / `lane-lost` events are wired to `transfers.addLane()` / `removeLane()`; the lane count is polled with the connection stats and shown in the badge.
- WebRTC is only set up once both devices are in the room (that's when relay credentials arrive). "Hide my IP address" refuses to connect if no relay is available.
- **Desktop app**: the hook creates the `TransferManager` with `direct: nativeBridge()` (`window.hopline.direct`, or
  `null` in a browser). `acceptOffer` then asks the main process for a real folder: **Save to a folder** opens the
  native folder dialog, **Accept** uses `Downloads/Hopline <date>`. The batch is accepted with
  `{ kind: 'native', folderId, label }`, which enables Direct mode and the `NativeSink`.

| Phase               | UI                                                                           |
| ------------------- | ---------------------------------------------------------------------------- |
| `idle` / `starting` | HomeView (buttons disabled while starting)                                   |
| `waiting`           | ShareCard: code, QR code, copy-link button                                   |
| `connecting`        | Spinner                                                                      |
| `connected`         | Safety code, Direct/Relayed badge (+ lanes), offers, Dropzone, transfer list |
| `reconnecting`      | Reconnect banner; transfers paused, resume automatically                     |
| `ended`             | Notice + transfer list (Save still works) + **Start over**                   |

## Services

### `SignalingClient`

Reconnects with backoff (0.5 s → 8 s) after a drop and reclaims its seat with `rejoin` (room code + secret token).
Messages sent meanwhile are queued (max 200) and flushed once the seat is back. A 25 s `ping` keeps proxies and
sleeping hosts from closing the connection. Emits each server message type, plus `disconnected` and `lost`.

### `ConnectionManager` and `PeerSession`

- Each connection attempt is a `PeerSession` with its own id, carried in every signal, so late messages from an
  old attempt can't confuse a new one.
- The **host** (room creator) makes offers; when the connection breaks it retries every few seconds. The **guest**
  answers and asks the host to reconnect if it notices first.
- `forceRelay` ("Hide my IP address") restricts ICE to relay candidates, on the main connection **and every lane**.
- `connectionInfo()` reports **Direct/Relayed** and round-trip time from `getStats()`.
- `safetyCode()` derives a 16-digit code from the DTLS certificate fingerprints in `getStats()`.
- `PeerSession` takes a `label` option (`hopline` for the main channel, `hopline-lane` for lanes) and a
  `certificate` option (passed as `RTCConfiguration.certificates`). `remoteFingerprint()` returns the other side's
  DTLS certificate fingerprint as actually used (from `getStats`).

#### Lanes

Once the main channel opens, the host opens up to 3 extra **lane** connections (`MAX_LANES − 1`), each a separate
`RTCPeerConnection` with one `hopline-lane` data channel and session id `<main id>.L<n>`:

- Started 400 ms apart, so their signaling doesn't burst into the server's rate limit.
- Best effort: a lane not open after 20 s is given up; a failing lane never affects the main connection.
- All lanes close with the main connection (or when a new main session replaces it).
- The guest accepts lane offers only for its current main session id (and `n` ≤ 3).
- **Authenticated**: `useHoplineSession`'s `start()` generates one ECDSA P-256 certificate per session and passes it
  to `ConnectionManager({ certificate })`, which gives it to every `PeerSession`. When a lane opens, both sides
  compare its `remoteFingerprint()` with the main connection's; a mismatch closes the lane (console warning), so
  the safety code covers the lanes too. Without a certificate, no lanes are opened.
- Events: `lane` (an open lane `RTCDataChannel`) and `lane-lost`, next to `channel`, `lost` and
  `reconnect-requested`.

Each lane has its own SCTP congestion control, which is what helps on long or lossy WAN paths where one association
is the bottleneck. On a fast local path the CPU is the limit: on a heavily loaded dev machine, loopback measured
about 10–12 MB/s with 1 lane and with 4. In a browser test over real signaling, one lane was killed at 52 MB and
the main connection dropped at 90 MB of a 150 MB file; the transfer resumed with 4 lanes and finished SHA-256
verified.

**`ConnectionBadge`** shows Direct/Relayed (of the main connection), the round-trip time and, when more than one
channel carries data, **"N lanes"** (the tooltip explains it). Not to be confused with **Direct mode**: in the
desktop app, `TransferItem` shows a **Direct link** tag while a file moves over the native TCP link, and a **Show**
button (`window.hopline.direct.showItem`) on files saved to a folder; `IncomingOffers` explains where **Accept**
saves and when the Direct link is used.

### `TransferManager` (protocol v3)

Lives for the whole session and survives reconnects (`detach()` / `attach(channel)` for the main channel).
`addLane(channel)` / `removeLane(channel)` add and remove extra channels for file frames; `laneCount` (main +
lanes, 0 while disconnected) and the `lanes` event report how many are open. Wire details:
[protocols.md](protocols.md#data-channel-file-transfer-protocol-v3).

| Concern        | How it's handled                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent        | Incoming batches stay **offered** until Accept / Save to folder / Decline; nothing is stored before                                                                                                                                                                             |
| Large files    | Reads 1 MiB blocks, sends 64 KiB frames (12-byte slot + offset header); receiver batches 1 MiB disk writes                                                                                                                                                                      |
| Lanes          | Each frame goes to the open lane with the emptiest send buffer (per-lane high water = 8 MiB / lanes, at least 2 MiB); hashing stays in file order                                                                                                                               |
| Lane loss      | Unconfirmed frames of a closed lane are re-read from the file and resent on the others, before any new data                                                                                                                                                                     |
| Reordering     | Per-file reorder buffer keyed by offset; bytes hashed and written strictly in order; duplicates and stale slots dropped; frames that beat their `start` held (bounded)                                                                                                          |
| Memory         | Local buffer high/low water (8/1 MiB, shared by the lanes) **and** a 32 MiB window of unconfirmed bytes across all files and lanes, enforced on both ends (receiver: 2× window)                                                                                                 |
| Resume         | After a reconnect both sides exchange `sync`; senders continue from the receiver's **contiguous, durably written** offset with a new slot (re-hashing the earlier part locally); an epoch counter stops stale send loops                                                        |
| Integrity      | SHA-256 on both ends while streaming; verified **before** the file is committed (`end` may arrive before the last frames; the file finishes when both are in)                                                                                                                   |
| Cancel         | Either side, any time; partial data is deleted                                                                                                                                                                                                                                  |
| Untrusted peer | ids, sizes, counts, names and frame headers validated; unsafe MIME types downgraded; a flow-control violation fails the file; floods (inbox, early frames) end the session                                                                                                      |
| UI performance | `change` at most every 100 ms; snapshots keep identity until a row changes (memoized rows)                                                                                                                                                                                      |
| Direct mode    | Desktop app only (`direct` bridge passed in): `#sendDirect` asks `direct-request` before a fresh `start`; `#onDirectRequest` listens/expects only accepted native-folder files; `#onDirectEvent` maps engine progress/results onto rows (`via: 'direct'`). Any failure → WebRTC |

### Storage sinks (`storage/sinks.js`)

| Sink            | When                                                 | Notes                                                                                                                                                   |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeSink`    | Desktop app, any accepted batch received over WebRTC | Bytes go to the main process (`openFile` / `writeFile` / `commitFile`), which writes into the chosen folder with the CLI's safe-write rules             |
| `DirectorySink` | "Save to a folder" (Chromium, HTTPS or localhost)    | Writes straight to disk via the File System Access API; recreates sub-folders; never overwrites                                                         |
| `OpfsSink`      | "Accept" on modern browsers over HTTPS/localhost     | Browser's private disk storage; **Save** afterwards. Each tab has its own folder guarded by a Web Lock; leftovers of closed tabs are cleaned at startup |
| `MemorySink`    | Fallback (e.g. plain-HTTP LAN address)               | Folds into Blobs every 64 MiB; UI warns for > 1 GB                                                                                                      |

## Configuration

`config/runtime.js` picks the signaling URL in this order:

1. `window.hopline.signalingUrl` (desktop app)
2. `VITE_SIGNALING_URL` (build time)
3. Same origin as the page: `ws(s)://<host>/ws`, which works with the Vite proxy, `npm start` and nginx

ICE servers come from the signaling server (STUN, plus short-lived TURN credentials once paired). `VITE_STUN_URLS` is only a fallback.

## Styling

- One stylesheet with CSS custom properties. Dark mode via `prefers-color-scheme`.
- Responsive down to phone width; respects `prefers-reduced-motion`.
- Progress bars animate with `transform: scaleX()` (GPU-friendly, no layout work).

## Accessibility

Real `<button>`/`<form>` elements, a keyboard-operable drop zone (Enter/Space), `role="progressbar"` with values,
`role="status"`/`role="alert"` for live messages, visible focus rings, and labelled inputs.

## Known limits

- In-browser storage needs HTTPS (or localhost). On a plain-HTTP LAN address, received files fall back to memory.
- Resuming works within a session (both tabs stay open). Closing a tab ends that side's transfers.
