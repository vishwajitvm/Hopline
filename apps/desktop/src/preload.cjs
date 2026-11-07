const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Runs in the sandboxed preload context. Exposes read-only settings and a narrow Direct-mode API — no Node
// or Electron objects reach the page.
const settings = ipcRenderer.sendSync('hopline:get-config');

const CHANNEL = 'hopline:direct:';
const invoke = (name, ...args) => ipcRenderer.invoke(`${CHANNEL}${name}`, ...args);

/**
 * Direct mode (desktop ↔ desktop over TCP). The page never handles file paths: files to send become opaque
 * tokens here, from real File objects the user picked; received files go to folders by folder id.
 */
const direct = Object.freeze({
  /** A token for a File the user picked (null if it has no path on disk, e.g. built in memory). */
  async fileToken(file) {
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      path = '';
    }
    return path ? invoke('register-path', path) : null;
  },
  listen: () => invoke('listen'),
  expect: (options) => invoke('expect', options),
  connect: (info) => invoke('connect', info),
  send: (options) => invoke('send', options),
  cancel: (id) => invoke('cancel', id),
  chooseFolder: () => invoke('choose-folder'),
  defaultFolder: () => invoke('default-folder'),
  openFile: (options) => invoke('open-file', options),
  writeFile: (handle, bytes) => invoke('write-file', handle, bytes),
  commitFile: (handle) => invoke('commit-file', handle),
  abortFile: (handle) => invoke('abort-file', handle),
  showItem: (folderId, savedAs) => invoke('show-item', folderId, savedAs),
  reset: () => invoke('reset'),
  /** Subscribes to engine events; returns an unsubscribe function. */
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(`${CHANNEL}event`, wrapped);
    return () => ipcRenderer.off(`${CHANNEL}event`, wrapped);
  },
});

contextBridge.exposeInMainWorld(
  'hopline',
  Object.freeze({
    isDesktop: true,
    signalingUrl: settings.signalingUrl,
    direct,
  }),
);
