---
name: hopline-deploy
description: Deploy Hopline online — Render Blueprint (render.yaml), other hosts via the all-in-one Dockerfile, a VPS with docker compose, and the TURN relay needed for international/mobile transfers. Use when asked to deploy, host, put online, or configure production.
---

# Deploying

## Render (default)

- `render.yaml` = one web service: `npm ci --include=dev && npm run build`, `npm start`, `/health`, Node 22,
  `TRUST_PROXY=true` (1 hop), region `singapore` (pick before first deploy; can't change later).
- Steps for the user: push to GitHub → dashboard.render.com → New → Blueprint → choose repo → Apply.
- Render can't host TURN (needs UDP). Point `TURN_URLS` + `TURN_SECRET` (or `TURN_USERNAME`/`TURN_CREDENTIAL`) at a
  relay elsewhere; they're read at runtime.
- Free plan sleeps after 15 min idle (~1 min wake).

## Other hosts

- Single container: root `Dockerfile` (all-in-one, port 8787, `TRUST_PROXY=0` by default; set it to the number of
  proxies only when the container is reachable solely through them).
- VPS: `docker compose up --build -d` behind an HTTPS proxy (Caddy/nginx), set `ALLOWED_ORIGINS`, and run the relay
  with `--profile turn` (open 3478 udp/tcp + relay range).

## Production checklist

- HTTPS everywhere (enables WSS, browser disk storage, clipboard).
- A TURN relay for cross-network/mobile users (`docs/turn.md`).
- `TRUST_PROXY` matches the real proxy chain; the server isn't reachable around the proxy.
- Rebuild images regularly (`docker compose build --pull`) and rescan (`hopline-vapt` skill).

Pushing code, creating services or accounts are user actions: prepare everything, then let the user do them.
