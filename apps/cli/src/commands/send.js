import { createReadStream } from 'node:fs';
import net from 'node:net';
import { announce } from '../core/discovery.js';
import { AuthError } from '../core/errors.js';
import { performHandshake } from '../core/handshake.js';
import { FrameReader } from '../core/framing.js';
import { MessageType, encodeJson, expectMessage, writeMessage } from '../core/messages.js';
import { generateTransferCode, parseTransferCode } from '../core/transfer-code.js';
import { collectFiles } from '../utils/files.js';
import { lanAddresses } from '../utils/network.js';
import { colors, createReporter, formatBytes, formatDuration } from '../utils/terminal.js';

const CHUNK_BYTES = 256 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DECISION_TIMEOUT_MS = 10 * 60_000;
const IDLE_TIMEOUT_MS = 60_000;
/** Wrong-code attempts tolerated before the transfer is stopped (each attempt is one online guess). */
const MAX_FAILED_ATTEMPTS = 5;
/** Handshakes in progress at once; extra connections are dropped (resource-exhaustion guard). */
const MAX_PENDING_HANDSHAKES = 4;
/** An unused code stops working after this long, so an old code can't be used later. */
const CODE_LIFETIME_MS = 30 * 60_000;

/**
 * Shares files: listens on TCP, announces itself on the LAN, and streams the files to the first
 * receiver that proves it knows the code.
 *
 * @returns {Promise<{ status: 'done' | 'rejected', files?: number, bytes?: number, seconds?: number }>}
 */
export async function sendFiles(inputs, options = {}) {
  const {
    port = 0,
    quiet = false,
    discovery = true,
    code = generateTransferCode(),
    onReady,
    maxFailedAttempts = MAX_FAILED_ATTEMPTS,
    codeLifetimeMs = CODE_LIFETIME_MS,
  } = options;

  const ui = createReporter({ quiet });
  const files = await collectFiles(inputs);
  if (files.length === 0) throw new Error('Nothing to send: the folders you gave are empty.');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const { nameplate } = parseTransferCode(code);

  const server = net.createServer();
  const listeningPort = await listen(server, port);
  const stopAnnouncing = discovery ? announce({ nameplate, port: listeningPort }) : () => {};

  printReady(ui, { code, files, totalBytes, port: listeningPort });
  onReady?.({ code, port: listeningPort });

  try {
    const result = await serveFirstReceiver(server, {
      code,
      files,
      totalBytes,
      ui,
      maxFailedAttempts,
      codeLifetimeMs,
      onClaimed: stopAnnouncing,
    });
    if (result.status === 'rejected') ui.warn('The receiver declined the transfer.');
    else
      ui.success(
        `Sent ${result.files} file(s), ${formatBytes(result.bytes)} in ${formatDuration(result.seconds)}.`,
      );
    return result;
  } finally {
    stopAnnouncing();
    server.close();
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function printReady(ui, { code, files, totalBytes, port }) {
  const addresses = lanAddresses();
  ui.info();
  ui.info(`${colors.bold('Hopline')} · ready to send ${files.length} file(s), ${formatBytes(totalBytes)}`);
  ui.info();
  ui.info(`  Code: ${colors.bold(colors.cyan(code))}`);
  ui.info();
  ui.info('On the other computer, run:');
  ui.info(`  ${colors.bold(`hopline receive ${code}`)}`);
  if (addresses.length > 0) {
    ui.info(colors.dim(`If it can't find this computer, add: --host ${addresses[0]}:${port}`));
  }
  ui.info();
  ui.info(colors.dim('Waiting for the receiver… (Ctrl+C to cancel)'));
}

/**
 * Accepts connections until one authenticates.
 *  - Only real wrong-code attempts count toward the limit (each is one online guess thanks to the PAKE);
 *    junk connections are dropped without counting, so they can't be used to abort a transfer.
 *  - Another transfer on the LAN may share the same number, so a wrong code doesn't end the session at once.
 *  - The code expires if nobody claims it in time.
 */
function serveFirstReceiver(server, context) {
  return new Promise((resolve, reject) => {
    let claimed = false;
    let failures = 0;
    let pending = 0;

    const expiry = setTimeout(() => {
      if (!claimed)
        reject(new Error('Nobody connected in time, so this code has expired. Start a new transfer.'));
    }, context.codeLifetimeMs);
    expiry.unref();

    server.on('connection', async (socket) => {
      socket.on('error', () => {});
      socket.setNoDelay(true);
      socket.on('timeout', () => socket.destroy(new Error('The receiver stopped responding.')));
      if (claimed || pending >= MAX_PENDING_HANDSHAKES) return socket.destroy();

      pending++;
      let session;
      try {
        session = await authenticate(socket, context.code);
      } catch (err) {
        socket.destroy();
        if (err instanceof AuthError) {
          failures++;
          context.ui.warn(`Rejected a device at ${socket.remoteAddress}: wrong code.`);
          if (failures >= context.maxFailedAttempts) {
            clearTimeout(expiry);
            reject(new Error('Too many wrong-code attempts, so the transfer was stopped. Start a new one.'));
          }
        }
        return;
      } finally {
        pending--;
      }

      if (claimed) return socket.destroy();
      claimed = true;
      clearTimeout(expiry);
      context.onClaimed();

      try {
        resolve(await streamFiles(socket, session, context));
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
  });
}

async function authenticate(socket, code) {
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
  const reader = new FrameReader(socket);
  const cipher = await performHandshake({ socket, reader, role: 'sender', code });
  await expectMessage(reader, cipher, MessageType.HELLO);
  return { reader, cipher };
}

async function streamFiles(socket, { reader, cipher }, { files, totalBytes, ui }) {
  ui.info(`Connected to ${socket.remoteAddress}. Waiting for them to accept…`);

  socket.setTimeout(DECISION_TIMEOUT_MS);
  const manifest = { files: files.map((f) => ({ path: f.relative, size: f.size })), total: totalBytes };
  await writeMessage(socket, cipher, MessageType.MANIFEST, encodeJson(manifest));

  const answer = await expectMessage(reader, cipher, MessageType.ACCEPT, MessageType.REJECT);
  if (answer.type === MessageType.REJECT) {
    await new Promise((resolve) => socket.end(resolve));
    return { status: 'rejected' };
  }

  socket.setTimeout(IDLE_TIMEOUT_MS);
  const progress = ui.progress(totalBytes, 'Sending  ');
  for (const file of files) {
    let sent = 0;
    for await (const chunk of createReadStream(file.absolute, { highWaterMark: CHUNK_BYTES })) {
      sent += chunk.length;
      if (sent > file.size) throw new Error(`"${file.relative}" grew while it was being sent. Try again.`);
      await writeMessage(socket, cipher, MessageType.CHUNK, chunk);
      progress.advance(chunk.length);
    }
    if (sent !== file.size) throw new Error(`"${file.relative}" shrank while it was being sent. Try again.`);
  }

  await writeMessage(socket, cipher, MessageType.DONE);
  await expectMessage(reader, cipher, MessageType.DONE);
  const seconds = progress.finish();
  await new Promise((resolve) => socket.end(resolve));
  return { status: 'done', files: files.length, bytes: totalBytes, seconds };
}
