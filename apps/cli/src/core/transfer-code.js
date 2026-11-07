import { randomInt } from 'node:crypto';
import { WORDS } from './wordlist.js';

const CODE_PATTERN = /^(\d{2})-([a-z]+-[a-z]+-[a-z]+)$/;

/**
 * Codes look like "42-amber-river-falcon".
 *  - The number is the "nameplate": it's broadcast on the LAN so the receiver can find the sender.
 *  - The three words are secret: they're never sent over the network, only used to derive the key.
 */
export function generateTransferCode() {
  const word = () => WORDS[randomInt(WORDS.length)];
  return `${randomInt(10, 100)}-${word()}-${word()}-${word()}`;
}

export function parseTransferCode(input) {
  const normalized = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const match = CODE_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`"${input}" doesn't look like a Hopline code (they look like 42-amber-river-falcon).`);
  }
  return { code: normalized, nameplate: match[1] };
}
