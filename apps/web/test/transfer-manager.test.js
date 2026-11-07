import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { TransferLimits, TransferMessage } from '@hopline/protocol';
import { BufferedSink } from '../src/services/storage/sinks.js';
import { FRAME_HEADER_BYTES, decodeFrame, encodeFrame } from '../src/services/transfer/frames.js';
import { TransferManager, TransferStatus as S } from '../src/services/transfer/transfer-manager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory stand-in for one end of an RTCDataChannel. Delivery is async and ordered (after `latencyMs`),
 * and bufferedAmount counts bytes not yet delivered, firing 'bufferedamountlow' like a browser.
 */
class FakeChannel extends EventTarget {
  readyState = 'open';
  latencyMs = 0;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  peer = null;
  bytesSent = 0;
  /** Optional hook to tamper with outgoing binary messages. */
  mutate = null;

  send(data) {
    if (this.readyState !== 'open') throw new Error('channel closed');
    let payload = data;
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      payload = bytes.slice().buffer;
      this.bytesSent += bytes.length;
      if (this.mutate) payload = this.mutate(payload) ?? payload;
    }
    const size = typeof data === 'string' ? data.length : payload.byteLength;
    this.bufferedAmount += size;
    const target = this.peer;
    const deliver = () => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (target.readyState === 'open') target.dispatchEvent(new MessageEvent('message', { data: payload }));
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold)
        this.dispatchEvent(new Event('bufferedamountlow'));
    };
    if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
    else setImmediate(deliver);
  }

  close() {
    for (const end of [this, this.peer]) {
      if (end.readyState === 'closed') continue;
      end.readyState = 'closed';
      setImmediate(() => end.dispatchEvent(new Event('close')));
    }
  }
}

function channelPair(latencyMs = 0) {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  a.latencyMs = b.latencyMs = latencyMs;
  return [a, b];
}

/** Opens extra lane channel pairs between two managers; returns the pairs. */
function connectLanes(alice, bob, latencies) {
  return latencies.map((latency) => {
    const [a, b] = channelPair(latency);
    assert.ok(alice.addLane(a) && bob.addLane(b), 'lane accepted');
    return [a, b];
  });
}

/** Collects received bytes in memory; can be slowed down to simulate a slow disk. */
class TestSink extends BufferedSink {
  constructor({ delayMs = 0, batchBytes = 64 * 1024 } = {}) {
    super({ batchBytes });
    this.delayMs = delayMs;
    this.parts = [];
    this.aborted = false;
    this.closed = false;
  }
  async store(bytes) {
    if (this.delayMs) await sleep(this.delayMs);
    this.parts.push(Buffer.from(bytes));
  }
  async finalize() {
    this.closed = true;
    return { location: 'memory', url: null };
  }
  async discard() {
    this.aborted = true;
    this.parts = [];
  }
  get data() {
    return Buffer.concat(this.parts);
  }
}

function setup({ limits = TransferLimits, delayMs = 0 } = {}) {
  const sinks = new Map();
  const createSink = ({ row }) => {
    const sink = new TestSink({ delayMs });
    sinks.set(row.path, sink);
    return sink;
  };
  const alice = new TransferManager({ limits, createSink });
  const bob = new TransferManager({ limits, createSink });
  const [a, b] = channelPair();
  alice.attach(a);
  bob.attach(b);
  return { alice, bob, sinks, channels: [a, b] };
}

async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const rows = (manager, direction) => manager.snapshot.filter((r) => r.direction === direction);
const allStatus = (manager, direction, status) => {
  const list = rows(manager, direction);
  return list.length > 0 && list.every((r) => r.status === status);
};
const acceptAll = (manager) => {
  for (const row of rows(manager, 'in')) if (row.status === S.OFFERED) manager.accept(row.batchId);
};

