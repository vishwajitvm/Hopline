import { networkInterfaces } from 'node:os';

const ipToInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
const intToIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** Non-loopback IPv4 interfaces (what other machines on the LAN can reach). */
export function lanInterfaces() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal);
}

export function lanAddresses() {
  return lanInterfaces().map((iface) => iface.address);
}

/** Directed broadcast address for each interface, plus the global broadcast and loopback (same-machine testing). */
export function broadcastAddresses() {
  const targets = new Set(['255.255.255.255', '127.0.0.1']);
  for (const { address, netmask } of lanInterfaces()) {
    const ip = ipToInt(address);
    const mask = ipToInt(netmask);
    const hostBits = 2 ** 32 - 1 - mask;
    targets.add(intToIp(ip - (ip % (hostBits + 1)) + hostBits));
  }
  return [...targets];
}

/** Parses "host:port" (IPv4 or hostname). */
export function parseHostPort(value) {
  const index = value.lastIndexOf(':');
  const host = index > 0 ? value.slice(0, index) : '';
  const port = Number(value.slice(index + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`"${value}" isn't a valid address. Use the form 192.168.1.20:53211.`);
  }
  return { host, port };
}
