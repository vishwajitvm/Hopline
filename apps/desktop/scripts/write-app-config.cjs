#!/usr/bin/env node
/**
 * Writes app-config.json, which electron-builder ships inside the installed app (resources/app-config.json).
 * It holds the signaling server the downloadable app uses by default, taken from HOPLINE_SIGNALING_URL at
 * build time (in CI: the repository variable of the same name). Users can still override it locally (see
 * src/config.cjs).
 */
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.HOPLINE_SIGNALING_URL || '';
if (url && !/^wss?:\/\//.test(url)) {
  console.error(`HOPLINE_SIGNALING_URL must start with ws:// or wss:// (got "${url}")`);
  process.exit(1);
}
const file = path.join(__dirname, '..', 'app-config.json');
fs.writeFileSync(file, `${JSON.stringify({ signalingUrl: url || null }, null, 2)}\n`);
console.log(
  url ? `Bundled signaling server: ${url}` : 'No bundled signaling server (users set one in settings.json).',
);
