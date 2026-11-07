import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { generateRoomCode } from '@hopline/protocol';

const MAX_MEMBERS = 2;

const defaultToken = () => randomBytes(24).toString('base64url'); // 32 chars, 192 bits

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * In-memory store of rooms. A room pairs exactly two members: the creator and one guest.
 *
 * A *member* is a seat in the room, identified by a secret token. A *peer* is the WebSocket currently
 * sitting in that seat — it can be null while the device reconnects. This split is what lets a device
 * whose connection dropped reclaim its place.
 *
 * Pure bookkeeping: no timers or sockets here (the signaling service owns those).
 */
export class RoomRegistry {
  #rooms = new Map();

  constructor({ ttlMs, now = Date.now, randomIndex = randomInt, createToken = defaultToken } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.randomIndex = randomIndex;
    this.createToken = createToken;
  }

  get size() {
    return this.#rooms.size;
  }

  create(peer) {
    let code;
    do code = generateRoomCode(this.randomIndex);
    while (this.#rooms.has(code));
    const member = this.#newMember(peer);
    const room = { code, members: [member], createdAt: this.now() };
    this.#rooms.set(code, room);
    return { room, member };
  }

  /** @returns {{ room, member } | { error: 'not-found' | 'full' }} */
  join(code, peer) {
    const room = this.#rooms.get(code);
    if (!room) return { error: 'not-found' };
    if (room.members.length >= MAX_MEMBERS) return { error: 'full' };
    const member = this.#newMember(peer);
    room.members.push(member);
    return { room, member };
  }

  /** Finds the seat a reconnecting device holds, by room code and secret token. */
  findMember(code, token) {
    const room = this.#rooms.get(code);
    const member = room?.members.find((m) => tokensMatch(m.token, token));
    return room && member ? { room, member } : null;
  }

  otherMember(room, member) {
    return room.members.find((m) => m !== member) ?? null;
  }

  isOpen(room) {
    return this.#rooms.get(room.code) === room;
  }

  /** Removes the room and cancels any pending reconnect timers. */
  close(room) {
    if (!this.isOpen(room)) return false;
    this.#rooms.delete(room.code);
    for (const member of room.members) {
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
    return true;
  }

  /** Removes rooms nobody joined within the TTL and returns them so their creators can be told. */
  sweepExpired() {
    const cutoff = this.now() - this.ttlMs;
    const expired = [];
    for (const room of this.#rooms.values()) {
      if (room.members.length < MAX_MEMBERS && room.createdAt < cutoff) expired.push(room);
    }
    for (const room of expired) this.close(room);
    return expired;
  }

  #newMember(peer) {
    return { token: this.createToken(), peer, graceTimer: null };
  }
}
