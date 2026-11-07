#!/usr/bin/env node
/**
 * Hopline active security test suite (the "PT" in VAPT).
 *
 * Attacks a RUNNING deployment and reports PASS/FAIL per check. Only run it against systems you own.
 *
 *   docker compose --profile turn up -d          # web (nginx) + server + TURN, see docs/security/vapt-report.md
 *   docker run -d --name hopline-aio -p 8795:8787 hopline:all-in-one
 *   node security/vapt/run.mjs
 *
 * Environment (all optional):
 *   VAPT_WEB=http://localhost:8080      nginx + server stack
 *   VAPT_NODE=http://localhost:8795     all-in-one image (Node serves the UI itself)
 *   VAPT_TURN=127.0.0.1:3478            coturn
 *   (HTTPS targets work too, e.g. VAPT_WEB=https://hopline.onrender.com for a live deployment.)
 *   TURN_SECRET                         read from .env if not set (to mint valid credentials like the server does)
 *   VAPT_PRIVATE_IP=192.168.1.35        a private address the relay must refuse to reach
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
if (existsSync(join(ROOT, '.env')) && typeof process.loadEnvFile === 'function')
  process.loadEnvFile(join(ROOT, '.env'));

const WEB = process.env.VAPT_WEB || 'http://localhost:8080';
const NODE = process.env.VAPT_NODE || 'http://localhost:8795';
const [TURN_HOST, TURN_PORT] = (process.env.VAPT_TURN || '127.0.0.1:3478').split(':');
const TURN_SECRET = process.env.TURN_SECRET || '';
const PRIVATE_IP = process.env.VAPT_PRIVATE_IP || '192.168.1.35';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(area, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ area, name, ok: true, detail: detail ?? '', ms: Date.now() - started });
    console.log(`  PASS  ${area.padEnd(9)} ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    results.push({ area, name, ok: false, detail: err.message, ms: Date.now() - started });
    console.log(`  FAIL  ${area.padEnd(9)} ${name}  → ${err.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function rawRequest(base, { method = 'GET', path = '/', headers = {} } = {}) {
  const { hostname, port, protocol } = new URL(base);
  const lib = protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname, port, method, path, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Sends a request line byte-for-byte (no URL normalisation by the client library). */
function rawPath(base, path) {
  const { hostname, port, protocol } = new URL(base);
  return new Promise((resolve, reject) => {
    const send = () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    const socket =
      protocol === 'https:'
        ? tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname }, send)
        : net.connect(Number(port) || 80, hostname, send);
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: Number(text.split(' ')[1]), body: text });
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
  });
}

// ── WebSocket helpers ─────────────────────────────────────────────────────

function wsUrl(base) {
  return `${base.replace(/^http/, 'ws')}/ws`;
}

function client(base, options = {}) {
  const socket = new WebSocket(wsUrl(base), { handshakeTimeout: 5000, ...options });
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const outcome = new Promise((resolve) => {
    socket.once('open', () => resolve('open'));
    socket.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    socket.once('error', (err) => resolve(`error:${err.message}`));
  });
  return {
    socket,
    inbox,
    outcome,
    closed: new Promise((resolve) => socket.once('close', (code) => resolve(code))),
    send: (msg) => socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(type, timeoutMs = 4000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${type}" within ${timeoutMs} ms`)), timeoutMs);
        waiters.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    close: () => socket.terminate(),
  };
}

const sameOrigin = (base) => ({ origin: base });

// ── TURN client (RFC 5389 / 5766), just enough to probe the relay ─────────

const MAGIC = 0x2112a442;
const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_PEER_ADDRESS: 0x0012,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_RELAYED_ADDRESS: 0x0016,
};

function attribute(type, value) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  const pad = Buffer.alloc((4 - (value.length % 4)) % 4);
  return Buffer.concat([header, value, pad]);
}

