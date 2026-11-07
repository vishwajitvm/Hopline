# TURN relay: connecting across countries and strict networks

> Diagram: [15-relay-and-ssrf-guard.mmd](../diagrams/15-relay-and-ssrf-guard.mmd)

Hopline first tries a **direct** connection between the two devices (with STUN's help to get through home
routers). That works for most home Wi-Fi. It often fails when:

- one side is on **mobile data** or carrier-grade NAT (common in India, e.g. Jio/Airtel, and on many mobile
  networks worldwide);
- one side is on a **corporate or university network** that blocks peer-to-peer traffic;
- you ticked **Hide my IP address** (that forces the relay on purpose).

In those cases a **TURN relay** forwards the traffic. The data stays **end-to-end encrypted** (WebRTC DTLS):
the relay only ever sees ciphertext. The app shows **Direct** or **Relayed** next to the room code.

> Sending 5 GB from New Delhi to the US? Set up a relay. It's the difference between "always connects" and "connects
> only if both networks happen to allow it".

## How credentials work

You never put TURN passwords into the web app. The signaling server holds a **shared secret** and hands each
device a fresh, **short-lived** credential (`TURN_TTL_SECONDS`, default 12 h). It does that only once two
devices are actually paired in a room, so random visitors can't collect relay credentials.

```
username   = "<expiry-unix-time>:<random>"
credential = base64(HMAC-SHA1(TURN_SECRET, username))      ← coturn's "use-auth-secret" scheme
```

## Option A: run your own coturn (included)

You need a machine with a **public IP address** (any small VPS). A free Render web service can't host it,
because TURN needs UDP ports.

1. Open these ports in the firewall: **3478/udp**, **3478/tcp**, and **49160–49360/udp** (the relay range, set
   with `TURN_MIN_PORT`/`TURN_MAX_PORT`).
2. Set these in `.env` on that machine:

   ```ini
   TURN_SECRET=<long random string — node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
   TURN_EXTERNAL_IP=<the machine's public IP>
   TURN_URLS=turn:<public IP or domain>:3478,turn:<public IP or domain>:3478?transport=tcp
   ```

3. Start everything, including the relay:

   ```bash
   docker compose --profile turn up --build -d
   ```

4. If the signaling server runs **elsewhere** (e.g. on Render), set the same `TURN_URLS` and `TURN_SECRET` in
   that server's environment instead. No rebuild is needed; they're read at runtime.

### Hardening built into `infra/turn`

| Protection                                                                               | Why                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refuses to start without a strong `TURN_SECRET` (≥ 16 chars)                             | With an empty secret anyone could mint credentials                                                                                                                       |
| Shared-secret auth only, credentials expire                                              | A leaked credential stops working by itself                                                                                                                              |
| `--no-tcp-relay`                                                                         | The relay can't be used as a generic TCP proxy                                                                                                                           |
| Denies relaying to private, loopback, link-local, CGNAT, IPv4-mapped and NAT64 ranges    | Stops SSRF: nobody can use your relay to reach machines inside your network (or a cloud metadata service)                                                                |
| Per-user (32) and total (1,200) allocation quotas; optional `TURN_MAX_BPS` bandwidth cap | Limits abuse and cost. 32 per credential leaves room for up to 4 peer connections per device (main + 3 lanes), each gathering several relay allocations, plus reconnects |
| Non-root, read-only filesystem, Alpine packages patched at build                         | Smaller blast radius                                                                                                                                                     |

The VAPT suite checks all of this against a live relay (see [security/vapt-report.md](security/vapt-report.md)).

### Testing on a LAN

The default rules block private addresses, which also blocks two test devices on the same home network from
relaying to each other. **For local testing only**, allow your LAN range:

```ini
TURN_EXTRA_ARGS=--allowed-peer-ip=192.168.0.0-192.168.255.255
```

Remove it in production.

## Option B: a managed TURN provider

Many providers sell TURN with a fixed username/password. Configure the server (not the web build):

```ini
TURN_URLS=turn:relay.example.com:443?transport=tcp,turns:relay.example.com:443
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Leave `TURN_SECRET` empty in that case. Fixed credentials are handed to paired devices only, but they don't
expire, so prefer a provider that supports the shared-secret scheme (then use `TURN_SECRET`).

## Cost and speed

- Relayed traffic counts against the relay's bandwidth: a 5 GB transfer costs about 5 GB in and 5 GB out on that
  machine.
- Put the relay close to one of the users, or between them. For India ↔ US, a European or US-east region is a
  reasonable middle.
- Each device opens up to 4 peer connections (the main one plus 3 lanes, see
  [protocols.md](protocols.md#channels-and-lanes)). Through a relay they all use the same credential, which is why
  coturn's `--user-quota` is 32, not the older 12. Lanes don't add traffic: they split the same bytes.
- Direct connections are always tried first; the relay only carries traffic when needed (or when you choose
  "Hide my IP address").
