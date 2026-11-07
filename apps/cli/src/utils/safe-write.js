import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, relative, sep } from 'node:path';
import { ProtocolError } from '../core/errors.js';
import { candidateName } from './files.js';

export const PART_SUFFIX = '.hopline-part';

/** Refuses to write through a symbolic link planted inside the output folder. */
export async function assertNoSymlinks(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new ProtocolError(`Refusing to write through a symbolic link: ${relative(root, current)}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  }
}

/** Moves the finished file into place without ever overwriting an existing file ("name (1).ext" etc.). */
export async function commitWithoutOverwrite(partPath, desiredPath) {
  for (let i = 0; i < 10_000; i++) {
    const candidate = candidateName(desiredPath, i);
    try {
      await link(partPath, candidate); // atomic, fails if the name exists
      await rm(partPath, { force: true });
      return candidate;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EISDIR'].includes(err.code)) {
        // File systems without hard links (FAT/exFAT): best-effort check-then-rename.
        try {
          await lstat(candidate);
          continue;
        } catch {
          await rename(partPath, candidate);
          return candidate;
        }
      }
      throw err;
    }
  }
  throw new Error(`Too many files named like "${desiredPath}".`);
}

/**
 * One incoming file, written safely under `root`:
 *  - `segments` must already be sanitised (see toSafePathSegments); the result must stay inside `root`;
 *  - no symbolic links on the way; parent folders are created;
 *  - bytes go to a fresh, exclusively created hidden temp file;
 *  - `commit()` moves it into place without overwriting anything; `abort()` deletes it.
 */
export class SafeFileWriter {
  #root;
  #segments;
  #partPath = null;
  #desiredPath;
  #stream = null;
  #aborted = false;
  bytesWritten = 0;

  constructor(root, segments) {
    this.#root = root;
    this.#segments = segments;
    this.#desiredPath = join(root, ...segments);
    const rel = relative(root, this.#desiredPath);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new ProtocolError('Refusing to write outside the output folder.');
    }
  }

  async open() {
    await assertNoSymlinks(this.#root, this.#segments.slice(0, -1));
    await mkdir(dirname(this.#desiredPath), { recursive: true });
    this.#partPath = join(dirname(this.#desiredPath), `.${randomBytes(8).toString('hex')}${PART_SUFFIX}`);
    if (this.#aborted) throw new Error('Cancelled.');
    const stream = createWriteStream(this.#partPath, { flags: 'wx' });
    this.#stream = stream;
    await once(stream, 'open');
    if (this.#aborted) {
      // abort() ran while we were opening: it couldn't see the file yet, so clean up here.
      stream.destroy();
      await rm(this.#partPath, { force: true }).catch(() => {});
      throw new Error('Cancelled.');
    }
  }

  /** Writes with backpressure. */
  async write(bytes) {
    const stream = this.#stream;
    if (!stream) throw new Error('The file was closed.');
    // Wait for room, or for the stream to go away (a destroyed stream never emits 'drain').
    if (!stream.write(bytes)) await Promise.race([once(stream, 'drain'), once(stream, 'close')]);
    if (this.#aborted) throw new Error('Cancelled.');
    this.bytesWritten += bytes.length;
  }

  /** Finishes the file; returns the final path (maybe "name (1).ext"). */
  async commit() {
    const stream = this.#stream;
    this.#stream = null;
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    return commitWithoutOverwrite(this.#partPath, this.#desiredPath);
  }

  /** Deletes what was written. Never throws. */
  async abort() {
    this.#aborted = true;
    const stream = this.#stream;
    this.#stream = null;
    if (stream) {
      stream.destroy();
      await once(stream, 'close').catch(() => {});
    }
    if (this.#partPath) await rm(this.#partPath, { force: true }).catch(() => {});
  }
}
