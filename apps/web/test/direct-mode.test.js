import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferedSink } from '../src/services/storage/sinks.js';
import { TransferManager, TransferStatus as S } from '../src/services/transfer/transfer-manager.js';
import { DirectService } from '../../desktop/src/direct/service.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Minimal ordered fake RTCDataChannel pair (counts binary bytes so we can see which path was used). */
class FakeChannel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  peer = null;
  binaryBytes = 0;
  send(data) {
    if (this.readyState !== 'open') throw new Error('closed');
    let payload = data;
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      payload = bytes.slice().buffer;
      this.binaryBytes += bytes.length;
    }
    const target = this.peer;
    setImmediate(
      () =>
        target.readyState === 'open' && target.dispatchEvent(new MessageEvent('message', { data: payload })),
    );
  }
  close() {
    for (const end of [this, this.peer]) end.readyState = 'closed';
  }
}

class MemorySinkForTest extends BufferedSink {
  parts = [];
  async store(bytes) {
    this.parts.push(Buffer.from(bytes));
  }
  async finalize() {
    return { location: 'memory', url: null };
  }
  get data() {
    return Buffer.concat(this.parts);
  }
}

/** What the desktop preload exposes, backed by a real DirectService (events arrive asynchronously, like IPC). */
function bridgeFor(service, paths) {
  const listeners = new Set();
  service.on('event', (event) => setImmediate(() => listeners.forEach((listener) => listener({ ...event }))));
  return {
    fileToken: async (file) => (paths.has(file) ? service.registerPath(paths.get(file)) : null),
    listen: () => service.listen(),
    expect: (options) => service.expect(options),
    connect: (info) => service.connect(info),
    send: (options) => service.send(options),
    cancel: (id) => service.cancel(id),
    reset: () => service.reset(),
    openFile: (options) => service.openFile(options),
    writeFile: (handle, bytes) => service.writeFile(handle, bytes),
    commitFile: (handle) => service.commitFile(handle),
    abortFile: (handle) => service.abortFile(handle),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('Direct mode end to end (TransferManager + real TCP engine)', () => {
  let work;
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'hopline-dm-'));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function setup({ aliceDesktop = true, bobDesktop = true, tweakBob } = {}) {
    const paths = new Map();
    const sinks = new Map();
    const aliceService = new DirectService({ downloadsDir: work });
    const bobService = new DirectService({ downloadsDir: work });
    tweakBob?.(bobService);
    const outDir = await mkdtemp(join(work, 'out-'));
    const { folderId } = bobService.registerFolder(outDir);
    const createSink = ({ row }) => {
      const sink = new MemorySinkForTest();
      sinks.set(row.path, sink);
      return sink;
    };
    const alice = new TransferManager({
      createSink,
      direct: aliceDesktop ? bridgeFor(aliceService, paths) : null,
    });
    const bob = new TransferManager({ createSink, direct: bobDesktop ? bridgeFor(bobService, paths) : null });
    const a = new FakeChannel();
    const b = new FakeChannel();
    a.peer = b;
    b.peer = a;
    alice.attach(a);
    bob.attach(b);
    const makeFile = async (name, bytes) => {
      const path = join(work, `${name}-${randomBytes(4).toString('hex')}`);
      await writeFile(path, bytes);
      const file = new File([bytes], name);
      paths.set(file, path);
      return file;
    };
    const acceptNative = () => {
      for (const row of bob.snapshot) {
        if (row.direction === 'in' && row.status === S.OFFERED)
          bob.accept(row.batchId, bobDesktop ? { kind: 'native', folderId } : { kind: 'browser' });
      }
    };
    const cleanup = async () => {
      alice.dispose();
      bob.dispose();
      await aliceService.reset();
      await bobService.reset();
    };
    return { alice, bob, a, outDir, sinks, makeFile, acceptNative, cleanup, bobService };
  }

  const rows = (m, dir) => m.snapshot.filter((r) => r.direction === dir);

  test('two desktop apps: the file goes over the direct link, verified, straight into the folder', async () => {
    const env = await setup();
    const data = randomBytes(24 * 1024 * 1024 + 7);
    env.alice.send([
      await env.makeFile('movie.mkv', data),
      await env.makeFile('note.txt', Buffer.from('hi')),
    ]);
    await waitFor(() => rows(env.bob, 'in').length === 2, { label: 'offer' });
    env.acceptNative();
    await waitFor(
      () =>
        rows(env.alice, 'out').every((r) => r.status === S.DONE) &&
        rows(env.bob, 'in').every((r) => r.status === S.DONE),
      { label: 'done' },
    );
    assert.ok((await readFile(join(env.outDir, 'movie.mkv'))).equals(data), 'byte-identical on disk');
    assert.equal(await readFile(join(env.outDir, 'note.txt'), 'utf8'), 'hi');
    assert.ok(env.a.binaryBytes < 64 * 1024, `file bytes did not go over WebRTC (${env.a.binaryBytes})`);
    assert.ok(
      rows(env.bob, 'in').every((r) => r.verified && r.savedAs && r.folderId),
      'verified and saved',
    );
    assert.ok(rows(env.alice, 'out').every((r) => r.verified));
    await env.cleanup();
  });

  test('a browser on the other side: plain WebRTC, nothing changes', async () => {
    const env = await setup({ bobDesktop: false });
    const data = randomBytes(2 * 1024 * 1024);
    env.alice.send([await env.makeFile('a.bin', data)]);
    await waitFor(() => rows(env.bob, 'in').length === 1);
    env.acceptNative();
    await waitFor(() => rows(env.bob, 'in')[0].status === S.DONE, { label: 'done' });
    assert.ok(env.sinks.get('a.bin').data.equals(data));
    assert.ok(env.a.binaryBytes >= data.length, 'sent over WebRTC');
    await env.cleanup();
  });

  test('not reachable directly: falls back to WebRTC automatically', async () => {
    const env = await setup({
      tweakBob: (service) => {
        const listen = service.listen.bind(service);
        // Pretend the receiver is on another network: its addresses can't be dialled.
        service.listen = async () => ({ ...(await listen()), addresses: ['8.8.8.8'] });
      },
    });
    const data = randomBytes(3 * 1024 * 1024);
    env.alice.send([await env.makeFile('far.bin', data)]);
    await waitFor(() => rows(env.bob, 'in').length === 1);
    env.acceptNative();
    await waitFor(() => rows(env.bob, 'in')[0].status === S.DONE, { label: 'done via WebRTC' });
    assert.ok(env.sinks.get('far.bin').data.equals(data), 'byte-identical after fallback');
    await env.cleanup();
  });

  test('the link dies mid-file: the file is resent over WebRTC and arrives intact', async () => {
    const env = await setup();
    const data = randomBytes(48 * 1024 * 1024);
    env.alice.send([await env.makeFile('cut.bin', data)]);
    await waitFor(() => rows(env.bob, 'in').length === 1);
    env.acceptNative();
    await waitFor(() => rows(env.bob, 'in')[0].via === 'direct' && rows(env.bob, 'in')[0].bytes > 0, {
      label: 'direct progress',
    });
    await env.bobService.reset(); // the receiver's link goes away (like a network change)
    await waitFor(() => rows(env.bob, 'in')[0].status === S.DONE, {
      label: 'done after fallback',
      timeoutMs: 60_000,
    });
    assert.ok(env.sinks.get('cut.bin').data.equals(data), 'byte-identical');
    assert.deepEqual(
      (await readdir(env.outDir)).filter((n) => !n.startsWith('.')),
      [],
      'no partial direct copy left',
    );
    await env.cleanup();
  });

  test('the receiver cancels a direct transfer: both sides show cancelled, nothing saved', async () => {
    const env = await setup();
    const data = randomBytes(64 * 1024 * 1024);
    env.alice.send([await env.makeFile('stop.bin', data)]);
    await waitFor(() => rows(env.bob, 'in').length === 1);
    env.acceptNative();
    await waitFor(() => rows(env.bob, 'in')[0].via === 'direct' && rows(env.bob, 'in')[0].bytes > 0, {
      label: 'direct progress',
    });
    env.bob.cancel(rows(env.bob, 'in')[0].id);
    await waitFor(() => rows(env.alice, 'out')[0].status === S.CANCELLED, { label: 'sender cancelled' });
    assert.equal(rows(env.bob, 'in')[0].status, S.CANCELLED);
    await sleep(200);
    assert.deepEqual(await readdir(env.outDir), [], 'nothing left in the folder');
    await env.cleanup();
  });

  test('a peer can never make us listen for a file we did not accept', async () => {
    const env = await setup();
    const file = await env.makeFile('x.bin', Buffer.from('x'));
    env.alice.send([file]);
    await waitFor(() => rows(env.bob, 'in').length === 1);
    // Not accepted yet: a direct request must be refused (and nothing listens).
    env.a.send(JSON.stringify({ t: 'direct-request', id: rows(env.alice, 'out')[0].id }));
    const replies = [];
    env.a.addEventListener('message', (e) => typeof e.data === 'string' && replies.push(JSON.parse(e.data)));
    await waitFor(() => replies.some((m) => m.t === 'direct-ready'), { label: 'reply' });
    assert.equal(replies.find((m) => m.t === 'direct-ready').ok, false);
    await env.cleanup();
  });
});