function buildMessage(method, attrs, auth) {
  const txid = randomBytes(12);
  let body = Buffer.concat(attrs);
  const header = (len) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(method, 0);
    h.writeUInt16BE(len, 2);
    h.writeUInt32BE(MAGIC, 4);
    txid.copy(h, 8);
    return h;
  };
  if (auth) {
    body = Buffer.concat([
      body,
      attribute(ATTR.USERNAME, Buffer.from(auth.username)),
      attribute(ATTR.REALM, Buffer.from(auth.realm)),
      attribute(ATTR.NONCE, Buffer.from(auth.nonce)),
    ]);
    const key = createHash('md5').update(`${auth.username}:${auth.realm}:${auth.password}`).digest();
    const forMac = Buffer.concat([header(body.length + 24), body]);
    const mac = createHmac('sha1', key).update(forMac).digest();
    body = Buffer.concat([body, attribute(ATTR.MESSAGE_INTEGRITY, mac)]);
  }
  return Buffer.concat([header(body.length), body]);
}

function parseMessage(buf) {
  const type = buf.readUInt16BE(0);
  const attrs = {};
  let offset = 20;
  while (offset + 4 <= buf.length) {
    const t = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    attrs[t] = buf.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len + ((4 - (len % 4)) % 4);
  }
  const error = attrs[ATTR.ERROR_CODE];
  return {
    type,
    success: (type & 0x0110) === 0x0100,
    errorCode: error ? error[2] * 100 + error[3] : null,
    realm: attrs[ATTR.REALM]?.toString(),
    nonce: attrs[ATTR.NONCE]?.toString(),
  };
}

function xorPeerAddress(ip, port) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const octets = ip.split('.').map(Number);
  value.writeUInt32BE(
    (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) ^ MAGIC) >>> 0,
    4,
  );
  return attribute(ATTR.XOR_PEER_ADDRESS, value);
}

function turnSession() {
  const socket = dgram.createSocket('udp4');
  const request = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('no response from TURN server'));
      }, 4000);
      const onMessage = (msg) => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parseMessage(msg));
      };
      socket.on('message', onMessage);
      socket.send(message, Number(TURN_PORT), TURN_HOST);
    });
  return { request, close: () => socket.close() };
}

const transport = (protocol) => attribute(ATTR.REQUESTED_TRANSPORT, Buffer.from([protocol, 0, 0, 0]));

