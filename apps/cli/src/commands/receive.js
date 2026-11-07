import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { discoverSender } from '../core/discovery.js';
import { AuthError, ConnectionClosedError, ProtocolError } from '../core/errors.js';
import { FrameReader } from '../core/framing.js';
import { performHandshake } from '../core/handshake.js';
import { MessageType, decodeJson, encodeJson, expectMessage, writeMessage } from '../core/messages.js';
import { parseTransferCode } from '../core/transfer-code.js';
import { describeRisk, toSafePathSegments } from '../utils/files.js';
import { SafeFileWriter } from '../utils/safe-write.js';
import { parseHostPort } from '../utils/network.js';
import { colors, confirm, createReporter, formatBytes, formatDuration } from '../utils/terminal.js';

const CONNECT_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_SENDERS_TO_TRY = 10;
const MAX_MANIFEST_FILES = 100_000;
const PREVIEW_FILES = 20;

/** A new folder per transfer, e.g. "Hopline 2026-11-06 18-30-12", so a sender can't touch existing files. */
function defaultOutputFolder(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return resolve(`Hopline ${stamp}`);
}

/**
 * Receives files for `code`: finds the sender on the LAN (or uses `host`), authenticates,
 * asks for confirmation, and writes the files into `outDir` (default: a new folder per transfer).
 *
 * @returns {Promise<{ status: 'done' | 'rejected', files?: string[], bytes?: number, seconds?: number, folder?: string }>}
 */
export async function receiveFiles(codeInput, options = {}) {
  const { outDir, host, autoAccept = false, quiet = false, discoveryTimeoutMs = 60_000, decide } = options;
  const ui = createReporter({ quiet });
  const { code, nameplate } = parseTransferCode(codeInput);
  const outputRoot = outDir ? resolve(outDir) : defaultOutputFolder();

  const tried = new Set();
  for (let attempt = 1; attempt <= MAX_SENDERS_TO_TRY; attempt++) {
    let target;
    if (host) {
      target = parseHostPort(host);
    } else {
      ui.info(attempt === 1 ? 'Looking for the sender on your network…' : 'Looking for another sender…');
      target = await discoverSender(nameplate, { timeoutMs: discoveryTimeoutMs, exclude: tried });
    }

    try {
      return await receiveFrom(target, { code, outputRoot, ui, autoAccept, decide });
    } catch (err) {
      const notOurSender = err instanceof AuthError || err.unreachable === true;
      if (!notOurSender || host) {
        if (host && err instanceof AuthError) {
          throw new Error(`The sender at ${host} didn't accept this code. Double-check it and try again.`);
        }
        throw err;
      }
      // Another transfer (or an impostor) on the LAN can share the same number; skip it and keep looking.
      tried.add(`${target.host}:${target.port}`);
      ui.warn(`${target.host} isn't the sender for this code; looking further.`);
    }
  }
  throw new Error('Could not find a sender that matches this code.');
}

function connect({ host, port }) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    const fail = (err) => {
      socket.destroy();
      const error = new Error(
        err.code === 'ECONNREFUSED'
          ? `Nothing is listening at ${host}:${port}. Is the sender still running?`
          : `Couldn't connect to ${host}:${port}: ${err.message}`,
      );
      error.unreachable = true;
      reject(error);
    };
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('timed out')));
    socket.once('connect', () => {
      socket.off('error', fail);
      socket.removeAllListeners('timeout');
      socket.setTimeout(0);
      socket.setNoDelay(true);
      resolvePromise(socket);
    });
  });
}

async function receiveFrom(target, context) {
  const socket = await connect(target);
  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy(new Error('The sender stopped responding.')));

  try {
    const { reader, cipher, manifest } = await authenticate(socket, context.code);
    return await receiveManifest(socket, reader, cipher, manifest, context, target);
  } finally {
    socket.destroy();
  }
}

const CONNECTION_DROPPED = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * Proves we know the code (HELLO) and waits for the sender's proof (an encrypted MANIFEST).
 * A sender with a different code simply hangs up, so a closed connection here means "not our sender".
 */
