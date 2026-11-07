# Deployment

> Diagram: [13-render-deployment.mmd](../diagrams/13-render-deployment.mmd)

The easiest way to put Hopline online is **[Render](https://render.com)**, using the [`render.yaml`](../render.yaml)
Blueprint in this repo. One web service runs everything: `npm start` serves the web app **and** the signaling
WebSocket from the same URL, so there is nothing to wire together.

## Deploy to Render (about 5 minutes)

### 1. Put the code on GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/hopline.git
git push -u origin main
```

Create the empty `hopline` repository on GitHub first (no README, so the push doesn't conflict). The Blueprint
deploys the `main` branch; change `branch:` in `render.yaml` if you use another name.

### 2. Create the service from the Blueprint

1. Sign in at [dashboard.render.com](https://dashboard.render.com) (GitHub login is fine).
2. Click **New → Blueprint**.
3. Connect GitHub if asked, then choose the `hopline` repository.
4. Render reads `render.yaml` and shows one web service called `hopline`.
5. It asks for `TURN_URLS`, `TURN_SECRET`, `TURN_USERNAME` and `TURN_CREDENTIAL`. **Leave them blank** unless you
   have a TURN server (see [Going further](#going-further)).
6. Click **Apply**.

The first build takes 2–4 minutes. When it shows **Live**, open `https://hopline.onrender.com` (or the URL
Render shows, if that name was taken).

### 3. Check it

- `https://<your-app>.onrender.com/health` returns `{"status":"ok",…}`.
- Open the site on two devices, create a room on one, join on the other, and send a file.

### Updating

Every push to `main` redeploys automatically (`autoDeployTrigger: commit`). Changes only to docs, diagrams, the
CLI, the desktop app, Markdown files or tests don't trigger a deploy (`buildFilter`).

## What `render.yaml` sets up

| Setting                         | Value                                   | Why                                                                                             |
| ------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runtime`                       | `node` (Node 22 via `NODE_VERSION`)     | Matches local development                                                                       |
| `buildCommand`                  | `npm ci --include=dev && npm run build` | Installs exactly the lockfile, including Vite, then builds the web app                          |
| `startCommand`                  | `npm start`                             | One process: web app + `/ws` signaling on Render's `PORT`                                       |
| `healthCheckPath`               | `/health`                               | Render waits for this before sending traffic, and restarts the service if it fails              |
| `plan`                          | `free`                                  | See the free plan notes below                                                                   |
| `region`                        | `singapore`                             | Change to the region nearest your users **before** the first deploy (it can't be changed later) |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `1`                                     | The server never runs Electron; skips a ~100 MB download                                        |
| `TRUST_PROXY`                   | `true`                                  | Per-IP limits see real client IPs behind Render's proxy                                         |
| `LOG_FORMAT`                    | `json`                                  | Structured logs in Render's log viewer                                                          |

## Free plan notes

- The service **sleeps after 15 minutes** without HTTP requests or WebSocket messages. The next visitor waits
  about a minute while it wakes. Transfers in progress keep it awake.
- Free instances may restart occasionally. Rooms are in memory, so a room that's waiting for its second device is
  lost on restart; just create a new one. Transfers that are already connected aren't affected, because files go
  directly between the devices.
- To remove sleeping, pick a paid instance type in the Render dashboard (**Settings → Instance Type**), or set
  `plan:` in `render.yaml` to one of the paid plan IDs listed in Render's
  [Blueprint reference](https://render.com/docs/blueprint-spec).

## Going further

### Custom domain

In the service's **Settings → Custom Domains**, add your domain and create the DNS record Render shows. HTTPS
certificates are automatic.

### TURN relay (strongly recommended for international or mobile transfers)

Some networks (mobile data, carrier-grade NAT, offices) block direct WebRTC connections. A relay fixes that while
keeping the data end-to-end encrypted. Render can't host the relay itself (it needs UDP ports), so run the included
coturn on any small VPS (`docker compose --profile turn up -d`) or use a managed TURN provider, then set
`TURN_URLS` and `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`) in **Environment**. They're read at runtime; no
rebuild needed. Full guide: [turn.md](turn.md).

### Restrict who can connect

Add `ALLOWED_ORIGINS=https://<your-app>.onrender.com` (comma-separate several). Skip it if desktop apps connect to
this server, because desktop pages have no web origin.

### Point the desktop app at your deployment

For downloadable installers, set the repository variable `HOPLINE_SIGNALING_URL` to
`wss://<your-app>.onrender.com/ws` before tagging a release, so the apps work out of the box: see
[releases.md](releases.md). An installed app can also be pointed at a server with `settings.json`
([desktop.md](desktop.md#signaling-server)). From source:

```powershell
$env:HOPLINE_SIGNALING_URL = 'wss://<your-app>.onrender.com/ws'; npm run desktop
```

## Other hosts

The root [`Dockerfile`](../Dockerfile) builds an **all-in-one image** (web app + signaling, one port), so most
hosts can deploy straight from the repo:

```bash
docker build -t hopline .
docker run -p 8787:8787 hopline     # http://localhost:8787
```

| Host                                            | How                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Railway**                                     | New project → Deploy from GitHub repo. It detects the `Dockerfile`; add a public domain under Networking. Never sleeps; usage-based pricing.                                 |
| **Fly.io**                                      | `fly launch` (detects the `Dockerfile`; set the internal port to `8787`), then `fly deploy`. Pay as you go.                                                                  |
| **Koyeb**                                       | Create a service from GitHub and choose the Dockerfile builder, port `8787`. Has a free plan.                                                                                |
| **Any VPS** (DigitalOcean, Hetzner, Lightsail…) | Install Docker, clone the repo, `docker compose up -d --build`, and put Caddy or nginx with HTTPS in front of port 8080. See [docker.md](docker.md#going-to-production).     |
| **Vercel**                                      | Fine for the frontend only (static build with `VITE_SIGNALING_URL` pointing at a backend hosted elsewhere). Running the backend there needs Redis and reconnect logic first. |