describe('TransferManager', () => {
  test('sends files and folders intact, verified on both ends', async () => {
    const { alice, bob, sinks } = setup();
    const big = randomBytes(3 * 1024 * 1024 + 4321);
    const small = Buffer.from('hello hopline');
    alice.send([
      new File([big], 'big.bin'),
      { file: new File([small], 'note.txt'), path: 'album/2024/note.txt' },
    ]);

    await waitFor(() => rows(bob, 'in').length === 2, { label: 'offer' });
    assert.ok(allStatus(bob, 'in', S.OFFERED), 'nothing is stored before the user accepts');
    assert.equal(sinks.size, 0);
    acceptAll(bob);

    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    assert.ok(sinks.get('big.bin').data.equals(big));
    assert.ok(sinks.get('album/2024/note.txt').data.equals(small));
    assert.ok(rows(alice, 'out').every((r) => r.verified === true && r.bytes === r.size));
    assert.ok(rows(bob, 'in').every((r) => r.verified === true));
  });

  test('a declined batch stores nothing', async () => {
    const { alice, bob, sinks } = setup();
    alice.send([new File(['secret'], 'a.txt')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    bob.decline(rows(bob, 'in')[0].batchId);
    await waitFor(() => allStatus(alice, 'out', S.DECLINED), { label: 'declined' });
    assert.equal(sinks.size, 0);
  });

  test('resumes after the connection drops, without resending what was already written', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 512 * 1024, PROGRESS_EVERY_BYTES: 64 * 1024 };
    const { alice, bob, sinks, channels } = setup({ limits, delayMs: 1 });
    const data = randomBytes(6 * 1024 * 1024 + 99);
    alice.send([new File([data], 'movie.mkv')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);

    await waitFor(() => (sinks.get('movie.mkv')?.bytesWritten ?? 0) >= 2 * 1024 * 1024, {
      label: '2 MB written',
    });
    const sentBeforeDrop = channels[0].bytesSent;
    channels[0].close();
    alice.detach();
    bob.detach();
    await sleep(50);

    const [a2, b2] = channelPair();
    alice.attach(a2);
    bob.attach(b2);
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), {
      label: 'resumed',
    });

    assert.ok(sinks.get('movie.mkv').data.equals(data), 'file is byte-identical');
    const total = sentBeforeDrop + a2.bytesSent;
    assert.ok(
      total < data.length + limits.WINDOW_BYTES + 2 * 1024 * 1024,
      `resent at most the in-flight window (sent ${total})`,
    );
    assert.ok(a2.bytesSent < data.length, 'the second connection did not start from zero');
  });

  test('survives the gap between a channel closing and its close event (no event-loop starvation)', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 512 * 1024, PROGRESS_EVERY_BYTES: 64 * 1024 };
    const { alice, bob, sinks, channels } = setup({ limits, delayMs: 1 });
    const data = randomBytes(4 * 1024 * 1024);
    alice.send([new File([data], 'race.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => (sinks.get('race.bin')?.bytesWritten ?? 0) >= 1024 * 1024);

    // Like a real RTCDataChannel: readyState flips to "closing" now, the close event comes later,
    // and the app only detaches when that event arrives.
    const [a, b] = channels;
    for (const end of [a, b]) end.readyState = 'closing';
    const closed = new Promise((resolve) =>
      setTimeout(() => {
        for (const end of [a, b]) end.readyState = 'closed';
        alice.detach();
        bob.detach();
        resolve();
      }, 250),
    );
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    await closed;
    clearInterval(ticker);
    assert.ok(ticks >= 3, `event loop kept running while the channel was closing (ticks: ${ticks})`);

    const [a2, b2] = channelPair();
    alice.attach(a2);
    bob.attach(b2);
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), {
      label: 'resumed',
    });
    assert.ok(sinks.get('race.bin').data.equals(data));
  });

  test('detects corruption and discards the file', async () => {
    const { alice, bob, sinks, channels } = setup();
    let tampered = false;
    channels[0].mutate = (buffer) => {
      if (tampered) return buffer;
      tampered = true;
      const bytes = new Uint8Array(buffer);
      bytes[FRAME_HEADER_BYTES + 10] ^= 0xff; // a payload byte, not the frame header
      return buffer;
    };
    alice.send([new File([randomBytes(200_000)], 'x.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => allStatus(bob, 'in', S.FAILED) && allStatus(alice, 'out', S.FAILED), {
      label: 'failed',
    });
    assert.match(rows(bob, 'in')[0].error, /Checksum mismatch/);
    await waitFor(() => sinks.get('x.bin').aborted, { label: 'corrupt data discarded' });
  });

  test('the receiver can cancel mid-transfer', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 256 * 1024, PROGRESS_EVERY_BYTES: 64 * 1024 };
    const { alice, bob, sinks } = setup({ limits, delayMs: 2 });
    alice.send([new File([randomBytes(8 * 1024 * 1024)], 'huge.bin'), new File(['after'], 'next.txt')]);
    await waitFor(() => rows(bob, 'in').length === 2);
    acceptAll(bob);
    await waitFor(() => (sinks.get('huge.bin')?.bytesWritten ?? 0) > 256 * 1024);
    bob.cancel(rows(bob, 'in').find((r) => r.name === 'huge.bin').id);
    await waitFor(() => rows(alice, 'out').find((r) => r.name === 'huge.bin').status === S.CANCELLED);
    await waitFor(() => rows(bob, 'in').find((r) => r.name === 'next.txt').status === S.DONE, {
      label: 'next file',
    });
    await waitFor(() => sinks.get('huge.bin').aborted, { label: 'partial data discarded' });
    assert.equal(sinks.get('next.txt').data.toString(), 'after');
  });

  test('both sides can send at the same time', async () => {
    const { alice, bob, sinks } = setup();
    const fromAlice = randomBytes(1_500_000);
    const fromBob = randomBytes(1_200_000);
    alice.send([new File([fromAlice], 'from-alice.bin')]);
    bob.send([new File([fromBob], 'from-bob.bin')]);
    await waitFor(() => rows(alice, 'in').length === 1 && rows(bob, 'in').length === 1);
    acceptAll(alice);
    acceptAll(bob);
    await waitFor(
      () =>
        allStatus(alice, 'out', S.DONE) &&
        allStatus(bob, 'out', S.DONE) &&
        allStatus(alice, 'in', S.DONE) &&
        allStatus(bob, 'in', S.DONE),
    );
    assert.ok(sinks.get('from-alice.bin').data.equals(fromAlice));
    assert.ok(sinks.get('from-bob.bin').data.equals(fromBob));
  });
});

