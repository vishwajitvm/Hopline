const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const config = require('./config.cjs');
const { attachDirect } = require('./direct-ipc.cjs');

const APP_INDEX_URL = pathToFileURL(config.webIndexPath).href;

// Must happen before 'ready': a separate profile lets two instances run side by side.
if (config.profileDir) app.setPath('userData', config.profileDir);

/** True only for the app's own page — compared by exact origin/path, never by string prefix. */
function isAppUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (config.devServerUrl) return url.origin === new URL(config.devServerUrl).origin;
  url.hash = '';
  url.search = '';
  return url.href === APP_INDEX_URL;
}

const CONFIG_CHANNEL = 'hopline:get-config';

const MISSING_BUILD_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <body style="font-family:system-ui;padding:40px;line-height:1.5">
    <h2>Hopline web build not found</h2>
    <p>Run <code>npm run desktop</code> from the repository root (it builds the web app first),
    or <code>npm run desktop:dev</code> while <code>npm run dev</code> is running.</p>
  </body>`)}`;

function createWindow() {
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: 'Hopline',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Direct mode: native TCP transfers between two desktop apps (see src/direct/).
  attachDirect(window, { isAppUrl, downloadsDir: config.downloadsDir || app.getPath('downloads') }).catch(
    (err) => console.error('[hopline] Direct mode unavailable:', err),
  );

  // External links open in the user's browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigation is pinned to the app itself: the exact dev-server origin, or the exact built index.html.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (config.devServerUrl) window.loadURL(config.devServerUrl);
  else if (fs.existsSync(config.webIndexPath)) window.loadFile(config.webIndexPath);
  else window.loadURL(MISSING_BUILD_PAGE);
}

// The renderer asks for its settings synchronously at startup via the preload script.
ipcMain.on(CONFIG_CHANNEL, (event) => {
  event.returnValue = { signalingUrl: config.signalingUrl() };
});

// No embedded <webview>s, ever.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  // Hopline needs no camera, microphone, location, notifications… deny every permission request.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
