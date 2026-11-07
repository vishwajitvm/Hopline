# Contributing to Hopline

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, and your OS/browser/app version.
- **Features**: open an issue first so we can agree on the approach before you write code.
- **Security problems**: please follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Development setup

Requirements: Node.js 20.12+ (22 recommended) and npm 10+. Docker is optional.

```bash
git clone https://github.com/vishwajitvm/Hopline.git
cd Hopline
npm install
cp .env.example .env
npm run dev            # signaling server on :8787 + web app on http://localhost:5290
```

Desktop app against the dev server: `npm run desktop:dev`. CLI: `npm run cli -- send <files>`.
More in [docs/development.md](docs/development.md).

## Making a change

1. Create a branch: `git checkout -b feat/short-description`.
2. Keep the layering: UI in `apps/web/src/components`, lifecycle in `hooks`, network/storage/crypto in
   `services`. Protocol messages are defined once in `packages/protocol`.
3. Treat everything from a peer or client as untrusted: validate ids, sizes and counts, sanitise names.
4. Add or update tests next to the code you change.
5. Update `docs/` and `diagrams/` when behaviour changes, and add a line under **Unreleased** in
   [CHANGELOG.md](CHANGELOG.md).
6. Run the full check before you push:

   ```bash
   npm run check          # lint + format check + all tests + production build
   ```

## Commit messages

Short imperative subject (≤ 72 characters), then a blank line and the why if it isn't obvious:

```
Add retransmission when a lane closes

Frames in flight on a closed lane were only recovered by the next resync.
```

## Pull requests

- One topic per pull request, with a description of what changed and how you tested it.
- CI must pass (lint, format, tests, build).
- Screenshots or a short clip help for UI changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
