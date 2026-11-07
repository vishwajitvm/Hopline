# Speed challenge: 10 GB in 2 minutes, nothing lost

The goal: move **10 GB in under 2 minutes**, with every byte verified. This page records the math, what we
measured, what already works, and the plan for the rest. Re-run the numbers with `npm run bench:cli -- 10`
(native path) and the browser snippets at the end.

**Status:** done in software. The **desktop app** moves 10 GiB in **85.3 s (120 MiB/s)** between two instances over
its Direct mode, SHA-256 verified, and the CLI does it in 56.8 s. Between two computers the link then decides:
wired gigabit Ethernet makes it in about 90–95 s. Browsers stay capped by WebRTC (about 13 MB/s here).

## The math

| Target                        | Value                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| 10 GiB                        | 10,737 MB                                                     |
| ÷ 120 s                       | **89.5 MB/s of file data, sustained**                         |
| On the wire (+3–5 % overhead) | **~750 Mbit/s**, in both directions of the path               |
| Every stage must keep up      | disk read → encrypt → network → decrypt → verify → disk write |

The slowest stage sets the speed, so we measured each one separately.

## Measurements (2026-11-07)

This PC: Windows 11, 16 threads, Chrome 152. It was heavily loaded by other projects' containers, so a clean
machine will do better, but the _ratios_ hold.

### Browser path (WebRTC)

| Stage                                                  | Measured                        | 10 GiB would take   |
| ------------------------------------------------------ | ------------------------------- | ------------------- |
| Raw WebRTC data channel, 1 connection, 64 KiB messages | 12.9 MB/s                       | ~14 min             |
| … 256 KiB messages                                     | 12.5 MB/s                       | no gain             |
| … unordered delivery                                   | 13.2 MB/s                       | no gain on loopback |
| … 4 connections                                        | 11.4 MB/s                       | slower              |
| … 8 connections                                        | 9.2 MB/s                        | slower still        |
| Hopline engine, 4 lanes, through real signaling        | 8–12 MB/s                       | 15–22 min           |
| SHA-256 in WebAssembly (current integrity check)       | 107 MB/s                        | caps at ~100 s      |
| SHA-256 with WebCrypto, 4 MiB blocks                   | 480 MB/s (505 MB/s in parallel) | not a limit         |
| Reading the file, 1 MiB blocks → 8 MiB blocks          | 248 → 636 MB/s                  | not a limit         |
| Building frames (header + copy)                        | 794 MB/s                        | not a limit         |

**The browser's ceiling is the WebRTC data channel itself.** Chrome runs data channels as SCTP over DTLS over
UDP, in ~1,200-byte packets handled by one network thread. No setting we control moved it past ~13 MB/s on this
PC. Extra connections only add work for that thread, so they help on long, lossy internet routes, where one
connection's congestion control is the limit, but not on a fast local link. Browsers can't open raw TCP sockets.
WebTransport (QUIC) needs an HTTP/3 server in the middle, so every byte would cross a server, which defeats
peer-to-peer.

### Native path (Hopline CLI: TCP + CPace + AES-256-GCM)

| Test (loopback on this PC, real disk reads and writes) | Result                          |
| ------------------------------------------------------ | ------------------------------- |
| 1 GiB                                                  | 7.2 s (142 MiB/s)               |
| 2 GB                                                   | 13.1 s (~156 MB/s)              |
| **10 GiB**                                             | **56.8 s (180 MiB/s)**          |
| SHA-256 of source vs received, 10 GiB                  | identical (`296a3e99…a12132e7`) |

**The native path already beats the target by 2× in software.** That leaves the network as the only limit.

### Desktop app, Direct mode (TCP + AES-256-GCM, from the app)

| Test (this PC, same machine, real disk reads and writes) | Result                        |
| -------------------------------------------------------- | ----------------------------- |
| Two packaged `Hopline.exe` instances, 2 GiB              | 17.5 s (**117 MiB/s**)        |
| Desktop app from source (two profiles), **10 GiB**       | **85.3 s (120 MiB/s)**        |
| SHA-256 of source vs received, 10 GiB                    | identical (`faf3e250…91de14`) |
| Engine alone, Node ↔ Node                                | 119 MiB/s                     |
| Engine alone, Electron ↔ Electron                        | 122–128 MiB/s                 |
| First attempt, before the firewall/loopback fix          | ~15–17 MiB/s                  |

