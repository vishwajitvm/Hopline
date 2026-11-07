/** Room codes skip 0/O and 1/I so they're easy to read aloud and type. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Uppercases, strips separators/spaces and trims to the code length. Safe for live input fields. */
export function normalizeRoomCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_PATTERN.test(code);
}

/**
 * @param {(max: number) => number} randomIndex returns a uniformly random integer in [0, max).
 *   Injected so the server can use node:crypto and tests can be deterministic.
 */
export function generateRoomCode(randomIndex) {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++)
    code += ROOM_CODE_ALPHABET[randomIndex(ROOM_CODE_ALPHABET.length)];
  return code;
}
