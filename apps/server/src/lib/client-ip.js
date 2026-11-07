import { isIP, isIPv4, isIPv6 } from 'node:net';

/** "::ffff:1.2.3.4" (IPv4-mapped IPv6, common on dual-stack sockets) → "1.2.3.4". */
export function normalizeIp(ip) {
  const value = String(ip ?? '').trim();
  if (value.toLowerCase().startsWith('::ffff:') && isIPv4(value.slice(7))) return value.slice(7);
  return value || 'unknown';
}

function expandIPv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((g) =>
    g.padStart(4, '0').toLowerCase(),
  );
}

/**
 * The key used for per-client limits. IPv6 users usually control a whole /64, so limits apply per /64
 * (otherwise one home connection could rotate through billions of addresses).
 */
export function limitKey(ip) {
  const address = ip.split('%')[0]; // drop IPv6 zone id
  if (isIPv6(address)) return `${expandIPv6(address).slice(0, 4).join(':')}::/64`;
  return address;
}

/**
 * The client's address. Behind `trustedHops` reverse proxies, each proxy appends the address it saw to
 * X-Forwarded-For, so the real client is the entry `trustedHops` from the right. Entries further left are
 * whatever the client claimed and are ignored — trusting the left-most entry would let anyone spoof it.
 */
export function clientIp(req, trustedHops) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  if (!trustedHops) return socketIp;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.length > 2048) return socketIp;
  const chain = header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  const candidate = normalizeIp(chain[Math.max(0, chain.length - trustedHops)]);
  return isIP(candidate) ? candidate : socketIp;
}
