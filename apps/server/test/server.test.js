import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { WebSocket } from 'ws';
import { ClientMessage, ErrorReason, ServerMessage } from '@hopline/protocol';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { clientIp, limitKey } from '../src/lib/client-ip.js';
import { silentLogger } from '../src/lib/logger.js';
import { TokenBucket } from '../src/lib/token-bucket.js';
import { createIceServerProvider } from '../src/signaling/ice-servers.js';
import { RoomRegistry } from '../src/signaling/room-registry.js';

describe('RoomRegistry', () => {
  test('creates, joins, rejects a third member and closes', () => {
    const rooms = new RoomRegistry({ ttlMs: 1000 });
    const { room, member: host } = rooms.create('a');
    assert.deepEqual(rooms.join('XXXXXX', 'b'), { error: 'not-found' });
    const { member: guest } = rooms.join(room.code, 'b');
    assert.deepEqual(rooms.join(room.code, 'c'), { error: 'full' });
    assert.equal(rooms.otherMember(room, host), guest);
    assert.notEqual(host.token, guest.token);
    assert.equal(rooms.close(room), true);
    assert.equal(rooms.close(room), false);
    assert.equal(rooms.size, 0);
  });

  test('finds a member only with the exact token', () => {
    const rooms = new RoomRegistry({ ttlMs: 1000 });
    const { room, member } = rooms.create('a');
    assert.equal(rooms.findMember(room.code, member.token).member, member);
    assert.equal(rooms.findMember(room.code, member.token.replace(/.$/, '#')), null);
    assert.equal(rooms.findMember(room.code, 'short'), null);
    assert.equal(rooms.findMember('ZZZZZZ', member.token), null);
  });

  test('sweeps rooms nobody joined', () => {
    let now = 0;
    const rooms = new RoomRegistry({ ttlMs: 10, now: () => now });
    const lonely = rooms.create('a').room;
    const paired = rooms.create('b').room;
    rooms.join(paired.code, 'c');
    now = 100;
    assert.deepEqual(
      rooms.sweepExpired().map((r) => r.code),
      [lonely.code],
    );
    assert.equal(rooms.size, 1);
  });
});

describe('TokenBucket', () => {
  test('allows a burst, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket({ ratePerSecond: 2, burst: 3, now: () => now });
    assert.equal([1, 2, 3, 4].map(() => bucket.take()).join(), 'true,true,true,false');
    now = 500; // +1 token
    assert.equal(bucket.take(), true);
    assert.equal(bucket.take(), false);
  });
});

describe('config', () => {
  test('uses defaults and validates input', () => {
    const config = loadConfig({});
    assert.equal(config.port, 8787);
    assert.equal(config.serveWeb, true);
    assert.equal(config.reconnectGraceMs, 120_000);
    assert.ok(config.stunUrls.length > 0);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid value for PORT/);
    assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
  });

  test('validates TURN settings', () => {
    assert.throws(() => loadConfig({ TURN_URLS: 'turn:x:3478' }), /TURN_SECRET/);
    assert.throws(() => loadConfig({ TURN_URLS: 'http://x', TURN_SECRET: 'x'.repeat(32) }), /turn:/);
    assert.throws(() => loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'short' }), /at least 16/);
    assert.equal(loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'x'.repeat(32) }).turn.urls.length, 1);
  });
});

describe('ICE servers', () => {
  test('issues expiring TURN credentials signed with the shared secret', () => {
    const secret = 'a-very-long-turn-secret';
    const provide = createIceServerProvider(
      { stunUrls: ['stun:s:3478'], turn: { urls: ['turn:t:3478'], secret, ttlSeconds: 600 } },
      () => 1_000_000_000_000,
    );
    const [stun, turn] = provide();
    assert.deepEqual(stun, { urls: ['stun:s:3478'] });
    const [expiry] = turn.username.split(':');
    assert.equal(Number(expiry), 1_000_000_000 + 600);
    assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
    assert.notEqual(provide()[1].username, turn.username, 'each call gets a distinct username');
  });

  test('omits TURN when not configured', () => {
    const provide = createIceServerProvider({ stunUrls: [], turn: { urls: [] } });
    assert.deepEqual(provide(), []);
  });
});

