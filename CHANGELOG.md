# Changelog

All notable changes to Hopline are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.0.3] - 2026-11-09

### Fixed

- **"Couldn't reach the Hopline server" when the server was asleep.** Free hosting (Render's free plan) pauses an
  idle server and takes 25–60 s to wake it; the app gave up after 8 s. The first connection now keeps trying for
  90 s and shows "Waking up the server…" with an explanation.
- **A server restart ended working transfers.** After a redeploy or a free-plan sleep the server forgets its rooms;
  a failed rejoin (or a lost server connection) ended the session even though the devices were still connected
  directly. The session now continues with a notice; only an unconnected session ends.

## [1.0.2] - 2026-11-07

### Added

- **Public web app at [hopline.onrender.com](https://hopline.onrender.com)**, deployed on Render from
  `render.yaml`. Verified live: 21/21 active security checks and a browser-to-browser transfer.
- The desktop apps connect to hopline.onrender.com out of the box (bundled default signaling server; still
  overridable with `settings.json`).
- An interactive README: open-in-browser and download buttons, "pick your way" cards, collapsible install guides
  and FAQ, and diagrams of which path a transfer takes.
- The security test suite (`npm run vapt`) can test HTTPS deployments and tolerates hosting proxies that pass
  WebSocket closes on late.

### Removed

- Dependabot version-update pull requests (they created a branch per update); `main` is the only branch.

## [1.0.1] - 2026-11-07

First release with downloadable installers.

### Fixed

- Linux installers failed to build (the executable name came from the scoped package name). The Linux app is now
  `hopline`, with a proper desktop entry.

### Changed

- Installer file names no longer include the version (`Hopline-Windows-x64-Setup.exe`, `Hopline-macOS-arm64.dmg`,
  `Hopline-macOS-x64.dmg`, `Hopline-Linux-x86_64.AppImage`, `Hopline-Linux-amd64.deb`), so the README's download
  buttons always point at the latest release.
- GitHub Actions use the Node 24 versions of `checkout` and `setup-node`.

## [1.0.0] - 2026-11-07

The first public release (source only: the installer build failed on Linux, so no installers were published; see
1.0.1).

### Added

- **Web app** (React + Vite): device-to-device transfers over WebRTC with a 6-character room code, a QR code and
  invite links. Files never touch the server.
- **Desktop app** (Electron) for Windows, macOS and Linux, with downloadable installers on GitHub Releases.
- **Direct mode** (desktop ↔ desktop): files travel over a direct TCP link at native disk and network speed,
  AES-256-GCM encrypted with a one-time 256-bit key handed over the authenticated WebRTC channel. Measured on one
  PC: **10 GiB in 85 s**, byte-identical. Falls back to WebRTC automatically when the devices can't reach each
  other.
- **Parallel lanes**: up to 4 WebRTC connections per transfer, offset-tagged frames reordered on the receiver,
  retransmission when a lane drops, so long, lossy internet routes go faster without losing a byte.
- **CLI** for computers on the same network: CPace PAKE (ristretto255) with human-readable codes, AES-256-GCM,
  a new dated folder per transfer, exclusive temp files and no-overwrite commits. 10 GiB in 57 s (loopback).
- **Signaling server** (Node + `ws`): rooms with rejoin tokens and a reconnect grace period, same-origin policy,
  per-client limits, brute-force throttling, TURN credentials issued only after pairing.
- **Optional TURN relay** (hardened coturn image) for strict networks and "Hide my IP".
- **Integrity**: SHA-256 of every file, verified before the file is committed; resumable transfers after a
  dropped connection; a reloaded page rejoins its room and gets unfinished files offered again.
- **Safety code**: a 16-digit code from the DTLS certificates proves there's no one in the middle, and covers
  every lane (all connections of a device share one certificate).
- **Deployment**: Docker Compose (nginx + server), an all-in-one image, a Render blueprint, and a public
  Cloudflare quick tunnel (`npm run tunnel`).
- **Security testing**: a 36-check active VAPT suite (`npm run vapt`), Trivy image scans, independent code
  reviews, and 90 automated tests. See `docs/security/vapt-report.md`.
- **Documentation**: `docs/` (architecture, protocols, security, deployment, troubleshooting, the speed
  challenge) and Mermaid diagrams in `diagrams/`.

[Unreleased]: https://github.com/vishwajitvm/Hopline/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/vishwajitvm/Hopline/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/vishwajitvm/Hopline/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/vishwajitvm/Hopline/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vishwajitvm/Hopline/releases/tag/v1.0.0
