# Hopline documentation

Hopline sends files directly between devices: browsers and the desktop app over WebRTC, two desktop apps on the
same network over a native TCP link (Direct mode), and computers on the same network through the CLI. This folder explains how to run it, how it's built, and how to work on it.

## Start here

| Doc                                   | Read it when you want to…                                |
| ------------------------------------- | -------------------------------------------------------- |
| [Getting started](getting-started.md) | Run Hopline for the first time (Docker or plain Node)    |
| [Architecture](architecture.md)       | Understand the big picture and how the pieces fit        |
| [Configuration](configuration.md)     | Change ports, limits, logging, STUN/TURN                 |
| [TURN relay](turn.md)                 | Make transfers work across countries and strict networks |
| [Speed challenge](speed-challenge.md) | 10 GB in 2 minutes: measurements, limits and the plan    |

## Parts of the system

| Doc                       | Covers                                                                     | Code                                                                |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Backend](backend.md)     | Signaling server: rooms, relay, limits, health                             | `apps/server`                                                       |
| [Frontend](frontend.md)   | Web app: components, hooks, services, state                                | `apps/web`                                                          |
| [Desktop](desktop.md)     | Electron app: installing, Direct mode, building installers, security model | `apps/desktop`                                                      |
| [CLI](cli.md)             | LAN transfers from the terminal                                            | `apps/cli`                                                          |
| [Protocols](protocols.md) | Every message format: signaling, data channel, Direct mode, CLI wire       | `packages/protocol`, `apps/desktop/src/direct`, `apps/cli/src/core` |

## Running and maintaining

| Doc                                    | Covers                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------- |
| [Deployment](deployment.md)            | Put it online: Render in ~5 minutes, plus other hosts                      |
| [Desktop releases](releases.md)        | Publish desktop installers on GitHub Releases (tag `v*`, default server)   |
| [Public tunnel](tunnel.md)             | Instant public HTTPS link for phones and other networks (`npm run tunnel`) |
| [Docker](docker.md)                    | Images, Compose services, health checks, production notes                  |
| [Development](development.md)          | Scripts, tests, code style, adding a feature                               |
| [Security](security.md)                | Threat model, what is encrypted, known limits                              |
| [VAPT report](security/vapt-report.md) | Penetration-test findings, fixes and how to re-run the tests               |
| [Troubleshooting](troubleshooting.md)  | Common problems and fixes                                                  |

## Diagrams

All diagrams are Mermaid files in [`../diagrams`](../diagrams) — see its [README](../diagrams/README.md) for how
to view them. The docs reference them by file name.
