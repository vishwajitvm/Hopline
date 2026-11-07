---
name: hopline-tunnel
description: Give the user a public HTTPS URL for their local Hopline (Cloudflare quick tunnel) so they can use it from a phone or any network, and verify it works end to end. Use when asked for a tunnel, public link, share URL, or to use Hopline on mobile/another network without deploying.
---

# Public URL via Cloudflare quick tunnel

1. Start it: `npm run tunnel` (builds/starts the stack, starts the `tunnel` Compose service, prints the URL).
   Without npm: `docker compose --profile tunnel up -d tunnel`, then read `docker compose logs tunnel` for the
   `https://<words>.trycloudflare.com` line (poll for up to ~90 s).
2. Verify from the outside before handing it over:
   - `GET <url>/health` → 200 `{"status":"ok"…}` (DNS can take a few seconds; retry).
   - Open `<url>` in the browser pane, click **Create a room**: a room code must appear (this proves the WebSocket
     and the same-origin check work through the tunnel). Optionally join from a second tab via `<url>/?code=XXXX`
     and confirm both show **Connected** and the same safety code.
3. Tell the user:
   - the URL, and that it changes on every tunnel restart;
   - their computer must stay on;
   - files still travel device to device: across strict networks (mobile CGNAT) they may also need a TURN relay
     (`docs/turn.md`), which a tunnel can't carry;
   - everyone via the tunnel shares one client's rate limits;
   - stop it with `npm run tunnel -- stop`.

Publishing a local service is outward-facing: only start a tunnel when the user asked for one.
