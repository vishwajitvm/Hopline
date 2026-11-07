# Backend: signaling server

> Code: `apps/server` · Diagram: [07-backend-components.mmd](../diagrams/07-backend-components.mmd)

The server pairs two devices in a room and relays the WebRTC setup messages between them. It **never receives
file data**. It can also serve the built web app so a single process runs everything.

Runtime dependency: [`ws`](https://github.com/websockets/ws) (plus the internal `@hopline/protocol`).

## Folder layout

```
apps/server/
├── Dockerfile
├── package.json
├── src/
│   ├── index.js                     Entry point: .env → config → logger → app → listen; graceful shutdown
│   ├── load-env.js                  Loads the repository .env (environment variables win)
│   ├── app.js                       createApp(): HTTP server, security headers, /health, static files, signaling
│   ├── config.js                    loadConfig(): reads and validates environment variables
│   ├── http/
│   │   ├── static-files.js          Serves apps/web/dist (SPA fallback, caching, traversal-safe)
│   │   └── security-headers.js      CSP, X-Frame-Options, HSTS (over HTTPS) …
│   ├── signaling/
│   │   ├── signaling-service.js     WebSocket server, message routing, reconnect grace, abuse controls
│   │   ├── room-registry.js         Rooms with two seats, secret per-seat tokens, expiry
│   │   ├── ice-servers.js           STUN list + short-lived TURN credentials (HMAC)
│   │   └── peer.js                  One connection: socket, seat, liveness, rate limiter
│   └── lib/
│       ├── logger.js                Pretty or JSON-lines logger, child loggers
│       ├── token-bucket.js          Rate limiter
│       └── client-ip.js             Trusted-proxy-aware client address, IPv6 /64 grouping
└── test/
    └── server.test.js               Unit + WebSocket integration + abuse-control tests
```

## Startup

`index.js`:

1. Loads the repository `.env` (if present; already-set variables win).
2. `loadConfig()` validates every variable and exits with a clear message on a bad value
   (for example `Invalid value for PORT: "abc" (expected an integer between 0 and 65535)`).
3. Creates the logger (`pretty` in development, `json` when `NODE_ENV=production`).
4. `createApp({ config, logger })` builds the HTTP server and attaches the `SignalingService`.
5. Listens and logs the URLs, whether the web app and a TURN relay are configured, and which `.env` was used.
6. On `SIGINT`/`SIGTERM`, closes WebSockets with code 1001, stops the HTTP server, and force-exits after 10 s.

`createApp` has no process-level side effects (no env reads, no signal handlers), so tests create isolated
instances on random ports.

## HTTP routes

Every response carries the security headers (CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`, COOP/CORP, and HSTS when served over HTTPS). Only `GET` and `HEAD` are accepted (others → 405).

| Route                                              | Response                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`                                      | `{ "status": "ok", "uptime": 12 }`; with `HEALTH_DETAILS=true` also `rooms` and `peers`   |
| `GET /*` with `SERVE_WEB=true` and a build present | Files from `apps/web/dist`; unknown paths get `index.html`; `/assets/*` cached for a year |
| `GET /` with no build                              | Plain text: "Hopline signaling server is running"                                         |
| anything else                                      | `404 { "error": "Not found" }`                                                            |
| WebSocket upgrade on `/ws`                         | Signaling (below)                                                                         |

## Signaling

Message formats are in [protocols.md](protocols.md#signaling-websocket-ws). Handlers are a lookup table in
`SignalingService` (`#handlers`, looked up with `Object.hasOwn`, so `__proto__` and friends are just "unknown").

| Client sends | Server does                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | Creates a room and a secret seat token; replies `created` (STUN only)                                                                     |
| `join`       | Validates the code (wrong codes cost budget); replies `joined` with TURN credentials and tells the creator `peer-joined` (also with TURN) |
| `rejoin`     | Reclaims a seat by code + token; replaces a ghost socket; tells the other side `peer-reconnected`                                         |
| `signal`     | Relays `data` to the other member (dropped while that member is reconnecting)                                                             |
| `leave`      | Closes the room now; the other side gets `peer-left`                                                                                      |
| socket drops | Holds the seat for `RECONNECT_GRACE_SECONDS`, tells the other side `peer-disconnected`, then `peer-left` if it doesn't return             |

### Rooms

- `RoomRegistry` keeps `Map<code, { code, members: [{ token, peer, graceTimer }], createdAt }>`. A _member_ is a seat;
  a _peer_ is the socket currently in it (null while reconnecting).
- Two seats per room. Codes: 32 unambiguous characters (no `0/O/1/I`), 6 long (~1 billion). Tokens: 192 bits,
  compared in constant time.
- Rooms nobody joins expire after `ROOM_TTL_MINUTES`; the creator gets an `expired` error.

### Abuse controls

| Control                          | Default                                       | Setting                                     |
| -------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Allowed origins                  | same site + desktop app + non-browser clients | `ALLOWED_ORIGINS`                           |
| Max message size                 | 64 KiB (larger → socket closed, code 1009)    | constant `MAX_SIGNAL_MESSAGE_BYTES`         |
| Messages per connection          | 20/s, bursts of 120                           | `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_BURST` |
| Wrong room codes / rejoin tokens | 10 per minute per client                      | `JOIN_ATTEMPTS_PER_MINUTE`                  |
| Connections                      | 20 per client, 5,000 total                    | `MAX_CONNECTIONS_PER_IP`, `MAX_CONNECTIONS` |
| Sockets not in a room            | closed after 2 min                            | `UNJOINED_TIMEOUT_SECONDS`                  |
| Dead connections                 | ping every 30 s, dropped if no pong           | `HEARTBEAT_SECONDS`                         |
| TURN credentials                 | only to paired devices, expire                | `TURN_TTL_SECONDS`                          |
| Slow HTTP clients                | headers 15 s, request 30 s                    | built in                                    |

"Client" means the IP address (IPv6: its /64). Behind reverse proxies set `TRUST_PROXY` to the number of proxies;
the client is then read from the **right** end of `X-Forwarded-For`, so values a client adds itself are ignored.
Never set it if clients can reach the server without passing through the proxy.

## Logging

```
16:29:28.072 INFO  Hopline server started  port=8790 local=http://localhost:8790 servingWeb=true
```

In JSON mode, each line is one object (`time`, `level`, `msg`, fields), which suits Docker and log collectors.
Room events log at `info`; per-connection events log at `debug` (`LOG_LEVEL=debug`).

## Scaling notes

Rooms live in memory, so one server process holds all rooms. That comfortably handles thousands of concurrent
pairings, because the server only relays a handful of small messages per connection. To run several instances,
either use sticky sessions keyed by room code, or move `RoomRegistry` to a shared store (such as Redis pub/sub). The
registry is isolated behind a small interface (`create`, `join`, `findMember`, `otherMember`, `close`, `sweepExpired`) to make that
swap straightforward.

## Tests

`apps/server/test/server.test.js` covers the room registry, the token bucket, config validation, a full
create → join → signal → leave flow over real WebSockets, bad-input handling, and `/health`.
