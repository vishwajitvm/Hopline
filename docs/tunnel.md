# Public URL with a tunnel (any device, any network)

Want to try Hopline from your phone on mobile data, or send a link to a friend, without deploying? Run:

```bash
npm run tunnel
```

It starts the Docker stack plus a **Cloudflare quick tunnel** and prints an address like
`https://block-association-recommendation-mailman.trycloudflare.com`. Open it on any device, anywhere.

|                |                                                                                         |
| -------------- | --------------------------------------------------------------------------------------- |
| Cost / account | Free, no account                                                                        |
| What's exposed | Only the `web` container (the UI and `/ws` signaling). Nothing else on your computer    |
| HTTPS          | Yes, so phones get disk storage, "Save to a folder" (where supported) and the clipboard |
| Address        | Random, and **changes every time the tunnel restarts**                                  |
| Stop it        | `npm run tunnel -- stop` (or `docker compose stop tunnel`)                              |

Without npm: `docker compose --profile tunnel up -d`, then `docker compose logs tunnel` and look for the
`trycloudflare.com` line.

## Things to know

- **Your computer must stay on**: the tunnel serves the app from your machine.
- **Files still go device to device.** The tunnel only carries the web page and the small signaling messages.
  Two devices on different networks connect directly when the networks allow it. If one side is behind strict NAT
  (common on mobile data), you also need a **TURN relay** ([turn.md](turn.md)); a tunnel can't carry that UDP
  traffic.
- **Shared limits**: everyone arriving through the tunnel looks like one client to the server, so the per-client
  limits (20 connections, 10 wrong room codes per minute) are shared. That's fine for personal use; for a public
  service deploy properly ([deployment.md](deployment.md)).
- **Anyone with the link can open the app.** They still need a room code to reach you, and every connection is
  end-to-end encrypted. Stop the tunnel when you're done.
- Quick tunnels are meant for testing and personal use. For a permanent address, deploy to Render or use a named
  Cloudflare tunnel on your own domain.
