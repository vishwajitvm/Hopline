import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { receiveFiles } from '../src/commands/receive.js';
import { sendFiles } from '../src/commands/send.js';

/** Starts a sender (no LAN broadcast) and resolves once it is listening. */
function startSender(inputs, options = {}) {
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));
  const done = sendFiles(inputs, { quiet: true, discovery: false, onReady: ready, ...options });
  return { done, ready: readyPromise };
}

describe('send → receive over localhost', () => {
  let workdir;
  let source;

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'hopline-test-'));
    source = join(workdir, 'source');
    await mkdir(join(source, 'album', 'nested'), { recursive: true });
    await writeFile(join(source, 'big.bin'), randomBytes(3 * 1024 * 1024 + 123)); // spans many chunks
    await writeFile(join(source, 'empty.txt'), '');
    await writeFile(join(source, 'album', 'a.txt'), 'first');
    await writeFile(join(source, 'album', 'nested', 'b.txt'), 'second');
  });

  after(() => rm(workdir, { recursive: true, force: true }));

  test('transfers files and folders intact', async () => {
    const out = join(workdir, 'out1');
    const sender = startSender([join(source, 'big.bin'), join(source, 'empty.txt'), join(source, 'album')]);
    const { code, port } = await sender.ready;

    const received = await receiveFiles(code, {
      host: `127.0.0.1:${port}`,
      outDir: out,
      autoAccept: true,
      quiet: true,
    });
    const sent = await sender.done;

    assert.equal(sent.status, 'done');
    assert.equal(received.status, 'done');
    assert.equal(received.files.length, 4);
    assert.deepEqual(await readFile(join(out, 'big.bin')), await readFile(join(source, 'big.bin')));
    assert.equal(await readFile(join(out, 'empty.txt'), 'utf8'), '');
    assert.equal(await readFile(join(out, 'album', 'nested', 'b.txt'), 'utf8'), 'second');
    assert.ok(!(await readdir(out)).some((name) => name.endsWith('.hopline-part')));
  });

  test('never overwrites existing files', async () => {
    const out = join(workdir, 'out2');
    await mkdir(out);
    await writeFile(join(out, 'empty.txt'), 'keep me');
    const sender = startSender([join(source, 'empty.txt')]);
    const { code, port } = await sender.ready;
    await receiveFiles(code, { host: `127.0.0.1:${port}`, outDir: out, autoAccept: true, quiet: true });
    await sender.done;
    assert.equal(await readFile(join(out, 'empty.txt'), 'utf8'), 'keep me');
    assert.equal(await readFile(join(out, 'empty (1).txt'), 'utf8'), '');
  });

  test('receiver can decline', async () => {
    const sender = startSender([join(source, 'empty.txt')]);
    const { code, port } = await sender.ready;
    const result = await receiveFiles(code, {
      host: `127.0.0.1:${port}`,
      outDir: join(workdir, 'out3'),
      decide: async () => false,
      quiet: true,
    });
    assert.equal(result.status, 'rejected');
    assert.equal((await sender.done).status, 'rejected');
  });

  test('a wrong code is rejected and the sender gives up after too many attempts', async () => {
    const sender = startSender([join(source, 'empty.txt')], { maxFailedAttempts: 1 });
    const senderOutcome = sender.done.then(
      () => 'resolved',
      (err) => err.message,
    );
    const { port } = await sender.ready;
    await assert.rejects(
      receiveFiles('11-wrong-code-here', {
        host: `127.0.0.1:${port}`,
        outDir: join(workdir, 'out4'),
        quiet: true,
      }),
      /didn't accept this code/,
    );
    assert.match(await senderOutcome, /Too many wrong-code attempts/);
  });

  test('junk connections are dropped without counting as guesses', async () => {
    const sender = startSender([join(source, 'empty.txt')], { maxFailedAttempts: 1 });
    const { code, port } = await sender.ready;
    for (const junk of [Buffer.from('GET / HTTP/1.1\r\n\r\n'), randomBytes(500), Buffer.alloc(0)]) {
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.end(junk));
        socket.resume(); // read (and discard) the sender's greeting so the socket can close
        socket.on('close', resolve);
        socket.on('error', resolve);
      });
    }
    const out = join(workdir, 'out5');
    const received = await receiveFiles(code, {
      host: `127.0.0.1:${port}`,
      outDir: out,
      autoAccept: true,
      quiet: true,
    });
    assert.equal(received.status, 'done');
    assert.equal((await sender.done).status, 'done');
  });

  test('without --out, files land in a new dated folder', async () => {
    const sender = startSender([join(source, 'album')]);
    const { code, port } = await sender.ready;
    const cwd = process.cwd();
    process.chdir(workdir);
    try {
      const received = await receiveFiles(code, { host: `127.0.0.1:${port}`, autoAccept: true, quiet: true });
      assert.match(received.folder, /Hopline \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
      assert.equal(await readFile(join(received.folder, 'album', 'a.txt'), 'utf8'), 'first');
    } finally {
      process.chdir(cwd);
    }
    await sender.done;
  });
});