/** Tiny test client that lets a test await the next message of a given type. */
function connectClient(url, options = {}) {
  const socket = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.type === msg.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    socket,
    inbox,
    opened: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    closed: new Promise((resolve) => socket.once('close', (code) => resolve(code))),
    send: (msg) => socket.send(JSON.stringify(msg)),
    next(type, timeoutMs = 3000) {
      const index = inbox.findIndex((m) => m.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('signaling over WebSocket', () => {
  let app;
  let url;

  before(async () => {
    const config = {
      ...loadConfig({
        SERVE_WEB: 'false',
        MAX_CONNECTIONS_PER_IP: '50',
        TURN_URLS: 'turn:turn.example.com:3478',
        TURN_SECRET: 'test-secret-1234567890',
      }),
      // Long enough for a reconnect on a busy machine, short enough to test expiry quickly.
      reconnectGraceMs: 1500,
    };
    app = createApp({ config, logger: silentLogger });
    const port = await app.listen(0, '127.0.0.1');
    url = `ws://127.0.0.1:${port}/ws`;
  });

  after(() => app.close());

  async function pair() {
    const host = connectClient(url);
    const guest = connectClient(url);
    await Promise.all([host.opened, guest.opened]);
    host.send({ type: ClientMessage.CREATE });
    const created = await host.next(ServerMessage.CREATED);
    guest.send({ type: ClientMessage.JOIN, code: created.code.toLowerCase() });
    const joined = await guest.next(ServerMessage.JOINED);
    const peerJoined = await host.next(ServerMessage.PEER_JOINED);
    return { host, guest, created, joined, peerJoined };
  }

  const hasTurn = (servers) => servers.some((s) => s.username && s.credential);

  test('pairs two peers with tokens and ICE servers, and relays signals', async () => {
    const { host, guest, created, joined, peerJoined } = await pair();
    assert.equal(joined.code, created.code);
    assert.match(created.token, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(created.token, joined.token);
    assert.equal(hasTurn(created.iceServers), false, 'no relay credentials for a room nobody joined');
    assert.ok(hasTurn(joined.iceServers), 'guest gets relay credentials once paired');
    assert.ok(hasTurn(peerJoined.iceServers), 'host gets relay credentials once paired');

    const offer = { description: { type: 'offer', sdp: 'v=0' } };
    host.send({ type: ClientMessage.SIGNAL, data: offer });
    assert.deepEqual((await guest.next(ServerMessage.SIGNAL)).data, offer);

    const intruder = connectClient(url);
    await intruder.opened;
    intruder.send({ type: ClientMessage.JOIN, code: created.code });
    assert.equal((await intruder.next(ServerMessage.ERROR)).reason, ErrorReason.ROOM_FULL);
    intruder.socket.close();

    guest.send({ type: ClientMessage.LEAVE });
    await host.next(ServerMessage.PEER_LEFT);
    host.socket.close();
    guest.socket.close();
  });

  test('a dropped peer can rejoin within the grace period', async () => {
    const { host, guest, created, joined } = await pair();
    guest.socket.terminate();
    await host.next(ServerMessage.PEER_DISCONNECTED);

    const again = connectClient(url);
    await again.opened;
    again.send({ type: ClientMessage.REJOIN, code: created.code, token: joined.token });
    const rejoined = await again.next(ServerMessage.REJOINED);
    assert.equal(rejoined.peerPresent, true);
    assert.ok(rejoined.iceServers.length > 0);
    await host.next(ServerMessage.PEER_RECONNECTED);

    host.send({ type: ClientMessage.SIGNAL, data: { hello: 1 } });
    assert.deepEqual((await again.next(ServerMessage.SIGNAL)).data, { hello: 1 });
    host.socket.close();
    again.socket.close();
  });

  test('the room closes when the grace period runs out', async () => {
    const { host, guest, created, joined } = await pair();
    guest.socket.terminate();
    await host.next(ServerMessage.PEER_DISCONNECTED);
    await host.next(ServerMessage.PEER_LEFT, 8000);

    const late = connectClient(url);
    await late.opened;
    late.send({ type: ClientMessage.REJOIN, code: created.code, token: joined.token });
    assert.equal((await late.next(ServerMessage.ERROR)).reason, ErrorReason.REJOIN_FAILED);
    late.socket.close();
    host.socket.close();
  });

  test('a newer connection replaces a ghost socket for the same seat', async () => {
    const { host, guest, created, joined } = await pair();
    const fresh = connectClient(url);
    await fresh.opened;
    fresh.send({ type: ClientMessage.REJOIN, code: created.code, token: joined.token });
    await fresh.next(ServerMessage.REJOINED);
    assert.equal(await guest.closed, 4000);
    await sleep(50);
    assert.ok(!host.inbox.some((m) => m.type === ServerMessage.PEER_LEFT), 'room survives the replacement');
    host.socket.close();
    fresh.socket.close();
  });

  test('rejects forged or malformed rejoin tokens', async () => {
    const { host, created } = await pair();
    const attacker = connectClient(url);
    await attacker.opened;
    for (const token of ['x'.repeat(32), '', null, '../../etc', { $ne: '' }]) {
      attacker.send({ type: ClientMessage.REJOIN, code: created.code, token });
      assert.equal((await attacker.next(ServerMessage.ERROR)).reason, ErrorReason.REJOIN_FAILED);
    }
    attacker.socket.close();
    host.socket.close();
  });

  test('rejects malformed, unknown and prototype-key messages', async () => {
    const client = connectClient(url);
    await client.opened;
    client.socket.send('not json');
    assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.BAD_MESSAGE);
    for (const type of ['teleport', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      client.send({ type });
      assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.UNKNOWN_TYPE);
    }
    client.socket.send('null');
    assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.UNKNOWN_TYPE);
    client.send({ type: ClientMessage.JOIN, code: '!!' });
    assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.INVALID_CODE);
    client.send({ type: ClientMessage.SIGNAL, data: {} });
    assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.NOT_IN_ROOM);
    client.socket.close();
  });

  test('exposes a minimal health endpoint with security headers', async () => {
    const res = await fetch(url.replace('ws://', 'http://').replace('/ws', '/health'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.rooms, undefined, 'usage numbers are hidden by default');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
  });

  test('only allows GET and HEAD', async () => {
    const { hostname, port } = new URL(url);
    for (const method of ['POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS']) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path: '/health', method }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 405, method);
    }
  });
});

