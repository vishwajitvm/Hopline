import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function fileInfo(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built web app (single-page app) from `rootDir`.
 * Hashed files under /assets are cached forever; everything else falls back to index.html.
 * Returns `false` when there is no build to serve, so the caller can respond differently.
 */
export function createStaticHandler(rootDir) {
  const root = resolve(rootDir);
  const indexPath = join(root, 'index.html');

  return async function serveStatic(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return true;
    }

    let filePath = resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return true;
    }

    let info = await fileInfo(filePath);
    if (!info) {
      filePath = indexPath;
      info = await fileInfo(filePath);
      if (!info) return false;
    }

    const immutable = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      const stream = createReadStream(filePath);
      stream.on('error', () => res.destroy()); // e.g. the file vanished between stat and read
      stream.pipe(res);
    }
    return true;
  };
}
