# Security

This page describes what Hopline protects, how, and what it doesn't (yet). The full penetration-test results are in
[security/vapt-report.md](security/vapt-report.md).

## What is encrypted

| Path                              | Protection                                                                                               | Who can read file contents                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Browser/desktop ↔ browser/desktop | WebRTC DTLS (mandatory in every browser) + SHA-256 verification of every file                            | Only the two devices                                            |
| Through the TURN relay            | Still DTLS end to end                                                                                    | Only the two devices; the relay sees ciphertext                 |
| Desktop ↔ desktop (Direct mode)   | One-time 256-bit key sent over the authenticated data channel → AES-256-GCM per frame + SHA-256 per file | Only the two devices                                            |
| CLI ↔ CLI                         | **CPace PAKE** (ristretto255) → HKDF session key → AES-256-GCM per frame                                 | Only the two computers                                          |
| Browser ↔ signaling server        | WSS when served over HTTPS (Render/your proxy)                                                           | The server sees room codes and connection metadata, never files |

## Web and desktop

**Connecting**

- Room codes: 6 characters from 32 symbols (~1.07 billion). Each client gets **10 wrong codes per minute**
  (IPv6 counted per /64); after that the server doesn't even look codes up. A room takes exactly one guest and
  expires after 30 minutes unjoined.
- **Same-origin by default**: other websites can't open signaling connections through visitors' browsers.
- **Safety code**: a 16-digit code derived from both devices' DTLS certificate fingerprints, read from the
  browser's own connection stats (not the SDP text). If both people read the same code, nobody, not even the
  signaling server, is in the middle. 16 digits make grinding a matching fake certificate within the connection
  timeout infeasible.
- **Hide my IP address** forces the relay, so the other person never learns your IP. It **fails closed**: if the
  server has no relay, nothing connects. It applies to **every** connection, including the extra lane connections.
