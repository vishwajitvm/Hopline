import dgram from 'node:dgram';
import { broadcastAddresses } from '../utils/network.js';

export const DISCOVERY_PORT = Number(process.env.HOPLINE_DISCOVERY_PORT) || 41899;
const ANNOUNCE_INTERVAL_MS = 1000;
const APP_ID = 'hopline';

/**
 * Sender side: broadcasts "{nameplate} is waiting on TCP port {port}" on every local network once a second.
 * Only the nameplate (the number in the code) is broadcast — never the secret words.
 * Returns a function that stops announcing.
 */
export function announce({ nameplate, port }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const message = Buffer.from(JSON.stringify({ app: APP_ID, v: 1, nameplate, port }));
  let timer = null;
  let stopped = false;

  socket.on('error', () => {}); // a network going away mid-transfer shouldn't crash the sender
  socket.bind(0, () => {
    if (stopped) return;
    socket.setBroadcast(true);
    const tick = () => {
      for (const address of broadcastAddresses()) socket.send(message, DISCOVERY_PORT, address, () => {});
    };
    tick();
    timer = setInterval(tick, ANNOUNCE_INTERVAL_MS);
  });

  return function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
}

/**
 * Receiver side: listens for a sender announcing `nameplate`.
 * `exclude` holds "host:port" senders already tried (e.g. another transfer that happens to share the number).
 */
export function discoverSender(nameplate, { timeoutMs = 60_000, exclude = new Set() } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = (err, result) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `No sender with code ${nameplate}-… found on this network after ${Math.round(timeoutMs / 1000)}s.\n` +
              '  • Check both computers are on the same network and the code is right.\n' +
              '  • Or connect directly with --host <ip:port> (the sender prints it).',
          ),
        ),
      timeoutMs,
    );

    socket.on('error', (err) => finish(new Error(`Network discovery failed: ${err.message}`)));
    socket.on('message', (buffer, remote) => {
      let message;
      try {
        message = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }
      const validPort = Number.isInteger(message?.port) && message.port >= 1 && message.port <= 65535;
      if (message?.app !== APP_ID || message.nameplate !== nameplate || !validPort) return;
      if (exclude.has(`${remote.address}:${message.port}`)) return;
      finish(null, { host: remote.address, port: message.port });
    });

    socket.bind(DISCOVERY_PORT);
  });
}