async function authenticate(socket, code) {
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
  const reader = new FrameReader(socket);
  try {
    const cipher = await performHandshake({ socket, reader, role: 'receiver', code });
    await writeMessage(socket, cipher, MessageType.HELLO, encodeJson({ v: 2 }));
    const { body } = await expectMessage(reader, cipher, MessageType.MANIFEST);
    return { reader, cipher, manifest: parseManifest(body) };
  } catch (err) {
    if (err instanceof ConnectionClosedError || CONNECTION_DROPPED.has(err.code)) {
      throw new AuthError('The sender closed the connection.');
    }
    throw err;
  }
}

const endSocket = (socket) => new Promise((resolveEnd) => socket.end(resolveEnd));

function parseManifest(body) {
  const manifest = decodeJson(body);
  if (!Array.isArray(manifest?.files) || manifest.files.length > MAX_MANIFEST_FILES) {
    throw new ProtocolError('The sender sent an invalid file list.');
  }
  let total = 0;
  const files = manifest.files.map((file) => {
    if (!Number.isSafeInteger(file?.size) || file.size < 0) {
      throw new ProtocolError('Invalid file size in file list.');
    }
    total += file.size;
    const segments = toSafePathSegments(file.path);
    return { display: segments.join('/'), segments, size: file.size };
  });
  if (!Number.isSafeInteger(total)) throw new ProtocolError('The file list is too large.');
  return { files, total };
}

async function receiveManifest(socket, reader, cipher, manifest, context, target) {
  const { ui, outputRoot } = context;
  printManifest(ui, manifest, target.host, outputRoot);

  socket.setTimeout(0); // a human is deciding; don't time out under them
  const accepted = context.autoAccept || (await (context.decide ?? defaultDecision)(manifest));
  if (!accepted) {
    await writeMessage(socket, cipher, MessageType.REJECT);
    await endSocket(socket);
    if (!context.autoAccept && !process.stdin.isTTY && !context.decide) {
      ui.warn('No terminal to ask for confirmation. Re-run with --yes to accept automatically.');
    }
    return { status: 'rejected' };
  }

  await mkdir(outputRoot, { recursive: true });
  socket.setTimeout(IDLE_TIMEOUT_MS);
  await writeMessage(socket, cipher, MessageType.ACCEPT);

  const progress = ui.progress(manifest.total, 'Receiving');
  const saved = [];
  for (const file of manifest.files) {
    saved.push(await receiveFile(reader, cipher, file, outputRoot, progress));
  }

  await expectMessage(reader, cipher, MessageType.DONE);
  await writeMessage(socket, cipher, MessageType.DONE);
  const seconds = progress.finish();
  await endSocket(socket);

  ui.success(
    `Received ${saved.length} file(s), ${formatBytes(manifest.total)} in ${formatDuration(seconds)}.`,
  );
  ui.info(`Saved to ${colors.bold(outputRoot)}`);
  return { status: 'done', files: saved, bytes: manifest.total, seconds, folder: outputRoot };
}

function printManifest(ui, { files, total }, host, outputRoot) {
  ui.info();
  ui.info(`${colors.bold(host)} wants to send ${files.length} file(s), ${formatBytes(total)}:`);
  for (const file of files.slice(0, PREVIEW_FILES)) {
    ui.info(`  ${file.display} ${colors.dim(`(${formatBytes(file.size)})`)}`);
  }
  if (files.length > PREVIEW_FILES) ui.info(colors.dim(`  …and ${files.length - PREVIEW_FILES} more`));
  const risk = describeRisk(files);
  if (risk) ui.warn(risk);
  ui.info(colors.dim(`They will be saved in: ${outputRoot}`));
}

const defaultDecision = () => confirm('Accept these files?');

/**
 * Streams one file into a fresh, exclusively-created temporary file and moves it into place only after
 * every byte arrived, so an interrupted transfer never leaves a truncated file that looks complete.
 */
async function receiveFile(reader, cipher, file, outputRoot, progress) {
  const output = new SafeFileWriter(outputRoot, file.segments);
  try {
    await output.open();
    let remaining = file.size;
    while (remaining > 0) {
      const { body } = await expectMessage(reader, cipher, MessageType.CHUNK);
      if (body.length > remaining) {
        throw new ProtocolError(`The sender sent too much data for "${file.display}".`);
      }
      await output.write(body);
      remaining -= body.length;
      progress.advance(body.length);
    }
    return await output.commit();
  } catch (err) {
    await output.abort();
    throw err;
  }
}
