import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectService } from '../src/direct/service.js';
import { DirectLink, LinkLostError, isAllowedAddress, pickTargets } from '../src/direct/sender.js';
import { Msg, Role, SecureChannel } from '../src/direct/wire.js';
import { lanAddresses } from '@hopline/cli/src/utils/network.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lists every file under a folder (relative paths), ignoring nothing — temp files would show up too. */
async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

describe('Direct mode engine', () => {
  let work;
  let outDir;
  let sender;
  let receiver;
  let events;

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'hopline-direct-'));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function pair() {
    outDir = await mkdtemp(join(work, 'out-'));
    sender = new DirectService({ downloadsDir: work });
    receiver = new DirectService({ downloadsDir: work });
    events = [];
    receiver.on('event', (e) => events.push(e));
    const { folderId } = receiver.registerFolder(outDir);
    const info = await receiver.listen();
    return { folderId, info };
  }

  async function makeFile(name, bytes) {
    const path = join(work, name);
    await writeFile(path, bytes);
    return { path, token: await sender.registerPath(path) };
  }

  test('sends a file at native speed, verified before it appears', async () => {
    const { folderId, info } = await pair();
    const data = randomBytes(40 * 1024 * 1024 + 123);
    const { token } = await makeFile('big.bin', data);
    await receiver.expect({ id: 'f1', folderId, path: 'album/big.bin', size: data.length });
    await sender.connect(info);
    const started = Date.now();
    const result = await sender.send({ id: 'f1', fileToken: token, size: data.length });
    assert.deepEqual(result, { ok: true, error: undefined });
    const received = await readFile(join(outDir, 'album', 'big.bin'));
    assert.ok(received.equals(data), 'byte-identical');
    const done = events.find((e) => e.type === 'received');
    assert.equal(done.ok, true);
    assert.equal(done.savedAs, 'album/big.bin');
    assert.equal(done.savedPath, undefined, 'absolute paths never go to the renderer');
    assert.ok(
      events.some((e) => e.type === 'progress'),
      'progress reported',
    );
    assert.deepEqual(await listFiles(outDir), ['album/big.bin'], 'no temp files left');
    console.log(`  40 MiB in ${Date.now() - started} ms`);
    await sender.reset();
    await receiver.reset();
  });

  test('never overwrites, keeps paths inside the folder, and reuses one link for many files', async () => {
    const { folderId, info } = await pair();
    await writeFile(join(outDir, 'report.pdf'), 'already here');
    const files = [
      { id: 'a', path: 'report.pdf', data: Buffer.from('new report') },
      { id: 'b', path: '../../escape.txt', data: Buffer.from('nope') },
      { id: 'c', path: 'empty.txt', data: Buffer.alloc(0) },
    ];
    await sender.connect(info);
    for (const file of files) {
      const { token } = await makeFile(`src-${file.id}`, file.data);
      if (file.id === 'b') {
        await assert.rejects(
          receiver.expect({ id: file.id, folderId, path: file.path, size: file.data.length }),
          /unsafe path/,
        );
        continue;
      }
      await receiver.expect({ id: file.id, folderId, path: file.path, size: file.data.length });
      assert.equal((await sender.send({ id: file.id, fileToken: token, size: file.data.length })).ok, true);
    }
    assert.deepEqual((await listFiles(outDir)).sort(), ['empty.txt', 'report (1).pdf', 'report.pdf']);
    assert.equal(await readFile(join(outDir, 'report.pdf'), 'utf8'), 'already here');
    assert.equal(await readFile(join(outDir, 'report (1).pdf'), 'utf8'), 'new report');
    await sender.reset();
    await receiver.reset();
  });

  test('the receiver can cancel mid-file; nothing is written and the link keeps working', async () => {
    const { folderId, info } = await pair();
    const big = randomBytes(64 * 1024 * 1024);
    const { token } = await makeFile('cancel.bin', big);
    await receiver.expect({ id: 'big', folderId, path: 'cancel.bin', size: big.length });
    await sender.connect(info);
    const sending = sender.send({ id: 'big', fileToken: token, size: big.length });
    await waitFor(() => events.some((e) => e.type === 'progress'), { label: 'progress' });
    receiver.cancel('big');
    assert.deepEqual(await sending, { ok: false, cancelled: true });
    await waitFor(() => events.some((e) => e.type === 'received' && e.cancelled), { label: 'cancelled' });

    const small = await makeFile('after.txt', Buffer.from('after'));
    await receiver.expect({ id: 'next', folderId, path: 'after.txt', size: 5 });
    assert.equal((await sender.send({ id: 'next', fileToken: small.token, size: 5 })).ok, true);
    assert.deepEqual(await listFiles(outDir), ['after.txt']);
    await sender.reset();
    await receiver.reset();
  });

  test('the sender can cancel mid-file', async () => {
    const { folderId, info } = await pair();
    const big = randomBytes(64 * 1024 * 1024);
    const { token } = await makeFile('cancel2.bin', big);
    await receiver.expect({ id: 'big', folderId, path: 'cancel2.bin', size: big.length });
    await sender.connect(info);
    const sending = sender.send({ id: 'big', fileToken: token, size: big.length });
    await waitFor(() => events.some((e) => e.type === 'progress'), { label: 'progress' });
    sender.cancel('big');
    assert.deepEqual(await sending, { ok: false, cancelled: true });
    await waitFor(() => events.some((e) => e.type === 'received' && e.cancelled), {
      label: 'receiver saw it',
    });
    assert.deepEqual(await listFiles(outDir), []);
    await sender.reset();
    await receiver.reset();
  });

  test('a wrong key gets nothing, and the real sender can still connect', async () => {
    const { folderId, info } = await pair();
    await assert.rejects(DirectLink.connect({ ...info, key: randomBytes(32).toString('base64') }));
    const data = Buffer.from('hello');
    const { token } = await makeFile('k.txt', data);
    await receiver.expect({ id: 'k', folderId, path: 'k.txt', size: 5 });
    await sender.connect(info);
    assert.equal((await sender.send({ id: 'k', fileToken: token, size: 5 })).ok, true);
    await sender.reset();
    await receiver.reset();
  });

  test('a listener accepts one link only: later connections are refused', async () => {
    const { info } = await pair();
    await sender.connect(info);
    const intruder = new DirectService({ downloadsDir: work });
    await assert.rejects(intruder.connect(info), 'a second link with the same key is refused');
    await sender.reset();
    await receiver.reset();
  });

  test('a file the user did not accept closes the link without writing anything', async () => {
    const { info } = await pair();
    const { token } = await makeFile('x.bin', Buffer.from('surprise'));
    await sender.connect(info);
    const result = await sender.send({ id: 'never-accepted', fileToken: token, size: 8 });
    assert.equal(result.lost, true, 'the sender falls back');
    assert.deepEqual(await listFiles(outDir), []);
    await sender.reset();
    await receiver.reset();
  });

  test('junk connections and garbage frames never get in', async () => {
    const { folderId, info } = await pair();
    for (let i = 0; i < 20; i++) {
      const socket = net.connect({ host: '127.0.0.1', port: info.port });
      socket.on('error', () => {});
      socket.write(randomBytes(64));
      socket.end();
    }
    await sleep(100);
    const { token } = await makeFile('ok.txt', Buffer.from('ok'));
    await receiver.expect({ id: 'ok', folderId, path: 'ok.txt', size: 2 });
    await sender.connect(info);
    assert.equal((await sender.send({ id: 'ok', fileToken: token, size: 2 })).ok, true);
    await sender.reset();
    await receiver.reset();
  });

  test('only regular files the user chose can be sent; only private addresses are dialled', async () => {
    sender = new DirectService({ downloadsDir: work });
    assert.equal(await sender.registerPath(work), null, 'a folder is not a file');
    assert.equal(await sender.registerPath('relative.txt'), null);
    assert.equal(await sender.registerPath(join(work, 'missing.bin')), null);
    assert.deepEqual(await sender.send({ id: 'x', fileToken: 'forged', size: 1 }), {
      ok: false,
      error: 'Unknown file.',
    });
    for (const ok of ['192.168.1.5', '10.0.0.1', '172.16.3.4', '100.64.0.1', '127.0.0.1'])
      assert.ok(isAllowedAddress(ok), ok);
    for (const bad of ['169.254.169.254', '8.8.8.8', '172.32.0.1', '::1', 'example.com', ''])
      assert.ok(!isAllowedAddress(bad), bad);
  });

  test('a wrong checksum from a hostile sender is refused before the file is committed', async () => {
    const { folderId, info } = await pair();
    await receiver.expect({ id: 'evil', folderId, path: 'evil.bin', size: 4 });
    const socket = net.connect({ host: '127.0.0.1', port: info.port });
    await new Promise((resolve) => socket.once('connect', resolve));
    const channel = new SecureChannel(socket, Buffer.from(info.key, 'base64'), Role.SENDER);
    await channel.sendJson(Msg.HELLO, { v: 1 });
    assert.equal((await channel.next()).type, Msg.READY);
    await channel.sendJson(Msg.FILE, { id: 'evil', size: 4 });
    await channel.send(Msg.CHUNK, Buffer.from([1, 2, 3, 4]));
    await channel.sendJson(Msg.END, { sha256: '0'.repeat(64) });
    let reply;
    do reply = await channel.next();
    while (reply.type !== Msg.RESULT);
    const result = JSON.parse(reply.body.toString());
    assert.equal(result.ok, false);
    assert.match(result.error, /Checksum mismatch/);
    assert.deepEqual(await listFiles(outDir), [], 'nothing committed, temp file removed');
    channel.close();
    await receiver.reset();
  });
  test('dials loopback only for a receiver on this machine, never for a remote one', () => {
    const own = [
      { address: '192.168.1.35', netmask: '255.255.255.0' },
      { address: '172.17.96.1', netmask: '255.255.240.0' },
    ];
    assert.deepEqual(pickTargets(['192.168.1.35', '127.0.0.1'], own), ['127.0.0.1'], 'same machine');
    assert.deepEqual(
      pickTargets(['192.168.1.80', '172.17.100.2', '10.0.0.7', '100.101.1.2', '127.0.0.1'], own),
      ['192.168.1.80', '172.17.100.2', '100.101.1.2'],
      'only our own subnets (and overlays like Tailscale), never loopback for a remote peer',
    );
    assert.deepEqual(pickTargets(['127.0.0.1'], own), [], 'a remote peer claiming loopback gets nothing');
    assert.deepEqual(pickTargets(['8.8.8.8', '169.254.169.254'], own), []);
  });

  test(
    'a link that opens but stops making progress is dropped (the file falls back)',
    { skip: lanAddresses().length === 0 && 'needs a network interface' },
    async () => {
      const key = randomBytes(32);
      const server = net.createServer(async (socket) => {
        socket.on('error', () => {});
        const channel = new SecureChannel(socket, key, Role.RECEIVER);
        await channel.next(); // HELLO
        await channel.send(Msg.READY);
        socket.pause(); // like a firewall that lets the connection open but holds its data
      });
      await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
      const { port } = server.address();
      try {
        const link = await DirectLink.connect(
          // A receiver on this machine advertises our own address, so the sender dials loopback.
          { addresses: [...lanAddresses(), '127.0.0.1'], port, key: key.toString('base64') },
          { stallTimeoutMs: 1500 },
        );
        const path = join(work, 'stall.bin');
        await writeFile(path, randomBytes(32 * 1024 * 1024));
        const started = Date.now();
        await assert.rejects(link.sendFile({ id: 'stall', path, size: 32 * 1024 * 1024 }), LinkLostError);
        assert.ok(Date.now() - started < 10_000, 'gave up quickly');
      } finally {
        server.close();
      }
    },
  );
});