describe('abuse controls', () => {
  let app;
  let url;
  let host;

  before(async () => {
    const config = {
      ...loadConfig({
        SERVE_WEB: 'false',
        TRUST_PROXY: '1',
        MAX_CONNECTIONS_PER_IP: '2',
        JOIN_ATTEMPTS_PER_MINUTE: '3',
      }),
      unjoinedTimeoutMs: 300,
    };
    app = createApp({ config, logger: silentLogger });
    const port = await app.listen(0, '127.0.0.1');
    host = `127.0.0.1:${port}`;
    url = `ws://${host}/ws`;
  });

  after(() => app.close());

  const refused = (client) =>
    new Promise((resolve) => {
      client.socket.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      client.socket.once('open', () => resolve('opened'));
    });

  test('a spoofed X-Forwarded-For does not bypass per-client limits', async () => {
    const viaProxy = (i) =>
      connectClient(url, { headers: { 'x-forwarded-for': `${i}.${i}.${i}.${i}, 9.9.9.9` } });
    const a = viaProxy(1);
    const b = viaProxy(2);
    await Promise.all([a.opened, b.opened]);
    assert.equal(await refused(viaProxy(3)), 429, 'all three count as 9.9.9.9, the address the proxy saw');
    const other = connectClient(url, { headers: { 'x-forwarded-for': '7.7.7.7, 8.8.8.8' } });
    await other.opened;
    for (const c of [a, b, other]) c.socket.close();
  });

  test('rejects connections from other websites, allows same-site, desktop and non-browser clients', async () => {
    assert.equal(await refused(connectClient(url, { origin: 'https://evil.example' })), 403);
    for (const origin of [`http://${host}`, 'file://', undefined]) {
      const client = connectClient(url, origin ? { origin } : {});
      assert.equal(await refused(client), 'opened', String(origin));
      client.socket.close();
    }
  });

  test('wrong room codes run out after the per-minute budget', async () => {
    const client = connectClient(url, { headers: { 'x-forwarded-for': '5.5.5.5' } });
    await client.opened;
    for (let i = 0; i < 3; i++) {
      client.send({ type: ClientMessage.JOIN, code: 'ZZZZZZ' });
      assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.NOT_FOUND);
    }
    client.send({ type: ClientMessage.JOIN, code: 'ZZZZZZ' });
    assert.equal((await client.next(ServerMessage.ERROR)).reason, ErrorReason.RATE_LIMITED);
    client.send({ type: ClientMessage.CREATE }); // creating your own room still works
    await client.next(ServerMessage.CREATED);
    client.socket.close();
  });

  test('closes sockets that never join a room', async () => {
    const client = connectClient(url, { headers: { 'x-forwarded-for': '6.6.6.6' } });
    await client.opened;
    assert.equal(await client.closed, 4001);
  });
});

describe('client address handling', () => {
  test('trusts only the configured number of proxy hops, from the right', () => {
    const req = (xff, remote = '10.0.0.1') => ({
      headers: { 'x-forwarded-for': xff },
      socket: { remoteAddress: remote },
    });
    assert.equal(clientIp(req('6.6.6.6, 1.2.3.4'), 0), '10.0.0.1', 'no proxy: header ignored');
    assert.equal(clientIp(req('6.6.6.6, 1.2.3.4'), 1), '1.2.3.4', 'one proxy: right-most entry');
    assert.equal(clientIp(req('6.6.6.6, 1.2.3.4, 5.5.5.5'), 2), '1.2.3.4');
    assert.equal(clientIp(req('not-an-ip'), 1), '10.0.0.1', 'garbage falls back to the socket');
    assert.equal(clientIp(req(undefined, '::ffff:192.168.1.9'), 0), '192.168.1.9');
  });

  test('groups IPv6 clients by /64', () => {
    assert.equal(limitKey('2001:db8:1:2:aaaa::1'), limitKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notEqual(limitKey('2001:db8:1:2::1'), limitKey('2001:db8:1:3::1'));
    assert.equal(limitKey('203.0.113.7'), '203.0.113.7');
  });
});
