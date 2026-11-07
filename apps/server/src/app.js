import http from 'node:http';
import { HSTS_HEADER, SECURITY_HEADERS, isHttps } from './http/security-headers.js';
import { createStaticHandler } from './http/static-files.js';
import { SignalingService } from './signaling/signaling-service.js';

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

/**
 * Wires the HTTP server (health check + optional static web app) and the signaling service.
 * Kept free of process-level concerns (env, signals) so tests can create isolated instances.
 */
export function createApp({ config, logger }) {
  const serveStatic = config.serveWeb ? createStaticHandler(config.webDist) : null;

  // `signaling` is declared below; the handler only runs after listen(), by which point it exists.
  const httpServer = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (isHttps(req, config.trustedProxyHops)) res.setHeader(...HSTS_HEADER);
    try {
      if (!ALLOWED_METHODS.has(req.method)) {
        res.setHeader('allow', 'GET, HEAD');
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/health') {
        // Room/peer counts are only exposed when explicitly enabled (they reveal usage).
        const details = config.healthDetails ? signaling.stats : {};
        return sendJson(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), ...details });
      }
      if (serveStatic && (await serveStatic(req, res))) return;
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Hopline signaling server is running. WebSocket endpoint: /ws\n');
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('request failed', { url: req.url, err });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
    }
  });

  // Bound slow-loris style abuse: headers must arrive quickly, idle keep-alive sockets close.
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  const signaling = new SignalingService({ httpServer, config, logger });

  return {
    httpServer,
    signaling,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address().port);
        });
      });
    },
    async close() {
      await signaling.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
