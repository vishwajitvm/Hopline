import { MEMBER_TOKEN_PATTERN, isValidRoomCode } from '@hopline/protocol';

/**
 * Remembers this tab's room seat (code + rejoin token) so a page reload rejoins the same room instead of
 * looking like a third device ("That room already has two devices").
 *
 * sessionStorage is per tab and per origin: another tab or site can't read it, and it's gone when the tab
 * closes. The token only reclaims this seat while the server still holds it (the reconnect grace period).
 */
const KEY = 'hopline:seat';
/** Slightly under the server's default reconnect grace (120 s), measured from when the page went away. */
const MAX_AGE_MS = 110_000;

export function saveSeat({ code, token, role, hideIp }) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ code, token, role, hideIp, savedAt: Date.now() }));
  } catch {
    // storage unavailable (private mode, blocked): reloads just won't rejoin
  }
}

export function clearSeat() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** The saved seat if it's recent enough to still be held by the server, else null. */
export function loadSeat() {
  try {
    const seat = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    const valid =
      seat &&
      typeof seat.code === 'string' &&
      isValidRoomCode(seat.code) &&
      typeof seat.token === 'string' &&
      MEMBER_TOKEN_PATTERN.test(seat.token) &&
      (seat.role === 'host' || seat.role === 'guest') &&
      Number.isFinite(seat.savedAt) &&
      Date.now() - seat.savedAt < MAX_AGE_MS;
    if (valid) return { code: seat.code, token: seat.token, role: seat.role, hideIp: seat.hideIp === true };
    clearSeat();
  } catch {
    clearSeat();
  }
  return null;
}