The Direct engine measured below the CLI's 180 MiB/s loopback run on this (heavily loaded) PC, but it is still
well over the 89.5 MB/s target, and on a gigabit LAN the network is the slower stage anyway.

## The network decides

Typical real-world throughput (not measured here; your hardware varies):

| Link between the two devices                      | Typical file throughput             | 10 GiB       | Meets 2 min?                                |
| ------------------------------------------------- | ----------------------------------- | ------------ | ------------------------------------------- |
| 10 GbE / 2.5 GbE                                  | 1,100 / 280 MB/s                    | disk-bound   | ✅                                          |
| **Gigabit Ethernet (both wired)**                 | 110–118 MB/s                        | **~90–95 s** | ✅                                          |
| Wi-Fi 6/6E, 5–6 GHz, 160 MHz, close to the router | 60–120 MB/s                         | 90–180 s     | borderline                                  |
| Wi-Fi 5 (802.11ac)                                | 30–60 MB/s                          | 3–6 min      | ❌                                          |
| A phone on Wi-Fi                                  | 20–60 MB/s                          | 3–9 min      | ❌                                          |
| Internet (needs ≥ 750 Mbit/s up _and_ down)       | most home uplinks are 50–300 Mbit/s | 5–30 min     | ❌ unless both have symmetric gigabit fiber |

So **10 GB in 2 minutes means: native app on both ends (desktop app or CLI) + a wired gigabit LAN (or better).**
No software can
beat the link; anything claiming 10 GB/2 min over Wi-Fi to a phone is compressing (only works on compressible
data) or not verifying.

## How to do it today

On two computers on the same wired network (SSDs on both ends):

**With the desktop app** (easiest):

