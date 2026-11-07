# Hopline: project memory

Peer-to-peer file transfer. Files go device to device; the server only introduces devices. Web app (React/Vite,
WebRTC), desktop app (Electron shell around the web build + **Direct mode**: desktop ↔ desktop over native TCP),
CLI (LAN, CPace PAKE), signaling server (Node + `ws`),
optional TURN relay (coturn). Full docs in `docs/`, diagrams in `diagrams/` (Mermaid `.mmd`).

## Layout

| Path                               | What                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`                | **Single source of truth** for signaling/data-channel message types, limits, room codes. Server and web import it                        |
| `apps/server`                      | Signaling: `app.js` (HTTP + security headers), `signaling/` (service, rooms, peers, ICE creds), `lib/` (logger, token bucket, client IP) |
| `apps/web`                         | `components/` (UI only) → `hooks/` (lifecycle) → `services/` (network, transfer engine, storage, crypto). No network code in components  |
| `apps/cli`                         | `commands/` (send/receive), `core/` (CPace crypto, framing, handshake, discovery), `utils/`                                              |
| `apps/desktop`                     | Electron `main.cjs` / `preload.cjs` / `config.cjs`; `scripts/ensure-electron.cjs` downloads the binary lazily                            |
| `apps/desktop/src/direct`          | Direct mode engine (`wire`, `receiver`, `sender`, `service`), reuses CLI crypto/framing/safe-write; IPC in `direct-ipc.cjs`              |
| `apps/desktop/build`               | electron-builder resources: `icon.png`, `installer.nsh` (Windows firewall rule); config: `build` in its `package.json`                   |
| `infra/turn`                       | Hardened coturn image + `entrypoint.sh`                                                                                                  |
| `security/vapt/run.mjs`            | Active security test suite (36 checks) against a running deployment                                                                      |
| `scripts/tunnel.mjs`               | `npm run tunnel`: Cloudflare quick tunnel → public HTTPS URL                                                                             |
| `.claude/skills`, `.claude/agents` | Project skills and subagents (see below)                                                                                                 |

## Commands

```bash
npm install
npm run dev            # server :8787 + Vite :5290 (fixed port; 5173/5180 are taken by other projects' containers)
npm run check          # lint + format check + tests + build: run before every commit
npm test               # 90 tests (server, protocol, transfer engine, Direct mode, CLI)
npm run build          # web → apps/web/dist
npm start              # single process: UI + signaling on :8787
npm run desktop        # build + Electron
npm run pack -w @hopline/desktop   # unpacked desktop build in apps/desktop/release (npm run build first)
npm run dist -w @hopline/desktop   # installers for this OS (releases: tag v* → GitHub Actions, docs/releases.md)
npm run cli -- send <paths>   /   npm run cli -- receive <code>
docker compose up --build -d                 # nginx :8080 + server (127.0.0.1:8787)
docker compose --profile turn up --build -d  # + TURN relay (needs TURN_SECRET + TURN_EXTERNAL_IP)
npm run tunnel                               # public https://…trycloudflare.com URL
npm run vapt                                 # active security tests (stack must be running)
npm run bench:cli -- 10                      # native 10 GiB loopback benchmark + SHA-256 check
```

One `.env` at the repo root configures everything (server, Vite, desktop, Compose). `.env` is git-ignored and
contains a real `TURN_SECRET`; `.env.example` is the documented template. Shell/host env vars win over `.env`.

## Conventions

- ES modules; `.cjs` only for Electron. Prettier (single quotes, 110 cols), ESLint flat config. Comments explain _why_.
- Enums are `Object.freeze`d objects; private state uses `#fields`; network objects live in refs, never React state.
- Every message from a peer/client is untrusted: validate ids/sizes/counts, sanitise names (`utils/paths.js`,
  CLI `utils/files.js`), look up handlers with `Object.hasOwn`.
- New protocol messages: add to `packages/protocol` first, then server handler / client, tests, `docs/protocols.md`
  and the matching diagram (see the `hopline-protocol-change` skill).
- When behaviour changes, update `docs/` and `diagrams/` in the same change.

## Security invariants (don't regress, see `docs/security/vapt-report.md`)

- CLI handshake is **CPace** (`@noble/curves`, ristretto255). Never go back to a KDF-only scheme. Only real
  wrong-code attempts count toward the 5-strike limit.
- CLI receiver writes into a **new dated folder** by default, exclusive temp files, no overwrite, no symlinks.
- Server: same-origin WebSockets by default; `X-Forwarded-For` read from the **right** with `TRUST_PROXY` hops;
  10 wrong codes/min per client (IPv6 /64); TURN credentials **only after pairing**; `/health` minimal.
