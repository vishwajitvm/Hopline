const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const packaged = app.isPackaged;

// From source: the repository's .env. Variables already set in the environment win.
const ROOT_ENV_FILE = path.join(__dirname, '..', '..', '..', '.env');
if (!packaged && typeof process.loadEnvFile === 'function' && fs.existsSync(ROOT_ENV_FILE)) {
  process.loadEnvFile(ROOT_ENV_FILE);
}

/**
 * Desktop settings.
 *
 * Signaling server, first match wins:
 *   1. HOPLINE_SIGNALING_URL environment variable
 *   2. "signalingUrl" in settings.json in the app's data folder (users can point the app at their own server)
 *   3. the URL baked in at build time (resources/app-config.json, from HOPLINE_SIGNALING_URL in CI)
 *   4. ws://localhost:8787/ws (local development / Docker)
 *
 * Development and testing:
 *   HOPLINE_WEB_URL        Load the UI from a URL instead of the built files (live reload)
 *   HOPLINE_PROFILE_DIR    Separate app profile (run two instances side by side, e.g. to test Direct mode)
 *   HOPLINE_DOWNLOADS_DIR  Where "Accept" saves files (default: the system Downloads folder)
 */
const DEFAULT_SIGNALING_URL = 'ws://localhost:8787/ws';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function validSignalingUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Resolved when asked (after the profile folder is final), so settings.json is read from the right place. */
function signalingUrl() {
  const fromEnv = process.env.HOPLINE_SIGNALING_URL;
  if (fromEnv) {
    const url = validSignalingUrl(fromEnv);
    if (!url) throw new Error(`HOPLINE_SIGNALING_URL must start with ws:// or wss:// (got "${fromEnv}")`);
    return url;
  }
  const fromSettings = validSignalingUrl(
    readJson(path.join(app.getPath('userData'), 'settings.json')).signalingUrl,
  );
  if (fromSettings) return fromSettings;
  const bundled = packaged
    ? readJson(path.join(process.resourcesPath, 'app-config.json')).signalingUrl
    : null;
  return validSignalingUrl(bundled) ?? DEFAULT_SIGNALING_URL;
}

module.exports = Object.freeze({
  packaged,
  signalingUrl,
  devServerUrl: packaged ? null : process.env.HOPLINE_WEB_URL || null,
  profileDir: process.env.HOPLINE_PROFILE_DIR || null,
  downloadsDir: process.env.HOPLINE_DOWNLOADS_DIR || null,
  webIndexPath: packaged
    ? path.join(process.resourcesPath, 'web', 'index.html')
    : path.join(__dirname, '..', '..', 'web', 'dist', 'index.html'),
  preloadPath: path.join(__dirname, 'preload.cjs'),
});
