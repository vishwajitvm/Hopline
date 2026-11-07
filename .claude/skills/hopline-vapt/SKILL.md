---
name: hopline-vapt
description: Run Hopline's security assessment — npm audit, Trivy image scans, the 36-check active attack suite (HTTP, WebSocket, TURN, CLI fuzzing) — then fix findings and update the VAPT report. Use when asked for a security test, VAPT, pentest, vulnerability scan, or after security-relevant changes.
---

# VAPT (only against deployments the user owns)

## 1. Static and supply chain

- `npm audit` and `npm audit --omit=dev`: expect 0.
- Trivy every image (see the `hopline-docker` skill). Expect 0 HIGH/CRITICAL; fixable OS CVEs are usually solved by
  rebuilding (`docker compose build --pull`) since images run `apk upgrade`.
- For an independent code review, use the `security-reviewer` agent and give it the threat model, not your conclusions.

## 2. Active tests

Targets (defaults in `security/vapt/run.mjs`):

- `VAPT_WEB=http://localhost:8080`: `docker compose up -d`
- `VAPT_NODE=http://localhost:8795`: `docker run -d --name hopline-aio -p 8795:8787 hopline:all-in-one`
- `VAPT_TURN=127.0.0.1:3478`: `TURN_EXTERNAL_IP=<lan-ip> docker compose --profile turn up -d` (uses `TURN_SECRET` from `.env`)

Run `npm run vapt`. Results go to `security/vapt/results.json`. All 36 must pass. Note:

- the brute-force check intentionally exhausts the wrong-code budget, so it runs last; reruns within a minute may
  show fewer guesses before the limit;
- the relay SSRF check needs the **default** (private ranges denied) config, so don't pass
  `TURN_EXTRA_ARGS=--allowed-peer-ip…` during VAPT.

## 3. Fix, prove, document

- Every fix gets a regression test (unit/integration) **and** passes the active suite.
- Update `docs/security/vapt-report.md` (finding table, scan table, residual risks) and `docs/security.md`.
- Clean up only the containers you created, by name.
