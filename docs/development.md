# Development

## Setup

```bash
npm install          # installs every workspace (root node_modules)
npm run dev          # server on :8787 (auto-restart) + web on :5290 (hot reload)
```

## Scripts (run from the repository root)

| Script                                              | What it does                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                                       | Server + Vite dev server together (`concurrently`; Ctrl+C stops both)    |
| `npm run build`                                     | Production build of the web app → `apps/web/dist`                        |
| `npm start`                                         | Server that also serves the build on :8787                               |
| `npm run desktop` / `desktop:dev`                   | Desktop app from the build / from the dev server                         |
| `npm run pack -w @hopline/desktop`                  | Unpacked desktop build in `apps/desktop/release` (after `npm run build`) |
| `npm run dist -w @hopline/desktop`                  | Desktop installers for this OS in `apps/desktop/release`                 |
| `npm run cli -- <args>`                             | Run the CLI                                                              |
| `npm test`                                          | All tests (`node --test`, no extra framework)                            |
| `npm run lint`                                      | ESLint (flat config in `eslint.config.js`)                               |
| `npm run format` / `format:check`                   | Prettier write / verify                                                  |
| `npm run check`                                     | lint + format check + tests + build: **run before every commit**         |
| `npm run docker:up` / `docker:down` / `docker:logs` | Docker Compose shortcuts                                                 |

Run a script in one workspace with `-w`, for example `npm run build -w @hopline/web`.

## Workspaces

| Package             | Path                | Depends on                                                                                  |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `@hopline/protocol` | `packages/protocol` | —                                                                                           |
| `@hopline/server`   | `apps/server`       | protocol, `ws`                                                                              |
| `@hopline/web`      | `apps/web`          | protocol, React, `qrcode`                                                                   |
| `@hopline/desktop`  | `apps/desktop`      | `@hopline/cli` (Direct mode engine), Electron + electron-builder (dev), loads the web build |
| `@hopline/cli`      | `apps/cli`          | `@noble/curves`, `@noble/hashes`                                                            |

Add a dependency to one workspace: `npm install <pkg> -w @hopline/web`.

## Tests

```bash
npm test               # 90 tests
```

| Suite         | File                                       | Covers                                                                                               |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Protocol      | `packages/protocol/test/room-code.test.js` | Code normalization, validation, generation                                                           |
| Server        | `apps/server/test/server.test.js`          | Rooms, rate limiter, config, real WebSocket flows, `/health`                                         |
| Web transfer  | `apps/web/test/transfer-manager.test.js`   | Transfer engine over fake channels: resume, lanes (spread, lane loss, reconnect), malicious peers    |
| Web Direct    | `apps/web/test/direct-mode.test.js`        | TransferManager + the real Direct engine: direct path, browser peer, unreachable, link lost, cancel  |
| Desktop       | `apps/desktop/test/direct.test.js`         | Direct engine over real TCP: speed, no-overwrite, cancel, wrong key, one link per key, address rules |
| CLI core      | `apps/cli/test/core.test.js`               | Codes, encryption (tamper/replay/reorder), framing, path safety                                      |
| CLI transfers | `apps/cli/test/transfer.test.js`           | Real send → receive over localhost: folders, 3 MB file, no-overwrite, decline, wrong code            |

The web app's network code is checked end to end in a browser (two tabs, file hashes compared). Adding
Playwright for that is a good next step.

## Code style

- **Prettier** formats (single quotes, 110 columns, trailing commas, LF). **ESLint** catches bugs (React hooks
  rules, unused variables, `eqeqeq`, `prefer-const`).
- ES modules everywhere (`.cjs` only where Electron needs CommonJS).
- File names: `kebab-case.js` for modules; `PascalCase.jsx` for components; `useThing.js` for hooks.
- Private class state uses `#fields`. Enumerations are `Object.freeze`d objects (`Phase`, `TransferStatus`, …).
- Comments explain **why**, not what.

## Adding things

### A new signaling message

1. Add the type to `ClientMessage`/`ServerMessage` (and any `ErrorReason`) in `packages/protocol/src/signaling.js`.
2. Add a handler entry in `SignalingService#handlers` (`apps/server/src/signaling/signaling-service.js`).
3. Listen for it in `useHoplineSession` (or wherever it belongs) via `signaling.on(ServerMessage.X, …)`.
4. Add a test in `apps/server/test/server.test.js`. Update [protocols.md](protocols.md) and the sequence diagram.

### A new data-channel message

1. Add it to `TransferMessage` in `packages/protocol/src/transfer.js`.
2. Handle it in `TransferManager#onControl`.
3. Update [protocols.md](protocols.md) and [04-browser-file-transfer-sequence.mmd](../diagrams/04-browser-file-transfer-sequence.mmd).

### A new UI component

Put it under `components/<area>/`, keep it presentational (props in, callbacks out), and lift any lifecycle logic
into a hook.

### A new server setting

Add it to `loadConfig()` with a `read*` helper (validated, with a default), document it in `.env.example` and
[configuration.md](configuration.md), and pass it through in `docker-compose.yml` if Docker users need it.

## Debugging tips

- Server: `LOG_LEVEL=debug npm run dev -w @hopline/server` logs every connection.
- WebRTC: Chrome's `chrome://webrtc-internals` shows ICE candidates, the chosen route and data-channel stats.
- CLI: `HOPLINE_DEBUG=1` prints stack traces.
