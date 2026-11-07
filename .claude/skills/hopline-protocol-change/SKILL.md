---
name: hopline-protocol-change
description: Add or change a Hopline protocol message consistently — signaling (WebSocket), data-channel transfer protocol, or the CLI wire protocol — across the shared package, server, clients, tests, docs and diagrams. Use when adding a message type, field, limit, or protocol version.
---

# Changing a protocol

## Signaling message (client ↔ server)

1. `packages/protocol/src/signaling.js`: add to `ClientMessage`/`ServerMessage` (and `ErrorReason`/`ErrorMessages`),
   and update the header comment.
2. `apps/server/src/signaling/signaling-service.js`: add an entry in `#handlers` plus a `#handleX` method. Validate
   every field; consider whether it should cost from the guess budget or need the rate limiter.
3. Web: listen with `signaling.on(ServerMessage.X, …)` in `apps/web/src/hooks/useHoplineSession.js`.
4. Tests in `apps/server/test/server.test.js` (happy path + malformed input).

## Data-channel message (peer ↔ peer)

1. `packages/protocol/src/transfer.js`: add to `TransferMessage`; bump `DATA_PROTOCOL_VERSION` if old clients
   can't understand it (the `sync` version check then stops mismatched peers cleanly).
2. `apps/web/src/services/transfer/transfer-manager.js`: handle it in `#handle`. Treat all fields as hostile
   (use `isId`, `isByteCount`, bounds from `TransferLimits`).
3. Tests in `apps/web/test/transfer-manager.test.js`: normal flow plus a "malicious peer" case.

## CLI wire message

1. `apps/cli/src/core/messages.js` (`MessageType`); handshake changes go in `handshake.js` and need a `VERSION`
   bump. Never weaken the CPace exchange.
2. Tests in `apps/cli/test/core.test.js` / `transfer.test.js`.

## Always

- Update `docs/protocols.md` and the matching diagram (`diagrams/03`, `04`, `09`, `10` or `14`), then validate the
  Mermaid (`hopline-docs-diagrams` skill).
- Run the `hopline-check` skill.
