import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { loadEnvFile } from './load-env.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function lanUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => `http://${iface.address}:${port}`);
}

async function main() {
  let config;
  let envFile = null;
  try {
    envFile = loadEnvFile();
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const app = createApp({ config, logger });
  const port = await app.listen();

  logger.info('Hopline server started', {
    port,
    local: `http://localhost:${port}`,
    network: lanUrls(port),
    servingWeb: config.serveWeb,
    turnRelay: config.turn.urls.length > 0,
    envFile: envFile ?? 'none',
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
