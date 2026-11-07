---
name: hopline-docker
description: Build, start, stop, inspect and scan Hopline's Docker stack (nginx web, signaling server, optional TURN relay and tunnel). Use for anything involving docker compose, images, containers or Trivy scans for this project.
---

# Docker stack

| Task                                                | Command                                                                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build + start (web :8080, server on 127.0.0.1:8787) | `docker compose up --build -d`                                                                                                                                                                                                         |
| Also start the TURN relay                           | `docker compose --profile turn up --build -d` (needs `TURN_SECRET`, `TURN_EXTERNAL_IP` in `.env`)                                                                                                                                      |
| Public tunnel                                       | `npm run tunnel` (see the `hopline-tunnel` skill)                                                                                                                                                                                      |
| Status / logs                                       | `docker compose ps` · `docker compose logs -f <service>`                                                                                                                                                                               |
| Stop                                                | `docker compose down` (add `--profile turn --profile tunnel` to include those)                                                                                                                                                         |
| Validate the file                                   | `docker compose config --quiet` and `docker compose --profile turn config --quiet`                                                                                                                                                     |
| Scan images                                         | `docker run --rm -v //var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy:latest image --severity HIGH,CRITICAL hopline/web:latest` (repeat for `hopline/server`, `hopline/turn`, `hopline:all-in-one`) |
| All-in-one image                                    | `docker build -t hopline:all-in-one .` then `docker run -p 8787:8787 hopline:all-in-one`                                                                                                                                               |

After `up`, confirm health: `docker compose ps` shows `(healthy)`, and `http://localhost:8080/health` returns
`{"status":"ok",…}`.

## Safety rules (this machine runs other projects' containers)

- **Never** use `docker container prune`, `docker system prune`, `docker rm $(docker ps -aq)` or similar. Remove
  only containers you created, by exact name (`docker rm -f hopline-…`).
- Don't stop, restart or inspect FLO/LMS containers, and don't restart Docker Desktop to fix network issues.
- If builds fail with `TLS handshake timeout` to `auth.docker.io`, Docker's VM is starved by other workloads.
  Retry later with a few attempts and a pause between; test with `docker pull <image>` first.

## Image facts

- Builds use the repo root as context. Every workspace `package.json` is copied so `npm ci` validates the lockfile.
- Runtime images run `apk upgrade`, drop npm/yarn/corepack, run as non-root, and app files are root-owned.
- No `# syntax=` line: it adds a registry fetch and the built-in frontend supports everything used.
- Last scan (2026-11-07): 0 HIGH/CRITICAL in all four images. Rescan after rebuilding and update
  `docs/security/vapt-report.md`.
