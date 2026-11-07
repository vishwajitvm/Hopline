// Makes sure the Electron binary is present before the app starts.
// Some npm setups skip dependency install scripts, which leaves the `electron` package without its binary.
// Downloading lazily here also means people who only use the web app or CLI never fetch ~100 MB of Electron.
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

function binaryPresent() {
  try {
    return existsSync(require('electron')); // resolves to the binary path, throws if it was never downloaded
  } catch {
    return false;
  }
}

if (!binaryPresent()) {
  console.log('Downloading Electron (first run only)…');
  const installer = join(dirname(require.resolve('electron/package.json')), 'install.js');
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
  if (result.status !== 0 || !binaryPresent()) {
    console.error('Could not download Electron. Check your internet connection and try again.');
    process.exit(1);
  }
}
