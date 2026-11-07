import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];
const LOG_FORMATS = ['pretty', 'json'];

class ConfigError extends Error {
  constructor(name, value, expected) {
    super(`Invalid value for ${name}: "${value}" (expected ${expected})`);
    this.name = 'ConfigError';
  }
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(name, raw, `an integer between ${min} and ${max}`);
  }
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(name, raw, 'true or false');
}

function readEnum(env, name, fallback, allowed) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) throw new ConfigError(name, raw, `one of ${allowed.join(', ')}`);
  return raw;
}

/**
 * TRUST_PROXY: how many reverse proxies sit in front of the server (each appends to X-Forwarded-For).
 * "false"/0 = none (use the socket address), "true" = 1, or a number for chains like CDN → load balancer.
 */
function readTrustProxy(env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 0;
  if (/^(true|yes|on)$/i.test(raw)) return 1;
  if (/^(false|no|off)$/i.test(raw)) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new ConfigError('TRUST_PROXY', raw, 'true, false, or the number of trusted proxies (0-10)');
  }
  return hops;
}

function readList(env, name) {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads and validates all server settings from environment variables.
 * See `.env.example` at the repository root for documentation of each one.
 */
const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function readUrlList(env, name, schemes, fallback = []) {
  const list = readList(env, name);
  for (const url of list) {
    if (!schemes.some((scheme) => url.startsWith(`${scheme}:`))) {
      throw new ConfigError(name, url, `URLs starting with ${schemes.map((s) => `${s}:`).join(' or ')}`);
    }
  }
  return list.length > 0 ? list : fallback;
}

function readTurn(env) {
  const urls = readUrlList(env, 'TURN_URLS', ['turn', 'turns']);
  const secret = env.TURN_SECRET || '';
  const username = env.TURN_USERNAME || '';
  const credential = env.TURN_CREDENTIAL || '';
  if (urls.length > 0 && !secret && !(username && credential)) {
    throw new ConfigError(
      'TURN_URLS',
      urls.join(','),
      'TURN_SECRET (recommended) or TURN_USERNAME + TURN_CREDENTIAL to be set as well',
    );
  }
  if (secret && secret.length < 16)
    throw new ConfigError('TURN_SECRET', '<hidden>', 'at least 16 characters');
  return Object.freeze({
    urls,
    secret,
    username,
    credential,
    // Long enough for a multi-hour transfer: TURN servers re-check credentials on every allocation refresh.
    ttlSeconds: readInt(env, 'TURN_TTL_SECONDS', 12 * 3600, { min: 300, max: 7 * 24 * 3600 }),
  });
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return Object.freeze({
    stunUrls: readUrlList(env, 'STUN_URLS', ['stun', 'stuns'], DEFAULT_STUN_URLS),
    turn: readTurn(env),
    reconnectGraceMs: readInt(env, 'RECONNECT_GRACE_SECONDS', 120, { min: 5, max: 3600 }) * 1000,
    port: readInt(env, 'PORT', 8787, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    serveWeb: readBool(env, 'SERVE_WEB', true),
    webDist: resolve(env.WEB_DIST || DEFAULT_WEB_DIST),
    trustedProxyHops: readTrustProxy(env),
    allowedOrigins: readList(env, 'ALLOWED_ORIGINS'),
    roomTtlMs: readInt(env, 'ROOM_TTL_MINUTES', 30, { min: 1 }) * 60_000,
    heartbeatMs: readInt(env, 'HEARTBEAT_SECONDS', 30, { min: 5 }) * 1000,
    maxConnections: readInt(env, 'MAX_CONNECTIONS', 5000, { min: 1 }),
    maxConnectionsPerIp: readInt(env, 'MAX_CONNECTIONS_PER_IP', 20, { min: 1 }),
    /** Wrong room codes / rejoin tokens allowed per client per minute (stops code guessing). */
    joinAttemptsPerMinute: readInt(env, 'JOIN_ATTEMPTS_PER_MINUTE', 10, { min: 1 }),
    /** Sockets that never create or join a room are closed after this long. */
    unjoinedTimeoutMs: readInt(env, 'UNJOINED_TIMEOUT_SECONDS', 120, { min: 10 }) * 1000,
    healthDetails: readBool(env, 'HEALTH_DETAILS', false),
    rateLimit: Object.freeze({
      messagesPerSecond: readInt(env, 'RATE_LIMIT_PER_SECOND', 20, { min: 1 }),
      burst: readInt(env, 'RATE_LIMIT_BURST', 120, { min: 1 }),
    }),
    logLevel: readEnum(env, 'LOG_LEVEL', 'info', LOG_LEVELS),
    logFormat: readEnum(env, 'LOG_FORMAT', production ? 'json' : 'pretty', LOG_FORMATS),
  });
}