function mintTurnCredentials(secret, ttlSeconds = 600) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:vapt`;
  return { username, password: createHmac('sha1', secret).update(username).digest('base64') };
}

/** Allocates with credentials; returns { session, auth } on success. */
async function allocate(creds, protocol = 17) {
  const session = turnSession();
  const first = await session.request(buildMessage(0x0003, [transport(protocol)]));
  const auth = { ...creds, realm: first.realm, nonce: first.nonce };
  const second = await session.request(buildMessage(0x0003, [transport(protocol)], auth));
  return { session, auth, first, second };
}

// ── Checks ────────────────────────────────────────────────────────────────

async function httpChecks(base, label) {
  const required = {
    'content-security-policy': /frame-ancestors 'none'/,
    'x-content-type-options': /nosniff/,
    'x-frame-options': /DENY/,
    'referrer-policy': /no-referrer/,
    'permissions-policy': /camera=\(\)/,
  };
  for (const path of ['/', '/health', '/does-not-exist']) {
    await check('http', `${label}: security headers on ${path}`, async () => {
      const res = await rawRequest(base, { path });
      for (const [name, pattern] of Object.entries(required)) {
        expect(pattern.test(res.headers[name] ?? ''), `missing/weak ${name}: ${res.headers[name]}`);
      }
      return `status ${res.status}`;
    });
  }

  await check('http', `${label}: assets keep security headers and are immutable`, async () => {
    const index = await rawRequest(base, { path: '/' });
    const asset = /assets\/[^"]+\.js/.exec(index.body)?.[0];
    expect(asset, 'no asset found in index.html');
    const res = await rawRequest(base, { path: `/${asset}` });
    expect(res.status === 200, `status ${res.status}`);
    expect(/immutable/.test(res.headers['cache-control'] ?? ''), 'not immutable');
    expect(res.headers['x-frame-options'] === 'DENY', 'x-frame-options dropped on assets');
  });

  const traversals = [
    '/../../../../etc/passwd',
    '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2f..%2fetc%2fpasswd',
    '/assets/../../../../etc/passwd',
    '/..%5c..%5c..%5cwindows%5cwin.ini',
    '/%252e%252e/%252e%252e/etc/passwd',
    '/....//....//etc/passwd',
    '/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd',
    '/package.json',
    '/../package.json',
    '/.env',
    '/../../.env',
  ];
  await check(
    'http',
    `${label}: path traversal never leaks files (${traversals.length} payloads)`,
    async () => {
      for (const path of traversals) {
        const res = await rawPath(base, path);
        expect(!/root:.*:0:0:|\[fonts\]|"workspaces"|TURN_SECRET/.test(res.body), `leak via ${path}`);
      }
    },
  );

  await check('http', `${label}: only GET/HEAD allowed`, async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'OPTIONS']) {
      const res = await rawRequest(base, { method, path: '/' });
      expect(res.status === 405, `${method} → ${res.status}`);
    }
  });

  await check('http', `${label}: no version disclosure`, async () => {
    const res = await rawRequest(base, { path: '/' });
    expect(!/\d/.test(res.headers.server ?? ''), `server header: ${res.headers.server}`);
    expect(!res.headers['x-powered-by'], 'x-powered-by present');
  });

  await check('http', `${label}: /health reveals no usage numbers`, async () => {
    const res = await rawRequest(base, { path: '/health' });
    const body = JSON.parse(res.body);
    expect(body.status === 'ok' && body.rooms === undefined && body.peers === undefined, res.body);
  });

  await check('http', `${label}: oversized headers are refused, server stays up`, async () => {
    const res = await rawRequest(base, { path: '/', headers: { 'x-big': 'a'.repeat(64 * 1024) } }).catch(
      () => ({ status: 'reset' }),
    );
    expect(res.status === 431 || res.status === 400 || res.status === 'reset', `status ${res.status}`);
    expect((await rawRequest(base, { path: '/health' })).status === 200, 'server down afterwards');
    return `status ${res.status}`;
  });
}

async function websocketChecks(base) {
  await check('ws', 'cross-site WebSocket connections are refused', async () => {
    const c = client(base, { origin: 'https://evil.example' });
    const outcome = await c.outcome;
    c.close();
    expect(outcome === 403, `got ${outcome}`);
  });

  await check('ws', 'same-site connection works', async () => {
    const c = client(base, sameOrigin(base));
    expect((await c.outcome) === 'open', 'not opened');
    c.close();
  });

  await check('ws', 'spoofed X-Forwarded-For cannot bypass the per-client limit', async () => {
    const opened = [];
    let refusedAt = null;
    for (let i = 0; i < 30; i++) {
      const c = client(base, { ...sameOrigin(base), headers: { 'x-forwarded-for': `${i}.${i}.${i}.${i}` } });
      const outcome = await c.outcome;
      if (outcome === 'open') opened.push(c);
      else {
        refusedAt = i;
        break;
      }
    }
    opened.forEach((c) => c.close());
    // The server must forget these sockets before the next checks, or they'd be refused by the very limit
    // this one just filled. Locally that's instant; behind a hosting proxy (e.g. Render's) closes reach the
    // server 10-25 s later, so remote (HTTPS) targets get a longer pause.
    await Promise.all(opened.map((c) => Promise.race([c.closed, sleep(5000)])));
    await sleep(base.startsWith('https:') ? 30_000 : 1000);
    expect(refusedAt !== null, `opened ${opened.length} sockets with forged addresses`);
    expect(refusedAt >= 10, `legitimate connections refused too early (after ${refusedAt})`);
    expect(refusedAt <= 20, `limit bypassed: ${refusedAt} sockets opened`);
    return `refused after ${refusedAt} — all forged addresses counted as one client`;
  });

  await check('ws', 'oversized messages close the socket (1009)', async () => {
    const c = client(base, sameOrigin(base));
    await c.outcome;
    c.send({ type: 'signal', data: { x: 'a'.repeat(70 * 1024) } });
    // Behind a hosting proxy (e.g. Render's) the server's 1009 arrives as a plain 1006 drop, ~12 s later.
    const remote = base.startsWith('https:');
    const code = await Promise.race([c.closed, sleep(remote ? 30_000 : 4000).then(() => 'still open')]);
    expect(code === 1009 || (remote && code === 1006), `close code ${code}`);
    return code === 1009 ? 'closed with 1009' : 'dropped (1006 through the hosting proxy)';
  });

  await check('ws', 'message floods are rate-limited and the server stays healthy', async () => {
    const c = client(base, sameOrigin(base));
    await c.outcome;
    for (let i = 0; i < 300; i++) c.send({ type: 'ping' });
    await sleep(500);
    const limited = c.inbox.filter((m) => m.reason === 'rate-limited').length;
    c.close();
    expect(limited > 100, `only ${limited} rate-limit errors`);
    expect((await rawRequest(base, { path: '/health' })).status === 200, 'server unhealthy');
    return `${limited} messages refused`;
  });

  await check('ws', 'malformed and prototype-pollution payloads are rejected', async () => {
    const c = client(base, sameOrigin(base));
    await c.outcome;
    const payloads = [
      'not json',
      'null',
      '[]',
      '{"type":"__proto__"}',
      '{"type":"constructor"}',
      '{"__proto__":{"type":"create"}}',
      '{"type":"join","code":{"$ne":""}}',
      '{"type":"rejoin","code":"AAAAAA","token":{"length":32}}',
    ];
    for (const p of payloads) c.send(p);
    await sleep(500);
    const created = c.inbox.some((m) => m.type === 'created');
    c.close();
    expect(!created, 'a polluted object was treated as "create"');
    expect((await rawRequest(base, { path: '/health' })).status === 200, 'server unhealthy');
  });

  await check('ws', 'relay credentials are only issued to paired devices', async () => {
    const host = client(base, sameOrigin(base));
    await host.outcome;
    host.send({ type: 'create' });
    const created = await host.next('created');
    host.close();
    expect(!created.iceServers.some((s) => s.credential), 'TURN credentials given to an unpaired client');
  });

  await check('ws', 'room isolation: a third device gets nothing; forged rejoin tokens fail', async () => {
    const host = client(base, sameOrigin(base));
    const guest = client(base, sameOrigin(base));
    const intruder = client(base, sameOrigin(base));
    await Promise.all([host.outcome, guest.outcome, intruder.outcome]);
    host.send({ type: 'create' });
    const { code } = await host.next('created');
    guest.send({ type: 'join', code });
    await guest.next('joined');
    intruder.send({ type: 'join', code });
    const err = await intruder.next('error');
    intruder.send({ type: 'rejoin', code, token: randomBytes(24).toString('base64url') });
    const rejoin = await intruder.next('error');
    host.send({ type: 'signal', data: { secret: 1 } });
    await guest.next('signal');
    await sleep(200);
    const leaked = intruder.inbox.some((m) => m.type === 'signal');
    for (const c of [host, guest, intruder]) c.close();
    expect(err.reason === 'room-full', err.reason);
    expect(rejoin.reason === 'rejoin-failed', rejoin.reason);
    expect(!leaked, 'intruder received a signal');
  });
  // Last: it deliberately exhausts this client's wrong-code budget.
  await check('ws', 'room-code brute force is throttled', async () => {
    const c = client(base, sameOrigin(base));
    await c.outcome;
    let limitedAfter = null;
    for (let i = 0; i < 25; i++) {
      c.send({ type: 'join', code: 'ZZZZZZ' });
      const error = await c.next('error');
      if (error.reason === 'rate-limited') {
        limitedAfter = i;
        break;
      }
    }
    c.close();
    expect(limitedAfter !== null && limitedAfter <= 10, 'never rate-limited');
    return `limited after ${limitedAfter} guesses`;
  });
}

async function turnChecks() {
  await check('turn', 'unauthenticated allocation is refused (no open relay)', async () => {
    const session = turnSession();
    const res = await session.request(buildMessage(0x0003, [transport(17)]));
    session.close();
    expect(!res.success && res.errorCode === 401, `code ${res.errorCode}`);
  });

  await check('turn', 'wrong credentials are refused', async () => {
    const { session, second } = await allocate({
      username: `${Math.floor(Date.now() / 1000) + 600}:x`,
      password: 'wrong',
    });
    session.close();
    expect(!second.success && second.errorCode === 401, `code ${second.errorCode}`);
  });

  await check('turn', 'expired credentials are refused', async () => {
    const username = `${Math.floor(Date.now() / 1000) - 60}:expired`;
    const password = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    const { session, second } = await allocate({ username, password });
    session.close();
    expect(!second.success, 'expired credential accepted');
  });

  await check('turn', 'TCP relaying is disabled', async () => {
    const { session, second } = await allocate(mintTurnCredentials(TURN_SECRET), 6);
    session.close();
    expect(!second.success, 'TCP allocation granted');
    return `code ${second.errorCode}`;
  });

  await check('turn', 'valid short-lived credentials work', async () => {
    const { session, second } = await allocate(mintTurnCredentials(TURN_SECRET));
    session.close();
    expect(second.success, `allocation failed: ${second.errorCode}`);
  });

  const forbidden = [
    PRIVATE_IP,
    '127.0.0.1',
    '10.0.0.1',
    '172.17.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
  ];
  await check(
    'turn',
    `relay refuses private/internal targets (SSRF): ${forbidden.length} addresses`,
    async () => {
      const { session, auth, second } = await allocate(mintTurnCredentials(TURN_SECRET));
      expect(second.success, 'could not allocate');
      for (const ip of forbidden) {
        const res = await session.request(buildMessage(0x0008, [xorPeerAddress(ip, 80)], auth));
        expect(!res.success && res.errorCode === 403, `${ip} → ${res.success ? 'ALLOWED' : res.errorCode}`);
      }
      const ok = await session.request(buildMessage(0x0008, [xorPeerAddress('203.0.113.10', 80)], auth));
      session.close();
      expect(ok.success, 'public addresses should be allowed');
    },
  );
}

async function cliChecks() {
  const { sendFiles } = await import('../../apps/cli/src/commands/send.js');
  const { receiveFiles } = await import('../../apps/cli/src/commands/receive.js');
  const dir = mkdtempSync(join(tmpdir(), 'hopline-vapt-'));
  writeFileSync(join(dir, 'secret.txt'), 'top secret');

  await check('cli', 'sender survives 300 fuzzed handshakes, then serves the real receiver', async () => {
    let ready;
    const readyP = new Promise((r) => (ready = r));
    const done = sendFiles([join(dir, 'secret.txt')], { quiet: true, discovery: false, onReady: ready });
    const { code, port } = await readyP;
    const header = Buffer.concat([Buffer.from('HOPL'), Buffer.of(2)]);
    const cases = [];
    for (let i = 0; i < 300; i++) {
      const kind = i % 5;
      if (kind === 0) cases.push(randomBytes(Math.floor(Math.random() * 2048)));
      else if (kind === 1)
        cases.push(Buffer.concat([header, randomBytes(16), Buffer.alloc(32)])); // identity point
      else if (kind === 2)
        cases.push(Buffer.concat([header, randomBytes(16), Buffer.alloc(32, 0xff)])); // invalid point
      else if (kind === 3)
        cases.push(Buffer.concat([Buffer.from('HOPL'), Buffer.of(99), randomBytes(48)])); // bad version
      else cases.push(Buffer.concat([header, randomBytes(48), Buffer.from([0xff, 0xff, 0xff, 0xff])])); // huge frame
    }
    for (let i = 0; i < cases.length; i += 4) {
      await Promise.all(
        cases.slice(i, i + 4).map(
          (payload) =>
            new Promise((resolve) => {
              const s = net.connect(port, '127.0.0.1', () => s.end(payload));
              s.resume();
              s.on('close', resolve);
              s.on('error', resolve);
            }),
        ),
      );
    }
    const out = join(dir, 'out');
    const received = await receiveFiles(code, {
      host: `127.0.0.1:${port}`,
      outDir: out,
      autoAccept: true,
      quiet: true,
    });
    expect(received.status === 'done', 'real receiver failed');
    expect((await done).status === 'done', 'sender failed');
    return '300 malformed connections ignored';
  });

  await check('cli', 'a wrong code gets nothing and is counted as a guess', async () => {
    let ready;
    const readyP = new Promise((r) => (ready = r));
    const done = sendFiles([join(dir, 'secret.txt')], {
      quiet: true,
      discovery: false,
      onReady: ready,
      maxFailedAttempts: 1,
    }).then(
      () => 'resolved',
      (e) => e.message,
    );
    const { port } = await readyP;
    const attempt = await receiveFiles('11-wrong-guess-here', {
      host: `127.0.0.1:${port}`,
      outDir: join(dir, 'x'),
      autoAccept: true,
      quiet: true,
    }).then(
      () => 'got files!',
      (e) => e.message,
    );
    expect(/didn't accept this code/.test(attempt), attempt);
    expect(/Too many wrong-code attempts/.test(await done), 'sender did not stop');
    expect(!existsSync(join(dir, 'x', 'secret.txt')), 'file written for a wrong code');
  });

  await check('cli', 'malicious sender greeting cannot crash the receiver', async () => {
    const server = net.createServer((s) => {
      s.on('error', () => {});
      s.end(Buffer.concat([Buffer.from('HOPL'), Buffer.of(2), randomBytes(16)]));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const outcome = await receiveFiles('22-amber-river-falcon', {
      host: `127.0.0.1:${port}`,
      outDir: join(dir, 'y'),
      autoAccept: true,
      quiet: true,
    }).then(
      () => 'accepted?!',
      (e) => e.message,
    );
    server.close();
    expect(outcome !== 'accepted?!', 'receiver accepted a fake sender');
    return outcome.slice(0, 60);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function reachable(base) {
  try {
    return (await rawRequest(base, { path: '/health' })).status === 200;
  } catch {
    return false;
  }
}

console.log(`\nHopline VAPT — active tests\n`);
if (await reachable(WEB)) {
  console.log(`Web stack (nginx + server) at ${WEB}`);
  await httpChecks(WEB, 'nginx');
  await websocketChecks(WEB);
} else console.log(`SKIP web stack: ${WEB} not reachable`);

if (await reachable(NODE)) {
  console.log(`\nAll-in-one image (Node serves UI) at ${NODE}`);
  await httpChecks(NODE, 'node');
} else console.log(`SKIP all-in-one: ${NODE} not reachable`);

console.log(`\nTURN relay at ${TURN_HOST}:${TURN_PORT}`);
if (TURN_SECRET) await turnChecks();
else console.log('SKIP TURN: TURN_SECRET not set');

console.log(`\nCLI`);
await cliChecks();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}\n`,
);
mkdirSync(join(ROOT, 'security', 'vapt'), { recursive: true });
writeFileSync(
  join(ROOT, 'security', 'vapt', 'results.json'),
  JSON.stringify(
    { ranAt: new Date().toISOString(), web: WEB, node: NODE, turn: `${TURN_HOST}:${TURN_PORT}`, results },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
