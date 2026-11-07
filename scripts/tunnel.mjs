#!/usr/bin/env node
/**
 * Starts the Docker stack plus a Cloudflare quick tunnel and prints the public HTTPS URL.
 *   npm run tunnel          start (or reuse) and print the URL
 *   npm run tunnel -- stop  stop the tunnel (the rest of the stack keeps running)
 */
import { execFileSync, spawnSync } from 'node:child_process';

const compose = (...args) =>
  spawnSync('docker', ['compose', '--profile', 'tunnel', ...args], { encoding: 'utf8' });

if (process.argv[2] === 'stop') {
  compose('stop', 'tunnel');
  console.log('Tunnel stopped. The public URL no longer works.');
  process.exit(0);
}

console.log('Starting Hopline and the tunnel (first run builds the images)…');
const up = compose('up', '-d', '--build', 'tunnel');
if (up.status !== 0) {
  console.error(up.stderr || up.stdout);
  process.exit(1);
}

const deadline = Date.now() + 90_000;
let url = null;
while (!url && Date.now() < deadline) {
  const logs = compose('logs', 'tunnel');
  const matches = `${logs.stdout}${logs.stderr}`.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  url = matches?.at(-1) ?? null;
  if (!url) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
}

if (!url) {
  console.error('No tunnel URL yet. Check: docker compose logs tunnel');
  process.exit(1);
}

console.log(`
  Hopline is online at:

    ${url}

  Open it on any device, on any network (phone on mobile data, laptop elsewhere…).
  The address changes every time the tunnel restarts. Stop it with: npm run tunnel -- stop
`);
