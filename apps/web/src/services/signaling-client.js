import { ClientMessage, ErrorReason, ServerMessage } from '@hopline/protocol';
import { Emitter } from '../utils/emitter.js';

const CONNECT_TIMEOUT_MS = 8000;
const HEARTBEAT_MS = 25_000;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const MAX_QUEUED_MESSAGES = 200;
const UNREACHABLE = "Couldn't reach the Hopline server. Check your connection and try again.";

const State = Object.freeze({
  CONNECTING: 'connecting', // first connection attempt
  ONLINE: 'online',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
});

/**
 * WebSocket connection to the signaling server that heals itself.
 *
 * After a drop it reconnects with backoff and reclaims its seat (`rejoin` with the room code and secret
 * token); messages sent meanwhile are queued and flushed once the seat is back. A heartbeat keeps proxies
 * and sleeping hosts from closing an idle connection.
 *
 * Events: one per server message type (see ServerMessage), plus
 *   'disconnected' — the socket dropped; reconnecting
 *   'lost'         — dropped before ever joining a room, so there is nothing to rejoin
 */
export class SignalingClient extends Emitter {
  #url;
  #socket = null;
  #state = State.CONNECTING;
  #rejoin = null;
  #queue = [];
  #attempt = 0;
  #heartbeat = null;
  #retryTimer = null;

  constructor(url) {
    super();
    this.#url = url;
  }

  get online() {
    return this.#state === State.ONLINE;
  }

  /** First connection. Rejects if the server can't be reached. */
  async connect() {
    await this.#open();
    this.#state = State.ONLINE;
  }

  /** Remembers the seat to reclaim after a reconnect. */
  setRejoin(code, token) {
    this.#rejoin = { code, token };
  }

  send(type, payload = {}) {
    const message = JSON.stringify({ type, ...payload });
    if (this.#state === State.ONLINE && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(message);
    } else if (this.#state === State.RECONNECTING && this.#queue.length < MAX_QUEUED_MESSAGES) {
      this.#queue.push(message);
    }
  }

  /** Testing aid: drops the socket as if the network failed (the client will reconnect). */
  simulateDrop() {
    this.#socket?.close();
  }

  /** Closes for good, without emitting 'disconnected'. */
  close() {
    this.#state = State.CLOSED;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#heartbeat);
    this.removeAllListeners();
    this.#queue = [];
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  #open() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.#url);
      } catch {
        reject(new Error(UNREACHABLE));
        return;
      }
      this.#socket = socket;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) socket.close();
      }, CONNECT_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        opened = true;
        clearTimeout(timer);
        this.#startHeartbeat(socket);
        resolve(socket);
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (!opened) reject(new Error(UNREACHABLE));
        if (this.#socket === socket) this.#onSocketClosed();
      });
      socket.addEventListener('message', (event) => this.#onMessage(event));
    });
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === ServerMessage.REJOINED) {
      this.#state = State.ONLINE;
      this.#attempt = 0;
      const queued = this.#queue;
      this.#queue = [];
      for (const item of queued) this.#socket?.send(item);
    } else if (message.type === ServerMessage.ERROR && message.reason === ErrorReason.REJOIN_FAILED) {
      this.#rejoin = null; // the seat is gone; stop trying
    }
    this.emit(message.type, message);
  }

  #onSocketClosed() {
    clearInterval(this.#heartbeat);
    const previous = this.#state;
    if (previous === State.CLOSED || previous === State.CONNECTING) return;
    if (!this.#rejoin) {
      this.#state = State.CLOSED;
      this.emit('lost');
      return;
    }
    this.#state = State.RECONNECTING;
    if (previous === State.ONLINE) this.emit('disconnected');
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.#attempt++;
    this.#retryTimer = setTimeout(() => this.#reconnect(), delay);
  }

  async #reconnect() {
    if (this.#state !== State.RECONNECTING || !this.#rejoin) return;
    try {
      const socket = await this.#open();
      socket.send(JSON.stringify({ type: ClientMessage.REJOIN, ...this.#rejoin }));
    } catch {
      // the close handler already scheduled the next attempt
    }
  }

  #startHeartbeat(socket) {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: ClientMessage.PING }));
    }, HEARTBEAT_MS);
  }
}