1. Install Hopline on both computers ([desktop.md](desktop.md#installing)). On Windows, mark the network as
   **Private** (see [the firewall finding](#the-firewall-finding)).
2. Create a room on one, join with the code on the other, compare the safety code.
3. Drop the files on one side and click **Accept** on the other. The rows show **Direct link**; files land in
   `Downloads/Hopline <date>`.

If the computers can't reach each other over TCP (different networks, a firewall), the app silently uses WebRTC
instead: slower, but the transfer still completes.

**With the CLI:**

```bash
# computer A
npm run cli -- send ./big-folder
# computer B (use the code A prints; add --host <A's ip:port> if discovery is blocked)
npm run cli -- receive 42-amber-river-falcon
```

Nothing is lost: every 256 KiB chunk is sealed with AES-256-GCM under a counter nonce, so a missing, reordered,
duplicated or altered chunk fails authentication and the transfer stops instead of writing bad data. Files are
written to temp files and committed only when complete. The 10 GiB run above was checked byte for byte.

## What changed this round (browser path)

- **Parallel lanes** (up to 4 connections) with reordering, retransmission and SHA-256 before commit: helps on
  long or lossy routes (see [protocols.md](protocols.md)).
- **Unordered lanes**: lane channels are reliable but unordered, so one lost packet never stalls later frames
  (frames carry their offset and the receiver reorders them).
- **4 MiB disk reads** (measured 2.5× faster than 1 MiB).
- **Reliability**: reloading a page rejoins the same room; a reloaded receiver gets the files offered again; a
  reloaded sender's half-sent files fail with a clear reason; engine stops are shown instead of looking
  connected. See [troubleshooting.md](troubleshooting.md).

## Plan for the rest

### Phase 1: browser headroom (protocol v4)

- Replace the WebAssembly SHA-256 (107 MB/s, on the main thread) with **WebCrypto SHA-256 over fixed 4 MiB
  blocks**, then a final SHA-256 over the block digests (measured 4.5× faster, and off the main thread). It's still SHA-256 end to end, and resume re-hashes only
  the blocks it needs.
- Move hashing and writing into a **Worker** using OPFS `createSyncAccessHandle` (synchronous, much faster than
  async writable streams), so the page thread only routes frames.
- Expected: removes every non-WebRTC limit; the browser then runs at whatever the data channel allows on that
  machine.

### Phase 2: the 2-minute path inside the app ("Direct" mode, desktop app): DONE

Built as planned (details: [desktop.md](desktop.md#direct-mode), [protocols.md](protocols.md#direct-mode-desktop--desktop-over-tcp)):

1. Both peers connect as before (WebRTC). The data channel is end-to-end encrypted and authenticated, and the
   safety code verifies it.
2. If both are the desktop app (`direct: true` in `sync`), the sender asks `direct-request`; the receiver's main
   process opens a TCP listener and answers `direct-ready` with `{ port, addresses, key }` (a fresh 256-bit key)
   over that authenticated channel. The key never touches the signaling server.
3. The sender's main process connects (own-subnet addresses, or loopback on the same machine) and streams files
   straight from disk (`webUtils.getPathForFile`) in 512 KiB AES-256-GCM frames (the CLI's `FrameCipher`). The
   receiver's main process writes straight to disk with the CLI's safe-write rules (dated folder, exclusive temp
   files, no overwrite) and verifies SHA-256 before committing.
4. If TCP can't connect (3 s), the link drops, or no progress arrives for 20 s, the file falls back to WebRTC
   automatically.

Measured: **10 GiB in 85.3 s (120 MiB/s)** from the app, 117 MiB/s between two packaged builds (table above).

#### The firewall finding

The first measurements ran at only **15–17 MiB/s**, far below the engine's own speed. The cause wasn't the code:
the two instances on one PC connected through the PC's **LAN address**, and Windows Firewall throttles (or blocks)
inbound traffic to an app without a rule on networks marked **Public**. Two fixes:

- **Same machine → loopback.** If the receiver advertises one of the sender's own addresses, the sender dials
  `127.0.0.1` only. Loopback isn't filtered, and the speed jumped to 117–120 MiB/s.
- **Between computers → a firewall rule.** The Windows installer adds an inbound TCP allow rule for `Hopline.exe`
  on **Private** networks only, so users mark their home network Private. A stall watchdog (no progress for 20 s)
  makes a throttled link fall back to WebRTC instead of crawling.

A second bug surfaced during the same tests: a dev server serving a stale copy of `packages/protocol` left the new
message constants `undefined`, so a message without a type matched them and two peers answered each other in a
loop. The engine now drops any message whose type isn't a known string (`KNOWN_TYPES`). Restart the dev server
after changing `packages/protocol`.

### Phase 3: fast over the internet

- Several parallel TCP streams (or QUIC) per transfer to fill long fat pipes.
- UPnP / NAT-PMP port mapping so one side can accept a direct connection from the internet.
- Relays (TURN) can't make anything faster: they add a hop and their own bandwidth limit.

### Not worth it

- **Compression**: big files (video, photos, archives, installers) are already compressed. It only helps text,
  logs and raw disk images, and costs CPU on everything else.
- **More WebRTC connections or bigger messages**: measured slower or no gain (table above).

## Reproducing the browser numbers

Open the dev server (`npm run dev`, http://localhost:5290), then in the browser console:

```js
// WebCrypto vs WebAssembly SHA-256
const { createSha256 } = await import('/src/services/crypto/sha256.js');
const buf = new Uint8Array(64 << 20);
let t = performance.now();
const h = await createSha256();
for (let i = 0; i < 4; i++) h.update(buf);
h.digest();
console.log('wasm MB/s', 256 / ((performance.now() - t) / 1000));
t = performance.now();
for (let i = 0; i < 64; i++) await crypto.subtle.digest('SHA-256', buf.subarray(0, 4 << 20));
console.log('webcrypto MB/s', 256 / ((performance.now() - t) / 1000));
```

The data-channel numbers come from two local `RTCPeerConnection`s sending 120 MiB with backpressure:

```js
async function dataChannelMBps({ msg = 65536, ordered = true, mb = 120 } = {}) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const ch = a.createDataChannel('bench', { ordered });
  const rx = new Promise((r) => (b.ondatachannel = (e) => r(e.channel)));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const peer = await rx;
  if (ch.readyState !== 'open') await new Promise((r) => ch.addEventListener('open', r, { once: true }));
  const total = mb << 20;
  let got = 0;
  const done = new Promise(
    (r) => (peer.onmessage = (e) => (got += e.data.size ?? e.data.byteLength) >= total && r()),
  );
  const payload = new Uint8Array(msg);
  const t = performance.now();
  let sent = 0;
  ch.bufferedAmountLowThreshold = 1 << 20;
  const pump = () => {
    while (sent < total && ch.bufferedAmount < 4 << 20) (ch.send(payload), (sent += msg));
  };
  ch.onbufferedamountlow = pump;
  pump();
  await done;
  a.close();
  b.close();
  return mb / ((performance.now() - t) / 1000);
}
console.log(await dataChannelMBps());
```
