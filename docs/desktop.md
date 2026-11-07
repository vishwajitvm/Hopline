# Desktop app

> Code: `apps/desktop` · Diagrams: [12-desktop-app.mmd](../diagrams/12-desktop-app.mmd),
> [16-direct-mode-sequence.mmd](../diagrams/16-direct-mode-sequence.mmd)

The desktop app is the web app in an Electron window. It reuses the frontend build unchanged, so every feature and
fix lands in both at once. On top of that it adds two things a browser can't do:

- **Direct mode**: between two Hopline desktop apps on the same network, files go over a native TCP link at full
  disk and network speed (about 120 MiB/s measured on gigabit-class hardware) instead of WebRTC (about 13 MB/s).
- **Real folders**: received files are written straight into a folder on disk (by default
  `Downloads/Hopline <date>`), whoever sends them, with the same safe-write rules as the CLI.

## Installing

Download the installer for your system from the
[GitHub Releases page](https://github.com/vishwajitvm/Hopline/releases):

| System                        | File                                                         | Notes                                                                                |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Windows 10/11 (x64)           | `Hopline-Windows-x64-Setup.exe` (NSIS installer)             | Choose the install folder; adds a desktop shortcut and the Direct mode firewall rule |
| macOS (Intel / Apple silicon) | `Hopline-macOS-x64.dmg` / `Hopline-macOS-arm64.dmg`          | Drag Hopline to Applications                                                         |
| Linux (x64)                   | `Hopline-Linux-x86_64.AppImage` or `Hopline-Linux-amd64.deb` | `chmod +x` the AppImage, or `sudo apt install ./Hopline-Linux-amd64.deb`             |

The installers are **not code-signed** (signing certificates cost money), so the system warns on first launch:

- **Windows SmartScreen** ("Windows protected your PC"): click **More info → Run anyway**.
- **macOS Gatekeeper** ("can't be opened because it is from an unidentified developer"): right-click the app →
  **Open**, then **Open** again. If macOS says the app is damaged, run `xattr -cr /Applications/Hopline.app`.

Downloaded apps (1.0.2 and later) connect to the public server **wss://hopline.onrender.com/ws**, baked in at build
time from the repository variable `HOPLINE_SIGNALING_URL` (see [Signaling server](#signaling-server)). 1.0.1 builds
have no bundled server; give them one with `settings.json`.

## Running from source

```bash
npm run desktop        # build the web app, then launch
npm run desktop:dev    # with `npm run dev` running in another terminal: live reload from http://localhost:5290
```

The first launch downloads the Electron binary (`scripts/ensure-electron.cjs`, run automatically as `prestart` /
`predev`). This keeps `npm install` light for people who only use the web app or CLI, and it repairs installs
where npm skipped Electron's own download step.

## Direct mode

### When it's used

Direct mode is automatic. A file goes over a Direct link when **all** of these hold:

1. Both sides run the **desktop app** (each announces `direct: true` in the data channel's `sync`).
2. The receiver accepted into a real folder: **Accept** (`Downloads/Hopline <date>`) or **Save to a folder**
   (native folder dialog). Both do in the desktop app.
3. The file was picked from disk (it has a real path) and starts from the beginning (a resumed WebRTC file
   continues over WebRTC).
4. The sender can reach the receiver over TCP: same LAN subnet, a `100.64.0.0/10` overlay such as Tailscale, or
   the same machine.

Otherwise the file goes over WebRTC exactly as in the browser. While a file moves over a Direct link its
row shows a **Direct link** tag. Received files (either way) get a **Show** button that opens them in the system
file manager.

### How it works

1. The two apps pair over WebRTC as usual. The data channel is end-to-end encrypted and authenticated, and the
   safety code verifies it.
2. For each accepted file the sender's page asks `direct-request { id }` on the data channel.
3. The receiver's **main process** opens a TCP listener on a random port (`0.0.0.0`, IPv4 only) with a fresh
   random **256-bit key**, registers the file as expected (folder id, sanitised path, exact size) and answers
   `direct-ready { id, ok, link: { port, addresses, key } }`. The key only ever travels over the authenticated
   data channel, never through the signaling server.
4. The sender's main process dials the receiver's addresses (all at once, first to connect wins, 3 s timeout),
   proves it holds the key (`HELLO`) and waits for `READY`. The listener accepts **exactly one** authenticated
   connection and then stops listening.
5. Files stream from disk in 512 KiB chunks, each sealed with AES-256-GCM (the CLI's `FrameCipher`), and are
   written to disk by the receiver's main process. SHA-256 is verified **before** the file is committed.
6. Later files to the same listener reuse the same link, one file at a time.

Wire details: [protocols.md](protocols.md#direct-mode-desktop--desktop-over-tcp). Sequence:
[16-direct-mode-sequence.mmd](../diagrams/16-direct-mode-sequence.mmd).

### Fallback to WebRTC

Direct mode never makes a transfer fail that WebRTC could finish. The sender falls back to a normal WebRTC
`start` when:

| Situation                                                                  | What happens                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The other side is a browser (no `direct: true` in `sync`)                  | WebRTC from the start; nothing changes                                            |
| No `direct-ready` within 10 s, or the receiver says `ok: false`            | That file goes over WebRTC                                                        |
| The receiver isn't reachable (other network, firewall, no allowed address) | WebRTC, and Direct mode is skipped for the rest of the session                    |
| The link drops mid-file, or the receiver confirms no progress for 20 s     | The file is resent over WebRTC from the start; Direct mode is off for the session |

The fallback's `start` also cancels the receiver's Direct expectation for that file, so the file can't arrive
twice. A disk error on the receiver (disk full, drive removed) is that file's failure, reported to the sender
(`SKIP` with the error), not a lost link. If the link drops after the receiver saved a file but before the
sender heard about it, the resent `start` gets the saved result repeated instead of a second copy.

### Receiving from a browser

When the desktop app receives over WebRTC (for example from a phone's browser), the bytes still go into the
chosen folder: the page passes them to the main process (`NativeSink` → `openFile` / `writeFile` / `commitFile`),
which writes them with the same safe-write rules. Nothing is held in browser storage.

### Speed

Measured on the developer's Windows 11 PC (same machine, real disk reads and writes, SHA-256 verified):

| Test                                                     | Result                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| Two packaged `Hopline.exe` instances, 2 GiB              | 17.5 s (**117 MiB/s**)                                        |
| Desktop app from source, **10 GiB**                      | **85.3 s (120 MiB/s)**, SHA-256 identical (`faf3e250…91de14`) |
| Engine alone, Node ↔ Node                                | 119 MiB/s                                                     |
| Engine alone, Electron ↔ Electron                        | 122–128 MiB/s                                                 |
| Before the firewall/loopback fix (LAN address throttled) | ~15–17 MiB/s                                                  |

Between two computers the network decides: wired gigabit Ethernet carries about 110–118 MB/s, so 10 GiB takes
roughly 90–95 s. See [speed-challenge.md](speed-challenge.md).

### Firewall

On **Windows**, inbound connections to an app with no firewall rule are blocked, or allowed but heavily
throttled, on networks marked **Public**. Then Direct mode either can't connect (falls back to WebRTC) or crawls
(the 20 s stall watchdog falls back to WebRTC).

- The installer adds one rule, `Hopline Direct mode`: inbound TCP, `Hopline.exe` only, **Private networks only**
  (never public Wi-Fi). Uninstalling removes it.
- Mark your home or office network as **Private** (Settings → Network & internet → your network → Network
  profile type → Private).
- If Windows shows an "Allow access" prompt, allow Hopline on **private** networks.
- Two apps on the **same machine** use loopback (`127.0.0.1`), which the firewall doesn't touch.

**macOS** may ask whether Hopline may accept incoming connections: click **Allow**. **Linux** desktops usually
have no inbound firewall; with `ufw` enabled, allow Hopline's port range or the app.

## Signaling server

The desktop app needs a signaling server to pair. It picks the first match:

1. `HOPLINE_SIGNALING_URL` environment variable
2. `"signalingUrl"` in `settings.json` in the app's data folder
3. The URL baked into the installer at build time (`resources/app-config.json`, written by
   `scripts/write-app-config.cjs` from `HOPLINE_SIGNALING_URL` during `pack` / `dist`)
4. `ws://localhost:8787/ws` (local development and Docker)

Every value must start with `ws://` or `wss://`; invalid values in `settings.json` or `app-config.json` are
skipped. To point an installed app at your own server, create `settings.json`:

```json
{ "signalingUrl": "wss://hopline.example.com/ws" }
```

| System  | Data folder                             |
| ------- | --------------------------------------- |
| Windows | `%APPDATA%\Hopline`                     |
| macOS   | `~/Library/Application Support/Hopline` |
| Linux   | `~/.config/Hopline`                     |

Restart the app after editing it. The server accepts the desktop app's `file://` origin by default (unless
`ALLOWED_ORIGINS` is set, then add `file://` to it).

## Settings for development and testing

| Variable                | Default                | Purpose                                                                                |
| ----------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `HOPLINE_SIGNALING_URL` | see above              | Signaling server (must be `ws://` or `wss://`)                                         |
| `HOPLINE_WEB_URL`       | _(none)_               | Load the UI from a URL instead of `apps/web/dist` (used by `desktop:dev`; source only) |
| `HOPLINE_PROFILE_DIR`   | _(Electron's default)_ | Separate app profile, so two instances run side by side (e.g. to test Direct mode)     |
| `HOPLINE_DOWNLOADS_DIR` | the system Downloads   | Where **Accept** creates its `Hopline <date>` folder                                   |

From source, the repository's `.env` is loaded too (shell variables win).

```powershell
# PowerShell: two instances on one machine, each with its own profile and download folder
$env:HOPLINE_PROFILE_DIR = "$env:TEMP\hopline-a"; $env:HOPLINE_DOWNLOADS_DIR = "$env:TEMP\dl-a"; npm run desktop
# in a second terminal
$env:HOPLINE_PROFILE_DIR = "$env:TEMP\hopline-b"; $env:HOPLINE_DOWNLOADS_DIR = "$env:TEMP\dl-b"; npm run start -w @hopline/desktop
```

```bash
# bash
HOPLINE_SIGNALING_URL=wss://hopline.example.com/ws npm run desktop
```

## Building installers

Installers are built with [electron-builder](https://www.electron.build) (config: the `build` field in
`apps/desktop/package.json`). They bundle `apps/desktop/src` plus `apps/web/dist` and `app-config.json` as extra
resources, so build the web app first:

```bash
npm run build                          # web app → apps/web/dist
npm run pack -w @hopline/desktop       # unpacked test build in apps/desktop/release/<platform>-unpacked
npm run dist -w @hopline/desktop       # installers for the current OS in apps/desktop/release
```

| Target  | Output                                                                       |
| ------- | ---------------------------------------------------------------------------- |
| Windows | NSIS installer, x64, per-machine, with `build/installer.nsh` (firewall rule) |
| macOS   | DMG, x64 and arm64                                                           |
| Linux   | AppImage and `.deb`, x64                                                     |

Set `HOPLINE_SIGNALING_URL` before `pack` / `dist` to bake in a default server; without it, the app falls back
to `ws://localhost:8787/ws` unless the user creates `settings.json`. electron-builder builds for the OS it runs
on, so official releases are built by GitHub Actions on all three (see [releases.md](releases.md)).
`apps/desktop/release/` is git-ignored and excluded from Prettier and ESLint.

The packaged `Hopline.exe` is a GUI app: started from a terminal it detaches at once (the shell returns
immediately) but keeps running.

## Files

| File                           | Process              | Role                                                                                  |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `src/main.cjs`                 | Main (Node)          | Creates the window, serves config over IPC, guards navigation, attaches Direct mode   |
| `src/preload.cjs`              | Renderer (sandboxed) | Exposes `window.hopline = { isDesktop, signalingUrl, direct }` via `contextBridge`    |
| `src/config.cjs`               | Main                 | Signaling URL resolution, dev/test variables, paths                                   |
| `src/direct-ipc.cjs`           | Main                 | IPC handlers for `window.hopline.direct`; checks every caller; resets on reload/crash |
| `src/direct/service.js`        | Main                 | `DirectService`: folders by id, file tokens, listener, link, native file writes       |
| `src/direct/receiver.js`       | Main                 | `DirectReceiver`: listener, one authenticated connection, verified safe writes        |
| `src/direct/sender.js`         | Main                 | `DirectLink`: address filtering, connect, stream from disk, stall watchdog            |
| `src/direct/wire.js`           | Main                 | Message types and `SecureChannel` (CLI framing + AES-256-GCM)                         |
| `build/installer.nsh`          | Installer            | Adds/removes the Windows firewall rule (private networks only)                        |
| `scripts/ensure-electron.cjs`  | Build tooling        | Downloads the Electron binary if it's missing                                         |
| `scripts/write-app-config.cjs` | Build tooling        | Writes `app-config.json` (default signaling server) before `pack` / `dist`            |

The Direct engine reuses the CLI's `FrameCipher`, `FrameReader`, `toSafePathSegments` and
`utils/safe-write.js` (`SafeFileWriter`), so both share one implementation of encryption and safe writing.

## Security model

| Setting            | Value                                                | Why                                                                 |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `contextIsolation` | `true`                                               | The page can't reach the preload's scope                            |
| `sandbox`          | `true`                                               | The renderer runs with Chromium's sandbox                           |
| `nodeIntegration`  | `false`                                              | No `require`/`process` in the page (verified: both are `undefined`) |
| Preload API        | Two read-only values + a narrow, frozen `direct` API | No Node or Electron objects reach the page                          |
| Navigation         | Only the app's own `file://` (or dev URL)            | Links can't replace the app with a remote page                      |
| New windows        | Denied; `http(s)` links open in the system browser   | No untrusted content inside the app                                 |
| Permissions        | Every permission request denied, no `<webview>`      | Hopline needs no camera, microphone, location…                      |

**Direct mode treats the renderer as untrusted.** If the page were ever compromised, it still couldn't read or
write arbitrary files:

- Files to send are **tokens**, created in the preload from real `File` objects the user picked
  (`webUtils.getPathForFile`); the main process only accepts absolute paths to regular files there.
- Received files are written only into folders the user picked in a native dialog (or the default dated
  Downloads folder), referred to **by folder id**, under sanitised relative paths, with the CLI's safe-write rules:
  exclusive temp file, no symlinks, never overwrite, SHA-256 checked before commit. The page gets back only the
  path relative to the folder.
- Every IPC handler checks that the call comes from this window's `webContents` **and** the exact app URL.
- A reload, navigation, renderer crash or window close resets Direct state: links and listeners closed, partial
  files deleted, tokens and folder ids forgotten.

Network-side protections (one authenticated connection per key, address filtering, pending-socket limits) are in
[security.md](security.md#desktop-direct-mode).

In the desktop app, the invite link and QR code are hidden, because `file://` pages can't be shared as links.
The room code works as usual.
