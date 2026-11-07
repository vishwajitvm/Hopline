# Configuration

Every setting is optional. They live in **one `.env` file at the repository root** (copy `.env.example`; `.env` is
git-ignored). It's read automatically by Docker Compose, the server (`npm run dev` / `npm start`), the Vite dev
server and the desktop app. Variables already set in your shell or hosting provider take precedence over the file.

## Signaling server (runtime)

Read by `apps/server/src/config.js`. Invalid values stop the server at startup with a message naming the variable.

| Variable                                     | Default                                | What it does                                                                                                      |
| -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                                       | `8787`                                 | Listening port (0 = random)                                                                                       |
| `HOST`                                       | `0.0.0.0`                              | Listening interface                                                                                               |
| `SERVE_WEB`                                  | `true` (`false` in the Compose server) | Also serve `apps/web/dist`                                                                                        |
| `WEB_DIST`                                   | `apps/web/dist`                        | Where the built web app is                                                                                        |
| `TRUST_PROXY`                                | `false` (`1` in Compose)               | Number of reverse proxies in front (`true` = 1). Only set it when the server is reachable **solely** through them |
| `ALLOWED_ORIGINS`                            | _(empty: same site + desktop app)_     | Comma-separated origins allowed to open `/ws`. Add `file://` to also allow the desktop app                        |
| `ROOM_TTL_MINUTES`                           | `30`                                   | Remove rooms nobody joined                                                                                        |
| `RECONNECT_GRACE_SECONDS`                    | `120`                                  | How long a dropped device keeps its seat                                                                          |
| `HEARTBEAT_SECONDS`                          | `30`                                   | Ping interval; dead sockets are dropped                                                                           |
| `UNJOINED_TIMEOUT_SECONDS`                   | `120`                                  | Close sockets that never create or join a room                                                                    |
| `MAX_CONNECTIONS`                            | `5000`                                 | Total WebSocket connections                                                                                       |
| `MAX_CONNECTIONS_PER_IP`                     | `20`                                   | Per client (IPv6 per /64)                                                                                         |
| `RATE_LIMIT_PER_SECOND` / `RATE_LIMIT_BURST` | `20` / `120`                           | Messages per connection (the burst covers the signaling of the 4 parallel lane connections)                       |
| `JOIN_ATTEMPTS_PER_MINUTE`                   | `10`                                   | Wrong room codes / rejoin tokens per client per minute                                                            |
| `HEALTH_DETAILS`                             | `false`                                | Include room/peer counts in `/health`                                                                             |
| `STUN_URLS`                                  | Google STUN                            | Comma-separated `stun:` URLs handed to clients                                                                    |
| `TURN_URLS`                                  | _(none)_                               | Comma-separated `turn:`/`turns:` URLs (see [turn.md](turn.md))                                                    |
| `TURN_SECRET`                                | _(none)_                               | Shared secret for short-lived credentials (≥ 16 chars)                                                            |
| `TURN_USERNAME` / `TURN_CREDENTIAL`          | _(none)_                               | Fixed credentials (managed providers) instead of `TURN_SECRET`                                                    |
| `TURN_TTL_SECONDS`                           | `43200`                                | Credential lifetime; must outlast your longest transfer                                                           |
| `LOG_LEVEL`                                  | `info`                                 | `debug`, `info`, `warn`, `error`, `silent`                                                                        |
| `LOG_FORMAT`                                 | `pretty` (`json` in production)        | Log style                                                                                                         |
| `HOPLINE_ENV_FILE`                           | repository `.env`                      | Load settings from another file                                                                                   |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`.

## TURN relay container (`docker compose --profile turn`)

| Variable                          | Default           | What it does                                                 |
| --------------------------------- | ----------------- | ------------------------------------------------------------ |
| `TURN_SECRET`                     | _(required)_      | Same value the server uses                                   |
| `TURN_EXTERNAL_IP`                | _(required)_      | The relay host's public IP                                   |
| `TURN_REALM`                      | `hopline`         | Realm advertised by coturn                                   |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49360` | Relay UDP port range (open it in your firewall)              |
| `TURN_MAX_BPS`                    | `0` (unlimited)   | Per-session bandwidth cap in bytes/s                         |
| `TURN_EXTRA_ARGS`                 | _(none)_          | Extra coturn flags (LAN testing only: `--allowed-peer-ip=…`) |

## Web app (build time)

Vite bakes `VITE_*` variables into the build; rebuild after changing them. No secrets belong here.

| Variable             | Default     | What it does                                                |
| -------------------- | ----------- | ----------------------------------------------------------- |
| `VITE_SIGNALING_URL` | same origin | Point the app at a server on another host                   |
| `VITE_STUN_URLS`     | Google STUN | Fallback STUN list (the server normally sends the real one) |

Development-only (read by `vite.config.js`):

| Variable                 | Default                 | What it does                                                        |
| ------------------------ | ----------------------- | ------------------------------------------------------------------- |
| `WEB_DEV_PORT`           | `5290`                  | Vite dev server port (fixed: fails instead of picking another port) |
| `SIGNALING_PROXY_TARGET` | `http://127.0.0.1:8787` | Where the dev server forwards `/ws` and `/health`                   |

## Docker Compose

| Variable      | Default | What it does                                                                       |
| ------------- | ------- | ---------------------------------------------------------------------------------- |
| `WEB_PORT`    | `8080`  | Host port for nginx (the public entry point)                                       |
| `SERVER_PORT` | `8787`  | Host port for the server, **bound to 127.0.0.1** (desktop app on the same machine) |

## Desktop app

| Variable                | Default                  | What it does                                                                   |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `HOPLINE_SIGNALING_URL` | `ws://localhost:8787/ws` | Signaling server (`ws://` or `wss://`); at build time, the installer's default |
| `HOPLINE_WEB_URL`       | _(none)_                 | Load UI from a URL (live reload, from source only)                             |
| `HOPLINE_PROFILE_DIR`   | _(Electron's default)_   | Separate app profile (two instances side by side)                              |
| `HOPLINE_DOWNLOADS_DIR` | system Downloads         | Where **Accept** creates its `Hopline <date>` folder                           |

An installed app reads `HOPLINE_SIGNALING_URL`, then `signalingUrl` in `settings.json` in its data folder, then the
server baked in at build time. Details: [desktop.md](desktop.md#signaling-server).

## CLI

The CLI runs on any computer, so it reads these from that computer's environment:

| Variable                 | Default | What it does                                      |
| ------------------------ | ------- | ------------------------------------------------- |
| `HOPLINE_DISCOVERY_PORT` | `41899` | UDP port for discovery (must match on both sides) |
| `HOPLINE_DEBUG`          | _(off)_ | Print stack traces                                |
| `NO_COLOR`               | _(off)_ | Disable colored output                            |

## Setting variables without the `.env` file

```powershell
# Windows PowerShell
$env:PORT = '9000'; $env:LOG_LEVEL = 'debug'; npm start
```

```bash
# macOS / Linux
PORT=9000 LOG_LEVEL=debug npm start
```