describe('TransferManager over several lanes', () => {
  test('frames round-trip with offsets beyond 4 GiB', () => {
    const payload = new Uint8Array([7, 8, 9]);
    const frame = decodeFrame(encodeFrame(4_000_000_000, 5 * 2 ** 32 + 123, payload).buffer);
    assert.equal(frame.slot, 4_000_000_000);
    assert.equal(frame.offset, 5 * 2 ** 32 + 123);
    assert.deepEqual([...frame.payload], [7, 8, 9]);
    assert.equal(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES)), null, 'a frame needs a payload');
  });

  test('spreads frames over all lanes and reassembles them in order', async () => {
    const limits = { ...TransferLimits, HIGH_WATER_BYTES: 512 * 1024 };
    const { alice, bob, sinks, channels } = setup({ limits });
    // Lanes with different latencies deliver out of order, like separate network paths.
    const lanes = connectLanes(alice, bob, [2, 5, 9]);
    assert.equal(alice.laneCount, 4);
    const files = [randomBytes(5 * 1024 * 1024 + 17), randomBytes(70_000), Buffer.from('tiny')];
    alice.send(files.map((data, i) => new File([data], `f${i}.bin`)));
    await waitFor(() => rows(bob, 'in').length === 3);
    acceptAll(bob);
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    files.forEach((data, i) => assert.ok(sinks.get(`f${i}.bin`).data.equals(data), `f${i} intact`));
    for (const [a] of lanes) assert.ok(a.bytesSent > 0, 'every lane carried data');
    const total = channels[0].bytesSent + lanes.reduce((sum, [a]) => sum + a.bytesSent, 0);
    const payload = files.reduce((sum, d) => sum + d.length, 0);
    assert.ok(total < payload * 1.01, `nothing sent twice (${total} for ${payload})`);
  });

  test('a lane dropping mid-transfer loses nothing: its frames are resent on the others', async () => {
    const limits = {
      ...TransferLimits,
      HIGH_WATER_BYTES: 512 * 1024,
      WINDOW_BYTES: 2 * 1024 * 1024,
      PROGRESS_EVERY_BYTES: 128 * 1024,
    };
    const { alice, bob, sinks } = setup({ limits, delayMs: 1 });
    const lanes = connectLanes(alice, bob, [1, 25, 3]);
    const data = randomBytes(8 * 1024 * 1024 + 5);
    alice.send([new File([data], 'big.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => (sinks.get('big.bin')?.bytesWritten ?? 0) >= 1024 * 1024, { label: '1 MB' });
    // Cut the slow lane while it has frames in flight, so closing it drops them on the floor.
    await waitFor(() => lanes[1][0].bufferedAmount > 0, { label: 'frames in flight on the slow lane' });
    lanes[1][0].close();
    await waitFor(() => alice.laneCount === 3 && bob.laneCount === 3, { label: 'lane removed' });
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    assert.ok(sinks.get('big.bin').data.equals(data), 'byte-identical despite the lost lane');
    assert.equal(rows(bob, 'in')[0].verified, true);
  });

  test('resumes across a reconnect while using lanes', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 1024 * 1024, PROGRESS_EVERY_BYTES: 64 * 1024 };
    const { alice, bob, sinks, channels } = setup({ limits, delayMs: 1 });
    const lanes = connectLanes(alice, bob, [1, 4]);
    const data = randomBytes(6 * 1024 * 1024);
    alice.send([new File([data], 'r.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => (sinks.get('r.bin')?.bytesWritten ?? 0) >= 2 * 1024 * 1024);
    channels[0].close();
    for (const [a] of lanes) a.close();
    alice.detach();
    bob.detach();
    await sleep(30);
    const [a2, b2] = channelPair();
    alice.attach(a2);
    bob.attach(b2);
    connectLanes(alice, bob, [2, 3]);
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    assert.ok(sinks.get('r.bin').data.equals(data));
  });

  test('bidirectional transfers share the lanes', async () => {
    const { alice, bob, sinks } = setup();
    connectLanes(alice, bob, [1, 2, 3]);
    const fromAlice = randomBytes(2_000_000);
    const fromBob = randomBytes(1_700_000);
    alice.send([new File([fromAlice], 'a.bin')]);
    bob.send([new File([fromBob], 'b.bin')]);
    await waitFor(() => rows(alice, 'in').length === 1 && rows(bob, 'in').length === 1);
    acceptAll(alice);
    acceptAll(bob);
    await waitFor(() => allStatus(alice, 'in', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    assert.ok(sinks.get('a.bin').data.equals(fromAlice));
    assert.ok(sinks.get('b.bin').data.equals(fromBob));
  });
});

describe('TransferManager when the other page reloads', () => {
  const limits = { ...TransferLimits, WINDOW_BYTES: 512 * 1024, PROGRESS_EVERY_BYTES: 64 * 1024 };
  const makeSinks = () => {
    const sinks = new Map();
    const createSink = ({ row }) => {
      const sink = new TestSink({ delayMs: 1 });
      sinks.set(row.path, sink);
      return sink;
    };
    return { sinks, createSink };
  };

  test('receiver reloads mid-transfer: the sender offers the file again and it arrives intact', async () => {
    const { sinks, createSink } = makeSinks();
    const alice = new TransferManager({ limits, createSink });
    let bob = new TransferManager({ limits, createSink });
    let [a, b] = channelPair();
    alice.attach(a);
    bob.attach(b);
    const data = randomBytes(4 * 1024 * 1024);
    alice.send([new File([data], 'again.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => (sinks.get('again.bin')?.bytesWritten ?? 0) >= 1024 * 1024, { label: '1 MB' });

    // Bob's page reloads: a brand-new manager that remembers nothing.
    a.close();
    alice.detach();
    bob.dispose();
    await sleep(20);
    bob = new TransferManager({ limits, createSink });
    [a, b] = channelPair();
    alice.attach(a);
    bob.attach(b);

    await waitFor(() => rows(bob, 'in').length === 1, { label: 'offered again' });
    assert.equal(rows(alice, 'out')[0].status, S.AWAITING, 'waiting for the new page to accept');
    acceptAll(bob);
    await waitFor(() => allStatus(alice, 'out', S.DONE) && allStatus(bob, 'in', S.DONE), { label: 'done' });
    assert.ok(sinks.get('again.bin').data.equals(data));
  });

  test('sender reloads: the half-received file fails clearly and new files still arrive', async () => {
    const { sinks, createSink } = makeSinks();
    let alice = new TransferManager({ limits, createSink });
    const bob = new TransferManager({ limits, createSink });
    let [a, b] = channelPair();
    alice.attach(a);
    bob.attach(b);
    alice.send([new File([randomBytes(4 * 1024 * 1024)], 'lost.bin')]);
    await waitFor(() => rows(bob, 'in').length === 1);
    acceptAll(bob);
    await waitFor(() => (sinks.get('lost.bin')?.bytesWritten ?? 0) >= 512 * 1024, { label: 'started' });

    a.close();
    bob.detach();
    alice.dispose();
    await sleep(20);
    alice = new TransferManager({ limits, createSink });
    [a, b] = channelPair();
    alice.attach(a);
    bob.attach(b);

    await waitFor(() => rows(bob, 'in')[0].status === S.FAILED, { label: 'old file failed' });
    assert.match(rows(bob, 'in')[0].error, /reloaded/);
    await waitFor(() => sinks.get('lost.bin').aborted, { label: 'partial data discarded' });
    // The new page numbers its files from zero again; they must not be mistaken for stale ones.
    const fresh = randomBytes(300_000);
    alice.send([new File([fresh], 'fresh.bin')]);
    await waitFor(() => rows(bob, 'in').length === 2);
    acceptAll(bob);
    await waitFor(() => rows(bob, 'in').find((r) => r.name === 'fresh.bin').status === S.DONE, {
      label: 'new file',
    });
    assert.ok(sinks.get('fresh.bin').data.equals(fresh));
  });

  test('tells the UI when it had to stop the session itself', async () => {
    const manager = new TransferManager();
    const [mine, attacker] = channelPair();
    let reason = null;
    manager.on('stopped', (why) => (reason = why));
    manager.attach(mine);
    attacker.send(JSON.stringify({ t: 'sync', v: 999 }));
    await waitFor(() => reason !== null, { label: 'stopped event' });
    assert.match(reason, /different version/);
  });
});

describe('TransferManager against a malicious peer', () => {
  /** A victim manager plus a raw channel the attacker writes to directly. */
  async function victim() {
    const sinks = [];
    const manager = new TransferManager({
      createSink: ({ row }) => {
        const sink = new TestSink();
        sink.row = row;
        sinks.push(sink);
        return sink;
      },
    });
    const [mine, attacker] = channelPair();
    const received = [];
    attacker.addEventListener('message', (e) => received.push(e.data));
    manager.attach(mine);
    const send = (msg) => attacker.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    send({ t: TransferMessage.SYNC, v: 3, partial: [], done: [], decided: [] });
    await sleep(20);
    return { manager, sinks, send, attacker, received };
  }

  test('sanitizes traversal paths and ignores malformed offers', async () => {
    const { manager, send } = await victim();
    send('not json');
    send('null');
    send({ t: 'offer', batchId: '../x', files: [{ id: 'a', name: 'x', size: 1 }] });
    send({ t: 'offer', batchId: 'b1', files: [{ id: 'a', name: 'x', size: -5 }] });
    send({ t: 'offer', batchId: 'b2', files: [{ id: 'a', name: 'x', size: 2 ** 60 }] });
    send({
      t: 'offer',
      batchId: 'b3',
      files: new Array(TransferLimits.MAX_FILES_PER_OFFER + 1).fill({ id: 'z', size: 1 }),
    });
    send({ t: '__proto__', id: 'x' });
    send({
      t: 'offer',
      batchId: 'ok',
      files: [
        { id: 'f1', name: 'x', path: '../../../Windows/System32/evil.dll', size: 3 },
        { id: 'f2', name: '<script>alert(1)</script>', size: 3 },
        { id: 'f3', path: 'CON', size: 3 },
      ],
    });
    await sleep(30);
    const list = rows(manager, 'in');
    assert.deepEqual(
      list.map((r) => r.path),
      // "/" inside a name is a folder separator, so the "script" tag becomes two harmless folders.
      ['Windows/System32/evil.dll', '_script_alert(1)_/script_', '_CON'],
    );
    assert.ok(list.every((r) => r.status === S.OFFERED));
  });

  test('never writes data for a batch the user has not accepted', async () => {
    const { manager, sinks, send, attacker } = await victim();
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 4 }] });
    await sleep(10);
    send({ t: 'start', id: 'f', offset: 0, slot: 0 });
    attacker.send(encodeFrame(0, 0, new Uint8Array([1, 2, 3, 4])));
    send({ t: 'end', id: 'f', sha256: '0' });
    await sleep(30);
    assert.equal(sinks.length, 0);
    assert.equal(rows(manager, 'in')[0].status, S.OFFERED);
  });

  test('fails a file when the peer sends more bytes than announced', async () => {
    const { manager, sinks, send, attacker, received } = await victim();
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 4 }] });
    await sleep(10);
    manager.accept('b');
    send({ t: 'start', id: 'f', offset: 0, slot: 0 });
    attacker.send(encodeFrame(0, 0, new Uint8Array(10)));
    await waitFor(() => rows(manager, 'in')[0].status === S.FAILED, { label: 'failed' });
    await waitFor(() => sinks[0].aborted, { label: 'discarded' });
    await waitFor(
      () =>
        received.some(
          (m) => typeof m === 'string' && JSON.parse(m).t === 'ack' && JSON.parse(m).ok === false,
        ),
      { label: 'negative ack' },
    );
  });

  test('stops on an incompatible protocol version', async () => {
    const sinks = [];
    const manager = new TransferManager({ createSink: () => sinks[sinks.length] });
    const [mine, attacker] = channelPair();
    manager.attach(mine);
    manager.send([new File(['x'], 'x.txt')]);
    attacker.send(JSON.stringify({ t: 'sync', v: 999 }));
    await sleep(20);
    assert.equal(rows(manager, 'out')[0].status, S.FAILED);
    assert.match(rows(manager, 'out')[0].error, /different version/);
  });

  test('frames that overtake their start are held, then used', async () => {
    const { manager, sinks, send, attacker } = await victim();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 6 }] });
    await sleep(10);
    manager.accept('b');
    attacker.send(encodeFrame(3, 3, data.subarray(3))); // second half first, before its start
    attacker.send(encodeFrame(3, 0, data.subarray(0, 3)));
    send({ t: 'start', id: 'f', offset: 0, slot: 3 });
    send({ t: 'end', id: 'f', sha256: createHash('sha256').update(data).digest('hex') });
    await waitFor(() => rows(manager, 'in')[0].status === S.DONE, { label: 'done' });
    assert.deepEqual([...sinks[0].data], [...data]);
  });

  test('ignores stale slots, duplicate frames and frames for files it never started', async () => {
    const { manager, sinks, send, attacker } = await victim();
    const data = new Uint8Array([9, 8, 7, 6]);
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 4 }] });
    await sleep(10);
    manager.accept('b');
    send({ t: 'start', id: 'f', offset: 0, slot: 5 });
    send({ t: 'start', id: 'f', offset: 0, slot: 4 }); // replayed / older slot: ignored
    attacker.send(encodeFrame(2, 0, new Uint8Array([6, 6, 6, 6]))); // older slot: dropped
    attacker.send(encodeFrame(5, 0, data.subarray(0, 2)));
    attacker.send(encodeFrame(5, 0, data.subarray(0, 2))); // duplicate
    attacker.send(encodeFrame(5, 2, data.subarray(2)));
    send({ t: 'end', id: 'f', sha256: createHash('sha256').update(data).digest('hex') });
    await waitFor(() => rows(manager, 'in')[0].status === S.DONE, { label: 'done' });
    assert.deepEqual([...sinks[0].data], [...data]);
  });

  test('stops when the peer floods frames for slots it never starts', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 64 * 1024 };
    const manager = new TransferManager({ limits, createSink: () => new TestSink() });
    const [mine, attacker] = channelPair();
    manager.attach(mine);
    manager.send([new File(['x'], 'x.txt')]);
    attacker.send(JSON.stringify({ t: TransferMessage.SYNC, v: 3, partial: [], done: [], decided: [] }));
    for (let i = 0; i < 4; i++) attacker.send(encodeFrame(100, i * 50_000, new Uint8Array(50_000)));
    await waitFor(() => rows(manager, 'out')[0].status === S.FAILED, { label: 'stopped' });
    assert.match(rows(manager, 'out')[0].error, /faster than allowed/);
  });
  test('bounds buffered data across all files, not just per file', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 64 * 1024 };
    const manager = new TransferManager({ limits, createSink: () => new TestSink() });
    const [mine, attacker] = channelPair();
    manager.attach(mine);
    const send = (msg) => attacker.send(JSON.stringify(msg));
    send({ t: 'sync', v: 3, partial: [], done: [], decided: [] });
    const files = [0, 1, 2].map((i) => ({ id: `f${i}`, name: `f${i}.bin`, size: 1024 * 1024 }));
    send({ t: 'offer', batchId: 'b', files });
    await sleep(20);
    manager.accept('b');
    // Each file alone stays under the per-file bound; together they exceed the session's.
    for (let i = 0; i < 3; i++) {
      send({ t: 'start', id: `f${i}`, offset: 0, slot: i });
      attacker.send(encodeFrame(i, 60_000, new Uint8Array(50_000)));
    }
    await waitFor(() => rows(manager, 'in').every((r) => r.status === S.FAILED), { label: 'stopped' });
    assert.match(rows(manager, 'in')[0].error, /faster than allowed/);
  });

  test('many tiny out-of-order frames are charged their bookkeeping cost', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 64 * 1024 };
    const manager = new TransferManager({ limits, createSink: () => new TestSink() });
    const [mine, attacker] = channelPair();
    manager.attach(mine);
    const send = (msg) => attacker.send(JSON.stringify(msg));
    send({ t: 'sync', v: 3, partial: [], done: [], decided: [] });
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 1024 * 1024 }] });
    await sleep(20);
    manager.accept('b');
    send({ t: 'start', id: 'f', offset: 0, slot: 0 });
    // 300 one-byte frames: only 300 bytes, but ~300 KB of bookkeeping.
    for (let i = 1; i <= 300; i++) attacker.send(encodeFrame(0, i * 2, new Uint8Array(1)));
    await waitFor(() => rows(manager, 'in')[0].status === S.FAILED, { label: 'failed' });
  });

  test('a sender stops streaming as soon as the receiver reports a failure', async () => {
    const limits = { ...TransferLimits, WINDOW_BYTES: 256 * 1024 };
    const manager = new TransferManager({ limits });
    const [mine, attacker] = channelPair();
    let frames = 0;
    let start = null;
    attacker.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') frames++;
      else if (JSON.parse(e.data).t === 'start') start = JSON.parse(e.data);
    });
    manager.attach(mine);
    manager.send([new File([new Uint8Array(4 * 1024 * 1024)], 'big.bin')]);
    const send = (msg) => attacker.send(JSON.stringify(msg));
    send({ t: 'sync', v: 3, partial: [], done: [], decided: [] });
    await waitFor(() => rows(manager, 'out')[0].status === S.AWAITING);
    send({ t: 'answer', batchId: rows(manager, 'out')[0].batchId, accept: true });
    await waitFor(() => start !== null && frames > 0, { label: 'streaming' });
    // The receiver's disk is full: it fails the file without confirming progress.
    send({ t: 'ack', id: start.id, ok: false, verified: false, error: 'Disk full' });
    await waitFor(() => rows(manager, 'out')[0].status === S.FAILED, { label: 'failed' });
    const framesAtFailure = frames;
    await sleep(100);
    assert.ok(
      frames - framesAtFailure <= 1,
      `kept streaming after the failure (${frames - framesAtFailure})`,
    );
    assert.equal(rows(manager, 'out')[0].status, S.FAILED, 'a failed file never turns active again');
  });

  test('a lane it refuses is closed, so the peer never sends into the void', () => {
    const manager = new TransferManager();
    const [lane] = channelPair();
    assert.equal(manager.addLane(lane), false, 'no main channel yet');
    assert.equal(lane.readyState, 'closed');
  });

  test('a file resent after it was already saved gets its result repeated (the sender never hangs)', async () => {
    const { manager, send, attacker, received } = await victim();
    const data = new Uint8Array([4, 5, 6]);
    const sha256 = createHash('sha256').update(data).digest('hex');
    send({ t: 'offer', batchId: 'b', files: [{ id: 'f', name: 'f.bin', size: 3 }] });
    await sleep(10);
    manager.accept('b');
    send({ t: 'start', id: 'f', offset: 0, slot: 0 });
    attacker.send(encodeFrame(0, 0, data));
    send({ t: 'end', id: 'f', sha256 });
    await waitFor(() => rows(manager, 'in')[0].status === S.DONE, { label: 'saved' });
    received.length = 0;
    // The sender never got the result (its link died) and starts the file again.
    send({ t: 'start', id: 'f', offset: 0, slot: 1 });
    await waitFor(
      () =>
        received.some((m) => typeof m === 'string' && JSON.parse(m).t === 'ack' && JSON.parse(m).ok === true),
      { label: 'repeated ack' },
    );
    assert.equal(rows(manager, 'in')[0].status, S.DONE, 'still done, nothing re-received');
  });

  test('messages without a known type are ignored and never answered (no reply loops)', async () => {
    const { send, received } = await victim();
    received.length = 0;
    send({ id: 'x', ok: false }); // no type at all
    send({ t: 'not-a-type', id: 'x' });
    send({ t: 42 });
    await sleep(50);
    assert.equal(received.length, 0, 'nothing was sent back');
  });
});
