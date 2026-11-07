# Getting started

## Prerequisites

| Tool                                        | Version                                       | Needed for                              |
| ------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| Node.js                                     | 20.11 or newer (22 recommended, see `.nvmrc`) | Everything except the Docker-only route |
| npm                                         | Comes with Node                               | Installing dependencies                 |
| Docker Desktop / Docker Engine + Compose v2 | Any recent version                            | The Docker route only                   |

## Option A: Docker (recommended for trying it out)

```bash
docker compose up --build -d
```

| URL                          | What                                     |
| ---------------------------- | ---------------------------------------- |
| http://localhost:8080        | The web app (nginx)                      |
| http://localhost:8080/health | Server health, proxied through nginx     |
| ws://localhost:8787/ws       | Signaling, published for the desktop app |

Useful commands:

```bash
docker compose ps          # status and health of both containers
docker compose logs -f     # follow logs (npm run docker:logs)
docker compose down        # stop and remove the containers (npm run docker:down)
```

To try it from a phone, open `http://<your-computer's-LAN-IP>:8080`. Find the IP with `ipconfig` (Windows) or
`ip addr` / `ifconfig` (macOS/Linux).

More detail: [docker.md](docker.md).

## Option B: plain Node.js

```bash
npm install
npm run dev
```

- Signaling server on **http://localhost:8787** (restarts when you edit `apps/server/src` or `packages/protocol/src`)
- Web app with hot reload on **http://localhost:5290** (proxies `/ws` and `/health` to the server)

For a production-style single process (one port serves both the UI and signaling):

```bash
npm run build
npm start          # http://localhost:8787
```

## Desktop app

```bash
npm run desktop        # builds the web app, then opens the desktop window
```

The desktop app needs a signaling server. By default it uses `ws://localhost:8787/ws`, which works with
`npm start`, `npm run dev` or Docker. The first launch downloads the Electron binary (~100 MB). Ready-made
installers are on the [GitHub Releases page](https://github.com/vishwajitvm/Hopline/releases). Two desktop apps on
the same network send files over a direct TCP link (Direct mode), far faster than a browser.

More detail: [desktop.md](desktop.md).

## CLI

```bash
npm run cli -- send ./some-folder file.pdf               # prints a code like 42-amber-river-falcon
npm run cli -- receive 42-amber-river-falcon --out ./downloads
```

No server is involved; both computers must be on the same network. More detail: [cli.md](cli.md).

## Your first transfer (web)

1. Open the app on device A and click **Create a room**. You'll see a 6-character code and a QR code.
2. On device B, enter the code, scan the QR code, or open the invite link.
3. When both show **Connected**, drop files onto the drop area on either device.
4. The receiver clicks **Save** on each file. The sender sees **Delivered** once it arrived intact.

## Next steps

- Change settings: [configuration.md](configuration.md)
- Understand the design: [architecture.md](architecture.md)
- Start developing: [development.md](development.md)
