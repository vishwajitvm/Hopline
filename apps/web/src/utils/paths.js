const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
// Characters invalid in file names on some OS, plus C0/C1 control characters.
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

/** MIME types a peer may declare and that we'll keep (for image previews). Everything else is a download. */
const SAFE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function safeMimeType(mime) {
  const value = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
  return SAFE_MIME_TYPES.has(value) ? value : 'application/octet-stream';
}

/**
 * Turns an untrusted relative path ("photos/2024/a.jpg") into safe path segments.
 * Drops empty, "." and ".." segments (no traversal), replaces characters that are invalid on
 * Windows/macOS/Linux, neutralizes reserved Windows names and bounds every length.
 */
export function toSafeSegments(path, { maxSegmentLength = 255, maxSegments = 32 } = {}) {
  const segments = String(path ?? '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(-maxSegments)
    .map((segment) => {
      let clean = segment
        .replace(DECEPTIVE_CHARACTERS, '')
        .replace(UNSAFE_CHARACTERS, '_')
        .replace(/[. ]+$/, '')
        .trim();
      if (!clean) clean = '_';
      if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
      return clean.slice(0, maxSegmentLength);
    });
  return segments.length > 0 ? segments : ['file'];
}

export function toSafePath(path, options) {
  return toSafeSegments(path, options).join('/');
}

export function baseName(path) {
  const segments = toSafeSegments(path);
  return segments[segments.length - 1];
}

/** "report.pdf" → ["report", ".pdf"]; dotfiles keep their name as the stem. */
export function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}
