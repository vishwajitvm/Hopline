#!/usr/bin/env node
/**
 * End-to-end CLI throughput benchmark: generates a file, sends it with the Hopline CLI over loopback TCP
 * (CPace handshake, AES-256-GCM, real disk reads and writes), then proves the copy is byte-identical with
 * SHA-256. Cleans up after itself.
 *
 *   npm run bench:cli            # 2 GiB
 *   npm run bench:cli -- 10      # 10 GiB (needs ~20 GiB free in the temp folder)
 *
 * Loopback measures the software (crypto + disk) ceiling. Over a real network the link is usually the limit:
 * run `hopline send` / `hopline receive` on two machines to measure that.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GiB = 1024 ** 3;
const sizeGiB = Number(process.argv[2] ?? 2);
if (!(sizeGiB > 0 && sizeGiB <= 100)) {
  console.error('Usage: npm run bench:cli -- <GiB, 1-100>');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'hopline-bench-'));
const source = join(work, 'bench.bin');
const outDir = join(work, 'out');

const seconds = (since) => (Date.now() - since) / 1000;
const hashFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path, { highWaterMark: 8 << 20 })
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
const findFile = (dir, name) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return null;
};
const cli = (args) =>
  spawn(process.execPath, [join(root, 'apps/cli/bin/hopline.js'), ...args], { cwd: root });

try {
  let started = Date.now();
  const fd = openSync(source, 'w');
  const block = randomBytes(16 << 20);
  for (let i = 0; i < (sizeGiB * GiB) / block.length; i++) {
    block.writeUInt32LE(i, 0); // every block differs, so a misplaced block changes the hash
    writeSync(fd, block);
  }
  closeSync(fd);
  console.log(`Generated ${sizeGiB} GiB in ${seconds(started).toFixed(1)} s`);

  const sender = cli(['send', source, '--port', '0']);
  let senderOutput = '';
  const code = await new Promise((resolve, reject) => {
    sender.stdout.on('data', (data) => {
      senderOutput += data;
      const match = senderOutput.match(/\d+-[a-z]+-[a-z]+-[a-z]+/);
      if (match) resolve(match[0]);
    });
    sender.on('exit', () => reject(new Error(`sender exited:\n${senderOutput}`)));
  });
  const port = senderOutput.match(/:(\d{2,5})\b/)?.[1];

  started = Date.now();
  const receiver = cli([
    'receive',
    code,
    '--yes',
    '--out',
    outDir,
    ...(port ? ['--host', `127.0.0.1:${port}`] : []),
  ]);
  let receiverOutput = '';
  receiver.stdout.on('data', (data) => (receiverOutput += data));
  receiver.stderr.on('data', (data) => (receiverOutput += data));
  const exitCode = await new Promise((resolve) => receiver.on('exit', resolve));
  const took = seconds(started);
  sender.kill();
  if (exitCode !== 0) throw new Error(`receiver failed:\n${receiverOutput}`);

  const mib = sizeGiB * 1024;
  console.log(`Transferred ${sizeGiB} GiB in ${took.toFixed(1)} s = ${(mib / took).toFixed(0)} MiB/s`);
  console.log(`At this rate 10 GiB takes ${((10 * 1024) / (mib / took)).toFixed(0)} s`);

  const received = findFile(outDir, 'bench.bin');
  const [a, b] = await Promise.all([hashFile(source), hashFile(received)]);
  console.log(`SHA-256 sent     ${a}\nSHA-256 received ${b}`);
  if (a !== b) throw new Error('MISMATCH: the received file differs');
  console.log('Byte-identical: nothing lost.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
