# Diagrams

Every diagram is a plain-text [Mermaid](https://mermaid.js.org) file (`.mmd`), so it lives next to the code,
diffs cleanly in git and never goes stale as an exported image.

| File                                                                           | Shows                                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [01-system-overview.mmd](01-system-overview.mmd)                               | All clients, the server, and which paths carry file data       |
| [02-repository-structure.mmd](02-repository-structure.mmd)                     | Monorepo workspaces and their dependencies                     |
| [03-webrtc-connection-sequence.mmd](03-webrtc-connection-sequence.mmd)         | Create/join a room, open the WebRTC connection and its lanes   |
| [04-browser-file-transfer-sequence.mmd](04-browser-file-transfer-sequence.mmd) | Sending a file over the channels (lanes, frames, reorder, ack) |
| [05-session-state-machine.mmd](05-session-state-machine.mmd)                   | Web/desktop session phases (`session-reducer.js`)              |
| [06-transfer-status-states.mmd](06-transfer-status-states.mmd)                 | Status of each transfer row (`TransferStatus`)                 |
| [07-backend-components.mmd](07-backend-components.mmd)                         | Signaling server modules and message handlers                  |
| [08-frontend-architecture.mmd](08-frontend-architecture.mmd)                   | Web app layers: components, hooks, state, services             |
| [09-cli-transfer-sequence.mmd](09-cli-transfer-sequence.mmd)                   | CLI discovery, handshake and encrypted transfer                |
| [10-cli-key-derivation.mmd](10-cli-key-derivation.mmd)                         | CLI session key derivation and frame encryption                |
| [11-docker-deployment.mmd](11-docker-deployment.mmd)                           | Docker Compose containers, proxying and health checks          |
| [12-desktop-app.mmd](12-desktop-app.mmd)                                       | Electron main process, sandboxed renderer, bridge, Direct mode |
| [13-render-deployment.mmd](13-render-deployment.mmd)                           | Deploying to Render from GitHub with `render.yaml`             |
| [14-reconnect-and-resume.mmd](14-reconnect-and-resume.mmd)                     | A dropped lane or connection mid-transfer, and how it resumes  |
| [15-relay-and-ssrf-guard.mmd](15-relay-and-ssrf-guard.mmd)                     | When the TURN relay is used, credentials, and what it refuses  |
| [16-direct-mode-sequence.mmd](16-direct-mode-sequence.mmd)                     | Desktop ↔ desktop Direct mode: key handoff, TCP link, fallback |

## Viewing them

- **VS Code**: install the _Mermaid Chart_ or _Markdown Preview Mermaid Support_ extension and open the file.
- **JetBrains IDEs**: the built-in Mermaid plugin previews `.mmd` files.
- **Browser**: paste the file contents into [mermaid.live](https://mermaid.live).
- **Export to SVG/PNG**: `npx -p @mermaid-js/mermaid-cli mmdc -i diagrams/01-system-overview.mmd -o out.svg`

## Keeping them current

When you change a flow, update its diagram in the same commit. The tables above and the docs in [`../docs`](../docs)
point at these files by name, so rename with care.
