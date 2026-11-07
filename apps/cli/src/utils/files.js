import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

/**
 * Expands the paths given on the command line into a flat list of files.
 * Folders are walked recursively and keep their structure ("photos/2024/a.jpg").
 * Symlinks and special files are skipped so we never follow a link outside the folder.
 */
export async function collectFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const absolute = resolve(input);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new Error(`Can't find "${input}".`);
    }
    if (info.isFile()) files.push({ absolute, relative: basename(absolute), size: info.size });
    else if (info.isDirectory()) await walk(absolute, basename(absolute) || 'folder', files);
    else throw new Error(`"${input}" is not a regular file or folder.`);
  }
  return files;
}

async function walk(directory, prefix, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(absolute, relative, files);
    else if (entry.isFile()) files.push({ absolute, relative, size: (await stat(absolute)).size });
  }
}

const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
// Characters invalid in file names on some OS, plus C0/C1 control characters (terminal escape sequences).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f-\u009f]/g;
// Invisible or direction-changing characters that can disguise a name ("invoice<RLO>fdp.exe" shows as "...exe.pdf").
// Built from numeric code points so this source file itself contains no invisible characters.
const DECEPTIVE_RANGES = [
  [0x00ad],
  [0x061c],
  [0x115f, 0x1160],
  [0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x3164],
  [0xfeff],
  [0xffa0],
];
const hexEscape = (cp) => `\\u${cp.toString(16).padStart(4, '0')}`;
const DECEPTIVE_CHARACTERS = new RegExp(
  `[${DECEPTIVE_RANGES.map(([from, to]) => (to ? `${hexEscape(from)}-${hexEscape(to)}` : hexEscape(from))).join('')}]`,
  'g',
);

/** Makes untrusted text safe to print in a terminal and to show to a person. */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(DECEPTIVE_CHARACTERS, '')
    .replace(UNSAFE_CHARACTERS, '_');
}

/**
 * Turns a path from the (untrusted) sender into safe path segments under the output folder.
 * Rejects traversal ("..") and strips characters that are invalid on Windows/macOS/Linux, control
 * characters and invisible/bidirectional characters.
 */
export function toSafePathSegments(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096) {
    throw new Error('The sender listed an invalid file name.');
  }
  const segments = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => {
      if (segment === '.' || segment === '..') {
        throw new Error(`Refusing unsafe path from sender: ${sanitizeText(relativePath).slice(0, 200)}`);
      }
      let clean = sanitizeText(segment).replace(/[. ]+$/, '');
      if (!clean) clean = '_';
      if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
      return clean.slice(0, 255);
    });
  if (segments.length === 0) throw new Error('The sender listed an empty file name.');
  return segments;
}

/** "report.pdf", 0 → "report.pdf"; 1 → "report (1).pdf"; 2 → "report (2).pdf"… */
export function candidateName(path, index) {
  if (index === 0) return path;
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  return `${stem} (${index})${extension}`;
}

/** "report.pdf" → "report (1).pdf" → "report (2).pdf"… until the name is free. */
export function nextFreePath(path) {
  for (let i = 0; ; i++) {
    const candidate = candidateName(path, i);
    if (!existsSync(candidate)) return candidate;
  }
}

const RISKY_EXTENSIONS = new Set([
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.ps1',
  '.vbs',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.lnk',
  '.reg',
  '.dll',
  '.jar',
  '.sh',
  '.command',
  '.app',
  '.desktop',
  '.appimage',
  '.deb',
  '.rpm',
  '.pkg',
  '.dmg',
]);

/** A warning for the confirmation prompt when the file list contains programs or hidden files. */
export function describeRisk(files) {
  const programs = files.filter((f) => RISKY_EXTENSIONS.has(extname(f.segments.at(-1)).toLowerCase())).length;
  const hidden = files.filter((f) => f.segments.some((s) => s.startsWith('.'))).length;
  const parts = [];
  if (programs > 0) parts.push(`${programs} program/script file(s)`);
  if (hidden > 0) parts.push(`${hidden} hidden file(s)`);
  return parts.length > 0
    ? `This includes ${parts.join(' and ')}. Only accept if you trust the sender.`
    : null;
}
