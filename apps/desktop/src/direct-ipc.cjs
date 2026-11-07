const { dialog, ipcMain, shell } = require('electron');

/**
 * IPC bridge between the renderer and the Direct-mode engine (src/direct/service.js, an ES module).
 * Every handler checks that the request comes from this window's own page; the engine itself treats all
 * arguments as untrusted (tokens and folder ids instead of paths, validated ids and sizes).
 */
const CHANNEL = 'hopline:direct:';

async function attachDirect(window, { isAppUrl, downloadsDir }) {
  const { DirectService } = await import('./direct/service.js');
  const service = new DirectService({ downloadsDir });
  const contents = window.webContents;

  service.on('event', (event) => {
    if (!contents.isDestroyed()) contents.send(`${CHANNEL}event`, event);
  });
  // A reload or navigation starts a fresh page: drop its links, listeners and half-written files.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void service.reset();
  });
  contents.on('render-process-gone', () => void service.reset());
  window.on('closed', () => void service.reset());

  const handlers = {
    listen: () => service.listen(),
    expect: (options) => service.expect(options),
    connect: (info) => service.connect(info),
    send: (options) => service.send(options),
    cancel: (id) => service.cancel(id),
    'register-path': (path) => service.registerPath(path),
    'default-folder': () => service.defaultFolder(),
    'choose-folder': async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Save received files to…',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return service.registerFolder(result.filePaths[0]);
    },
    'open-file': (options) => service.openFile(options),
    'write-file': (handle, bytes) => service.writeFile(handle, bytes),
    'commit-file': (handle) => service.commitFile(handle),
    'abort-file': (handle) => service.abortFile(handle),
    'show-item': (folderId, savedAs) => {
      const path = service.savedPath(folderId, savedAs);
      if (path) shell.showItemInFolder(path);
    },
    reset: () => service.reset(),
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${CHANNEL}${name}`, (event, ...args) => {
      if (event.sender !== contents || !isAppUrl(event.senderFrame?.url ?? '')) {
        throw new Error('Refused: not the Hopline page.');
      }
      return handler(...args);
    });
  }
  window.on('closed', () => {
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`${CHANNEL}${name}`);
  });
}

module.exports = { attachDirect };
