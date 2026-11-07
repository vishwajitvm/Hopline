# Desktop releases

> Code: `apps/desktop` (electron-builder config in its `package.json`), `.github/workflows/release.yml`

Desktop installers are built by GitHub Actions and attached to a GitHub Release at
[github.com/vishwajitvm/Hopline/releases](https://github.com/vishwajitvm/Hopline/releases). Users download them
from there (see [desktop.md](desktop.md#installing)).

| Platform | Files                                                                      |
| -------- | -------------------------------------------------------------------------- |
| Windows  | `Hopline-Windows-x64-Setup.exe` (NSIS, adds the Direct mode firewall rule) |
| macOS    | `Hopline-macOS-x64.dmg`, `Hopline-macOS-arm64.dmg`                         |
| Linux    | `Hopline-Linux-x86_64.AppImage`, `Hopline-Linux-amd64.deb`                 |

## One-time setup: the default signaling server

A downloaded app needs a signaling server to pair. Bake yours in so the app works out of the box:

1. Deploy the server (for example [on Render](deployment.md)) and note its WebSocket URL, e.g.
   `wss://hopline.onrender.com/ws`.
2. In the GitHub repository: **Settings → Secrets and variables → Actions → Variables → New repository
   variable**, name `HOPLINE_SIGNALING_URL`, value the `wss://…/ws` URL.

The release build runs `scripts/write-app-config.cjs`, which writes it into `app-config.json` inside the installer.
It must start with `ws://` or `wss://` (use `wss://` for anything on the internet). Without it, the app falls back
to `ws://localhost:8787/ws`, and users have to point it at a server with `settings.json` (see
[desktop.md](desktop.md#signaling-server)). The server accepts the desktop app's `file://` origin by default; if you
set `ALLOWED_ORIGINS` on the server, add `file://` to it.

## Publishing a release

1. Make sure `main` is green: `npm run check`.
2. Bump the version (Semantic Versioning) in `apps/desktop/package.json`. Installer file names come from it; keep the root and workspace `package.json` versions in step.
3. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
4. Commit, then tag and push:

   ```bash
   git commit -am "Release v1.0.0"
   git push
   git tag v1.0.0 && git push --tags
   ```

5. The `v*` tag starts `.github/workflows/release.yml`: three jobs (Windows, macOS, Linux) run the tests, build the
   web app and run `electron-builder --publish never`; a final job collects the installers, writes
   `SHA256SUMS.txt`, and creates the GitHub Release with the notes from this version's CHANGELOG section
   (`scripts/release-notes.mjs`). Check the **Actions** tab, then the release page.
6. Smoke-test a downloaded installer: it connects to your server, and two desktop apps on one network show the
   **Direct link** tag.

## Building locally

electron-builder builds for the OS it runs on. To try a build before tagging:

```bash
npm run build                          # web app → apps/web/dist (bundled into the app)
npm run pack -w @hopline/desktop       # unpacked app in apps/desktop/release/<platform>-unpacked
npm run dist -w @hopline/desktop       # installers in apps/desktop/release
```

Set `HOPLINE_SIGNALING_URL` in the shell first to bake in a server. `apps/desktop/release/` is git-ignored and
excluded from Prettier and ESLint.

## Signing

The installers are **unsigned**, so Windows SmartScreen and macOS Gatekeeper warn on first launch (workarounds in
[desktop.md](desktop.md#installing)). Signing needs a Windows code-signing certificate and an Apple Developer ID
(with notarization); electron-builder picks them up from its standard environment variables (`CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, …) once they're added as repository secrets and passed to the workflow.