- nginx must pass `Host $http_host` (with port) or the origin check refuses every browser. Security headers are
  set only at server level (location-level `add_header` drops them).
- Web: SHA-256 verified **before** committing a file; MIME allowlist (images only); CSP everywhere; "Hide my IP"
  fails closed (on lanes too); receiver enforces the flow-control window (2× window per file and across all files).
- Web data protocol v3 = main channel + up to 3 "lane" RTCPeerConnections for file frames. Frames carry slot + offset; the receiver reorders, hashes/writes strictly in order, drops
  stale slots/duplicates, bounds early frames; lanes accept binary only. A lane is used only if its remote DTLS
  fingerprint equals the main connection's (one session certificate), so the safety code covers lanes.
- coturn: shared-secret auth, `--no-tcp-relay`, `--user-quota=32` (up to 4 peer connections per device), denied
  private/loopback/metadata ranges. Current coturn rejects `--no-dtls`; don't re-add it.
- Direct mode: fresh 256-bit key per listener, sent only over the data channel; the listener accepts **exactly one**
  authenticated connection (no nonce reuse); unauthenticated sockets get a hard 10 s deadline, max 8 pending, 2 per
  address. The sender dials only own-subnet / `100.64/10` addresses, loopback only for the same machine. SHA-256
  before commit, CLI safe-write rules. **Main treats the renderer as untrusted**: file tokens and folder ids, never
  paths; IPC checks sender + exact app URL; reset on reload/crash. Any failure falls back to WebRTC. The installer's
  Windows firewall rule is inbound TCP, `Hopline.exe` only, **private networks only**.

## Performance facts (see `docs/speed-challenge.md`)

- Browser ceiling is Chrome's WebRTC data channel (~13 MB/s on this loaded PC, any config; more PCs are slower on
  loopback). WASM SHA-256 is 107 MB/s vs WebCrypto 480 MB/s. CLI does 10 GiB in 57 s (180 MiB/s) on loopback.
- 10 GB in 2 min needs native transport + wired gigabit. Desktop Direct mode does it: 10 GiB in 85.3 s (120 MiB/s)
  between two app instances, 117 MiB/s between packaged builds (engine alone 119–128 MiB/s).

## Gotchas learned the hard way

- **npm blocks install scripts** here, so Electron's binary isn't downloaded on install. `ensure-electron.cjs` handles it.
- **Never run `docker container prune`, `docker system prune` or broad `rm`/kill patterns.** This machine runs other
  projects' containers (FLO, LMS) that use a lot of CPU; only touch `hopline-*` containers by name. Their load makes
  builds/tests slow and can make Docker lose access to Docker Hub (TLS timeouts): retry later rather than restart Docker.
- The Write tool may turn `\uXXXX` escapes into literal characters. For invisible/bidi characters, build regexes
  from numeric code points (see `DECEPTIVE_RANGES` in `utils/paths.js`).
- PowerShell 5 `Get-Content`/`Set-Content` mangles UTF-8 and adds a BOM. Use Node or the Edit tool for text files.
- Editing source files while the Vite dev server runs hot-reloads open tabs and wipes in-progress sessions. Don't
  edit mid-test.
- Mermaid sequence diagrams: a `;` in a note or message ends the statement. Use commas.
- Timing-sensitive tests must tolerate a heavily loaded machine (generous grace periods, `waitFor` instead of sleeps).
- **Windows Firewall throttles/blocks inbound traffic to `electron.exe`/`Hopline.exe` on Public networks** (Direct
  mode crawled at ~15 MiB/s via the LAN address). Test two instances on one machine via loopback (the sender does
  this automatically when the receiver lists one of its own addresses), with `HOPLINE_PROFILE_DIR` +
  `HOPLINE_DOWNLOADS_DIR` per instance.
- A long-running Vite dev server can serve a **stale copy of `packages/protocol`**: restart it after protocol changes
  (a stale module once left new message constants `undefined` and caused a ping-pong flood).
- The packaged `Hopline.exe` detaches from the console: a background launch "exits" immediately but keeps running.
- Prettier and ESLint must ignore `apps/desktop/release` (electron-builder output).

## Skills and agents

- `.claude/skills/`: `hopline-dev`, `hopline-check`, `hopline-docker`, `hopline-tunnel`, `hopline-vapt`,
  `hopline-protocol-change`, `hopline-docs-diagrams`, `hopline-deploy`
- `.claude/agents/`: `security-reviewer` (adversarial review), `docs-keeper` (keeps docs/diagrams in sync),
  `test-engineer` (writes and fixes tests)
