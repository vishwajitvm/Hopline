import { ErrorMessages, ServerMessage } from '@hopline/protocol';
import { TokenBucket } from '../lib/token-bucket.js';

let nextPeerId = 1;

/** One connected WebSocket client. Wraps the socket with room membership, liveness and rate limiting. */
export class Peer {
  constructor(socket, { ip, rateLimit }) {
    this.id = nextPeerId++;
    this.socket = socket;
    this.ip = ip;
    /** The room and seat this socket currently occupies (both null when not in a room). */
    this.room = null;
    this.member = null;
    this.alive = true;
    this.limiter = new TokenBucket({ ratePerSecond: rateLimit.messagesPerSecond, burst: rateLimit.burst });
  }

  get inRoom() {
    return this.room !== null;
  }

  send(message) {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendError(reason, message = ErrorMessages[reason]) {
    this.send({ type: ServerMessage.ERROR, reason, message });
  }

  /** Seats this socket in a room. */
  attach(room, member) {
    this.room = room;
    this.member = member;
    member.peer = this;
  }

  detach() {
    this.room = null;
    this.member = null;
  }
}
