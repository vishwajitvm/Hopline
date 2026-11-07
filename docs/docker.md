# Docker

> Diagram: [11-docker-deployment.mmd](../diagrams/11-docker-deployment.mmd)

## Services

| Service                       | Image                                             | Port                                                 | Contents                                                                       |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `web`                         | `hopline/web` (nginx-unprivileged stable, Alpine) | `8080` → `WEB_PORT` (public)                         | The built web app; proxies `/ws` and `/health` to `server`                     |
| `server`                      | `hopline/server` (Node 22, Alpine)                | `8787` → `127.0.0.1:SERVER_PORT` (this machine only) | Signaling server (`SERVE_WEB=false`; nginx serves the UI)                      |
| `turn` _(profile `turn`)_     | `hopline/turn` (coturn, Alpine)                   | `3478` udp/tcp + relay UDP range                     | TURN relay for devices on strict networks (see [turn.md](turn.md))             |
| `tunnel` _(profile `tunnel`)_ | `cloudflare/cloudflared`                          | none (outbound only)                                 | Public `https://…trycloudflare.com` URL for `web` (see [tunnel.md](tunnel.md)) |

`web` starts only after `server` reports healthy. Start the relay too with
`docker compose --profile turn up --build -d` (needs `TURN_SECRET` and `TURN_EXTERNAL_IP` in `.env`).

## Commands

```bash
docker compose up --build -d     # build images and start (npm run docker:up)
docker compose ps                # status + health
docker compose logs -f server    # follow one service (npm run docker:logs for all)
docker compose restart server
docker compose down              # stop and remove containers (npm run docker:down)
docker compose build --no-cache  # rebuild from scratch
```

## Images

All Dockerfiles build from the **repository root** (context `.`) so they can use the shared
`packages/protocol` and the single `package-lock.json`.

| Dockerfile               | Image                                                        | Use it for                                                                               |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `apps/server/Dockerfile` | Signaling server only                                        | Docker Compose (`server` service)                                                        |
| `apps/web/Dockerfile`    | nginx + built web app                                        | Docker Compose (`web` service)                                                           |
| `Dockerfile` (root)      | **All-in-one**: web app + server on one port (8787), ~240 MB | Single-service hosts: Fly.io, Railway, Koyeb, a VPS (see [deployment.md](deployment.md)) |

```bash
docker build -t hopline .
docker run -p 8787:8787 hopline     # http://localhost:8787
```

### `apps/server/Dockerfile`

1. **deps** stage: copies only the `package.json` files and the lockfile, then runs
   `npm ci --omit=dev --workspace @hopline/server`. This layer is cached until a manifest or the lockfile changes.
2. **runtime** stage: copies `node_modules`, `packages/protocol` and `apps/server/src`. It runs as the `node` user,
   with a `HEALTHCHECK` on `/health`.

### `apps/web/Dockerfile`

1. **build** stage: `npm ci --workspace @hopline/web`, then `vite build`. `VITE_*` values arrive as build args.
2. **runtime** stage: `nginxinc/nginx-unprivileged` (runs as non-root on port 8080). At startup, nginx fills
   `${SIGNALING_UPSTREAM}` (default `server:8787`) into `nginx/default.conf.template`.

### `infra/turn/Dockerfile`

coturn with `apk upgrade` at build time and `entrypoint.sh`, which refuses to start without a strong `TURN_SECRET`
and a `TURN_EXTERNAL_IP`, then runs coturn with: shared-secret auth, no TLS listener, no TCP relaying, quotas,
optional bandwidth cap, and **denied relaying to private, loopback, link-local, CGNAT, IPv4-mapped and NAT64
addresses** (SSRF protection).

### nginx behavior (`apps/web/nginx/default.conf.template`)

| Path            | Behavior                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/ws`           | WebSocket proxy to the server (1-hour timeout). Passes `Host` with its port and **overwrites** `X-Forwarded-For` |
| `/health`       | Proxied server health                                                                                            |
| `/nginx-health` | Container's own health check                                                                                     |
| `/assets/*`     | `Cache-Control: public, max-age=31536000, immutable` (file names are content-hashed)                             |
| everything else | `index.html` with `no-cache` (single-page app)                                                                   |

Security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP) are set once at
server level and no location adds its own, because in nginx any `add_header` inside a location silently drops the
inherited ones. Only GET/HEAD are allowed; `server_tokens` is off; request bodies are capped at 1 KB.

## Hardening already applied

- All containers run as non-root users with `no-new-privileges`; `server` and `turn` have read-only filesystems.
- Base images get `apk upgrade` at build time; npm, npx, corepack and yarn are removed from Node runtime images.
- App files are owned by root, so the app user can't modify its own code.
- The signaling port is published on **127.0.0.1 only**; the only public entry point is nginx. That's what makes
  `TRUST_PROXY=1` safe: nobody can reach the server without going through nginx.
- Health checks on every service, with automatic restarts.
- `.dockerignore` keeps `node_modules`, builds, git data, `.env` files and tests out of the build context.

## Going to production

1. Put a TLS-terminating proxy (Caddy, Traefik, nginx, or a cloud load balancer) in front of `web`, and serve it
   over **HTTPS**. Browsers allow some features (like the clipboard) only on secure origins.
2. Set `ALLOWED_ORIGINS=https://your-domain` in `.env`.
3. If no desktop app runs on the server machine itself, remove the `server` port mapping entirely.
4. Turn on the relay for users on strict networks: set `TURN_SECRET`, `TURN_EXTERNAL_IP` and `TURN_URLS`, then
   `docker compose --profile turn up --build -d` (see [turn.md](turn.md)).
5. Optional: set `LOG_LEVEL=warn` to reduce log volume.