- **Lanes are authenticated.** Each session generates one ECDSA P-256 DTLS certificate
  (`RTCPeerConnection.generateCertificate`) and uses it for the main connection and every lane. When a lane opens,
  each side compares the lane's remote certificate fingerprint (from `getStats`, not the SDP) with the main
  connection's; a lane that doesn't match is closed with a console warning and never carries data. So a malicious
  signaling server that answers a lane offer itself gets nothing, and the **safety code** (computed from the main
  connection's certificates) covers the lanes too. If no certificate can be generated, no lanes are opened.
  Verified in a browser: honest peers open 4 lanes; with impostor certificates all 6 lane connections were rejected.
- Lanes also belong to one main connection: the guest accepts a lane offer only when its session id is
  `<current main id>.L1`–`.L3`, and all lanes close with the main connection.

**Receiving**

- **Consent**: an incoming batch shows names and sizes; nothing is written until the user accepts.
- All peer input is validated: ids, sizes (≤ 1 TiB), counts (≤ 10,000 files per offer, 20 pending offers), file names
  (traversal removed, invalid/control/invisible/bidi characters stripped, Windows reserved names neutralised).
- **Flow control** on both sides: the receiver holds at most 2 × the 32 MiB window per file (reorder buffer plus
  unwritten bytes, and no frame more than 2 × window ahead), else that file fails. Across all files together
  (reorder buffers, early frames and unwritten bytes) the bound is also 2 × window, else the session stops. Each
  held frame is charged 1 KiB of bookkeeping, so millions of tiny frames hit the bound too. A peer that floods messages
  (more than 4 × window or 100,000 messages queued) gets disconnected instead of exhausting memory.
- The room seat token is kept in `sessionStorage` so a reload can rejoin. It's per tab and per origin, gone
  when the tab closes, only useful while the server still holds the seat (2 min after a disconnect), and the CSP
  blocks injected scripts that could read it.
- **File frames** (protocol v3) are untrusted too:
  - the 12-byte header is validated: frames with no payload or an offset beyond a safe integer are dropped, and
    a frame reaching past the file's declared size fails the file;
  - **slots only grow**: a `start` with a slot not above the highest seen is ignored, and frames for older slots
    are dropped, so replayed or stale data can't re-open or corrupt a file; duplicates are discarded;
  - frames that arrive before their `start` are held only within bounds (4,096 slots, 2 × window bytes), beyond
    that the session stops;
  - messages still queued from a dropped connection are discarded after the resync (SYNC recovers what they
    carried), and a lane that one side refuses or drops is closed so the other side resends;
  - lane channels accept **binary frames only**; control messages count only on the main channel, so a lane
    can't reorder or inject them;
  - bytes are hashed and written strictly in file order whatever lane they came on, so reordering can't change
    what is verified.
- **Integrity**: SHA-256 of every file is computed on both ends while streaming and compared **before** the file is
  committed. A mismatch discards the data; it never appears in the user's folder.
- **No HTML execution**: received files keep their type only for a few image formats; everything else is
  `application/octet-stream`. A strict Content-Security-Policy also applies to any blob document.

## Desktop: Direct mode

Two desktop apps on the same network move file bytes over a TCP link between their main processes (see
[desktop.md](desktop.md#direct-mode) and [protocols.md](protocols.md#direct-mode-desktop--desktop-over-tcp)). The
threat model adds two attackers: **anyone on the LAN** (can connect to the listener, observe and inject traffic)
and a **hostile peer** (the other app, or a page pretending to be it, controls every `direct-*` message and every
TCP frame it sends). The renderer of our own app is also treated as untrusted by the main process.

| Threat                                                                 | Mitigation                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAN eavesdropper reads or alters files                                 | Every frame is AES-256-GCM with counter nonces under a fresh random 256-bit key per listener. The key only travels over the DTLS data channel, which the safety code authenticates; never via the server                                                                      |
| LAN attacker connects to the listener                                  | The first frame must decrypt under the key, or the socket is closed. The listener accepts **exactly one** authenticated connection, then stops listening (so a key never protects two streams: no nonce reuse)                                                                |
| Slow-drip or junk connections block the real sender                    | Unauthenticated sockets get a **hard** 10 s deadline (trickling bytes doesn't extend it), at most 8 pending (the oldest is evicted, not the newcomer), at most 2 per remote address; IPv4-only listener                                                                       |
| Hostile peer makes our app dial chosen hosts/ports (SSRF-style)        | The sender dials only private/CGNAT IPv4 addresses that are on **one of its own subnets** or a `100.64/10` overlay; never link-local (cloud metadata) or public; loopback **only** when the receiver advertises one of our own addresses (same machine); at most 16 addresses |
| Hostile sender writes files the user didn't accept, or more bytes      | The receiver expects only files from a batch its user accepted, by id and **exact size**; anything else, a second concurrent file or extra bytes closes the link                                                                                                              |
| Hostile sender writes outside the folder, overwrites, follows symlinks | Paths are sanitised (`toSafePathSegments`), written with the CLI's `SafeFileWriter`: exclusive temp file, symlinked folders refused, commit never overwrites                                                                                                                  |
| Corrupted or tampered data is saved                                    | SHA-256 of the whole file compared with `timingSafeEqual` **before** commit; a mismatch deletes the temp file                                                                                                                                                                 |
| Firewall or network throttles/drops the link                           | Stall watchdog: no receiver progress for 20 s closes the link; the file is resent over WebRTC                                                                                                                                                                                 |
| Link drops after the receiver saved the file                           | The fallback `start` gets the saved result repeated (`progress` + `ack`), so the sender never hangs and no second copy is written                                                                                                                                             |
| Receiver disk error is mistaken for a lost link                        | Reported as that file's failure (`SKIP` with the error); the link keeps working                                                                                                                                                                                               |
| Compromised renderer reads or writes arbitrary files                   | The page never passes paths: files to send are **tokens** made in the preload from real `File`s (`webUtils.getPathForFile`); writes go only to folders the user picked, **by folder id**                                                                                      |
| Another page or frame calls the Direct IPC                             | Every handler checks the sender is this window's `webContents` **and** the exact app URL                                                                                                                                                                                      |
| State outlives the page (reload, navigation, crash)                    | Main resets Direct state: links and listeners closed, partial files deleted, tokens and folder ids forgotten; work started before the reset detects it and cleans up                                                                                                          |
| Resource exhaustion through native writes                              | At most 64 open native files (the slot is reserved before any await); JSON bodies ≤ 4 KiB; frames ≤ 1 MiB                                                                                                                                                                     |

**Firewall.** The Windows installer adds one inbound allow rule for `Hopline.exe`, TCP, **Private networks
only**. On a network marked Public, Windows keeps blocking or throttling inbound connections and the file falls back
to WebRTC; nothing is opened on public Wi-Fi.

## CLI

| Attacker                                                                                | Outcome                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passive eavesdropper                                                                    | Sees nonces and public key shares only. Learns nothing about the code or the files.                                                                                                                                                                              |
| Active attacker who doesn't know the code (including a fake sender/receiver on the LAN) | Gets **one online guess per connection** (CPace). A recorded handshake can't be brute-forced offline. The sender stops after **5 wrong codes**; junk connections don't count.                                                                                    |
| Malicious sender with the right code                                                    | Can only write inside a **new folder** per transfer (default `Hopline <date>`), never outside it: traversal is rejected, files are created exclusively and never overwrite, and symlinked folders are refused. The prompt warns about programs and hidden files. |

Other protections: codes expire after 30 minutes unused; at most 4 handshakes in progress at once; frames over 1 MiB are
rejected before allocation; counter nonces detect tampering, replay, reordering and truncation; names printed to the
terminal are stripped of escape sequences.

## Server, relay and containers

- **Signaling**: 64 KiB message cap; 20 msg/s per connection (bursts of 120, sized for the main + 3 lane
  negotiations); 20 connections per client and 5,000 total; idle
  sockets closed after 2 minutes; heartbeat drops dead connections; prototype-key message types rejected.
- **Client IPs**: `X-Forwarded-For` is only trusted for a configured number of proxy hops, read from the **right**;
  nginx overwrites it. Spoofing it doesn't bypass limits.
- **HTTP**: CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, HSTS
  over HTTPS; only GET/HEAD; header and request timeouts; `/health` shows no usage numbers by default.
- **TURN relay**: credentials only for paired devices, short-lived HMAC credentials, refuses to start without a
  strong secret, no TCP relay, and **no relaying into private/loopback/link-local/metadata addresses** (SSRF).
- **Containers**: non-root users, read-only filesystems, `no-new-privileges`, app files owned by root, Alpine
  packages patched at build time, npm/yarn removed from runtime images. The signaling port is published on
  localhost only; the public entry point is nginx.
- **Desktop**: `contextIsolation`, `sandbox`, no Node in the page, a preload that exposes two read-only values and a
  narrow Direct-mode API (tokens and folder ids, never paths), navigation pinned to the exact app URL, all permission
  requests denied, no `<webview>`. See [Desktop: Direct mode](#desktop-direct-mode).

## Known limitations (accepted risks)

| Risk                                                                                                                                | Why it's accepted / mitigation                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A malicious **signaling server** could attempt a man-in-the-middle on web transfers                                                 | Compare the safety code. Run your own server (Docker/Render).                                                                         |
| Room codes are short (6 characters)                                                                                                 | Rate limiting makes guessing impractical. A room accepts one guest only, and the safety code exposes an impostor.                     |
| A LAN attacker can make 5 wrong CLI guesses to stop a transfer                                                                      | Stopping is the safe outcome; the user simply starts again.                                                                           |
| Received files in the browser are held on disk (OPFS) or, on older browsers over plain HTTP, in memory                              | Use HTTPS (OPFS) or "Save to a folder"; the UI warns before memory is used for big files.                                             |
| Fixed TURN credentials from a managed provider don't expire                                                                         | Prefer `TURN_SECRET` (shared-secret scheme).                                                                                          |
| Direct mode's `HELLO` isn't bound to the TCP connection: an on-path LAN attacker could replay it to take the listener's single slot | The attacker learns nothing (it can't decrypt or forge later frames); the real sender can't connect and the file falls back to WebRTC |
| A cancel during the final commit of a Direct file may still save it                                                                 | The file is complete and verified; the user can delete it                                                                             |
| Desktop installers are unsigned (SmartScreen / Gatekeeper warnings)                                                                 | Download only from the project's GitHub Releases page; signing needs paid certificates                                                |

## Reporting a problem

Report issues privately to the project maintainer rather than in a public tracker until a fix is available.
