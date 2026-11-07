import { WebSocketServer } from 'ws';
import {
  ClientMessage,
  ErrorReason,
  MAX_SIGNAL_MESSAGE_BYTES,
  MEMBER_TOKEN_PATTERN,
  SIGNALING_PATH,
  ServerMessage,
  isValidRoomCode,
  normalizeRoomCode,
} from '@hopline/protocol';
import { clientIp, limitKey } from '../lib/client-ip.js';
import { TokenBucket } from '../lib/token-bucket.js';
import { createIceServerProvider } from './ice-servers.js';
import { Peer } from './peer.js';
import { RoomRegistry } from './room-registry.js';

const JOIN_ERRORS = { 'not-found': ErrorReason.NOT_FOUND, full: ErrorReason.ROOM_FULL };
const REPLACED_CLOSE_CODE = 4000;
const IDLE_CLOSE_CODE = 4001;
/** The desktop app's pages are file:// — browsers never send this origin from a website. */
const DESKTOP_ORIGINS = new Set(['file://']);

/**
 * WebSocket signaling: pairs two devices in a room and relays their WebRTC offer/answer/ICE messages.
 * File data never passes through here.
 *
 * Disconnects are tolerated: when a socket drops without saying `leave`, its seat is held for
 * `reconnectGraceMs`. The device can `rejoin` with its secret token; the other side is told
 * `peer-disconnected` / `peer-reconnected`, and only gets `peer-left` if the grace period runs out.
 *
 * Abuse controls: same-origin by default, global and per-client connection caps (IPv6 per /64), message rate
 * limits, a per-client budget for wrong room codes, idle sockets closed, and TURN relay credentials only
 * handed out once two devices are actually paired.
 */
export class SignalingService {
  #wss;
  #rooms;
  #config;
  #log;
  #heartbeat;
  #iceServers;
  /** limit key → open sockets */
  #connections = new Map();
  /** limit key → bucket of allowed wrong guesses (room codes / rejoin tokens) */
  #guessBudgets = new Map();
  /** socket → Peer, so the heartbeat can find a socket's liveness flag in O(1). */
  #peers = new WeakMap();

  #handlers = {
    [ClientMessage.CREATE]: (peer) => this.#handleCreate(peer),
    [ClientMessage.JOIN]: (peer, msg) => this.#handleJoin(peer, msg),
    [ClientMessage.REJOIN]: (peer, msg) => this.#handleRejoin(peer, msg),
    [ClientMessage.SIGNAL]: (peer, msg) => this.#handleSignal(peer, msg),
    [ClientMessage.LEAVE]: (peer) => this.#leave(peer, { intentional: true }),
    [ClientMessage.PING]: () => {},
  };

  constructor({ httpServer, config, logger }) {
    this.#config = config;
    this.#log = logger.child({ component: 'signaling' });
    this.#rooms = new RoomRegistry({ ttlMs: config.roomTtlMs });
    this.#iceServers = createIceServerProvider(config);
    this.#wss = new WebSocketServer({
      server: httpServer,
      path: SIGNALING_PATH,
      maxPayload: MAX_SIGNAL_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: (info, done) => this.#verifyClient(info, done),
    });
    this.#wss.on('connection', (socket, req) => this.#onConnection(socket, req));
    this.#heartbeat = setInterval(() => this.#tick(), config.heartbeatMs);
    this.#heartbeat.unref();
  }

  get stats() {
    return { rooms: this.#rooms.size, peers: this.#wss.clients.size };
  }

  async close() {
    clearInterval(this.#heartbeat);
    for (const socket of this.#wss.clients) socket.close(1001, 'Server shutting down');
    await new Promise((resolve) => this.#wss.close(() => resolve()));
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Which pages may open a signaling connection.
   *  - ALLOWED_ORIGINS set: exactly those (add "file://" to allow the desktop app).
   *  - Otherwise: the same site that serves the app, the desktop app, and non-browser clients (no Origin).
   * This stops other websites from silently using visitors' browsers against this server.
   */
  #originAllowed(origin, host) {
    const { allowedOrigins } = this.#config;
    if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
    if (!origin || DESKTOP_ORIGINS.has(origin)) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  #verifyClient({ origin, req }, done) {
    if (!this.#originAllowed(origin, req.headers.host)) {
      this.#log.warn('rejected origin', { origin });
      return done(false, 403, 'Origin not allowed');
    }
    if (this.#wss.clients.size >= this.#config.maxConnections) {
      this.#log.warn('connection limit reached');
      return done(false, 503, 'Server busy');
    }
    const key = limitKey(clientIp(req, this.#config.trustedProxyHops));
    if ((this.#connections.get(key) ?? 0) >= this.#config.maxConnectionsPerIp) {
      this.#log.warn('too many connections', { client: key });
      return done(false, 429, 'Too many connections');
    }
    done(true);
  }

  #onConnection(socket, req) {
    const ip = clientIp(req, this.#config.trustedProxyHops);
    const key = limitKey(ip);
    this.#connections.set(key, (this.#connections.get(key) ?? 0) + 1);
    const peer = new Peer(socket, { ip, rateLimit: this.#config.rateLimit });
    peer.limitKey = key;
    this.#peers.set(socket, peer);
    this.#armIdleTimer(peer);
    this.#log.debug('peer connected', { peer: peer.id, ip });

    socket.on('message', (data, isBinary) => this.#onMessage(peer, data, isBinary));
    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.on('error', (err) => this.#log.debug('socket error', { peer: peer.id, err }));
    socket.on('close', () => {
      clearTimeout(peer.idleTimer);
      this.#leave(peer, { intentional: false });
      const remaining = (this.#connections.get(key) ?? 1) - 1;
      if (remaining > 0) this.#connections.set(key, remaining);
      else this.#connections.delete(key);
      this.#log.debug('peer disconnected', { peer: peer.id });
    });
  }

  /** Sockets that aren't in a room for a while are closed, so idle connections can't pile up. */
  #armIdleTimer(peer) {
    clearTimeout(peer.idleTimer);
    peer.idleTimer = setTimeout(() => {
      if (!peer.inRoom) peer.socket.close(IDLE_CLOSE_CODE, 'Idle');
    }, this.#config.unjoinedTimeoutMs);
    peer.idleTimer.unref();
  }

  #seat(peer, room, member) {
    clearTimeout(peer.idleTimer);
    peer.attach(room, member);
  }

  #unseat(peer) {
    peer.detach();
    this.#armIdleTimer(peer);
  }

  #onMessage(peer, data, isBinary) {
    if (!peer.limiter.take()) return peer.sendError(ErrorReason.RATE_LIMITED);
    if (isBinary) return peer.sendError(ErrorReason.BAD_MESSAGE);

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return peer.sendError(ErrorReason.BAD_MESSAGE);
    }

    const handler =
      msg !== null &&
      typeof msg === 'object' &&
      typeof msg.type === 'string' &&
      Object.hasOwn(this.#handlers, msg.type)
        ? this.#handlers[msg.type]
        : undefined;
    if (!handler) return peer.sendError(ErrorReason.UNKNOWN_TYPE);
    handler(peer, msg);
  }

  #tick() {
    for (const socket of this.#wss.clients) {
      const peer = this.#peers.get(socket);
      if (!peer?.alive) {
        socket.terminate();
        continue;
      }
      peer.alive = false;
      socket.ping();
    }
    for (const room of this.#rooms.sweepExpired()) {
      for (const member of room.members) {
        const seated = member.peer;
        member.peer = null;
        if (!seated) continue;
        this.#unseat(seated);
        seated.sendError(ErrorReason.EXPIRED);
      }
      this.#log.info('room expired', { room: room.code });
    }
    for (const [key, bucket] of this.#guessBudgets) if (bucket.isFull) this.#guessBudgets.delete(key);
  }

  // ── Guessing budget ─────────────────────────────────────────────────────

  #budget(peer) {
    let bucket = this.#guessBudgets.get(peer.limitKey);
    if (!bucket) {
      const perMinute = this.#config.joinAttemptsPerMinute;
      bucket = new TokenBucket({ ratePerSecond: perMinute / 60, burst: perMinute });
      this.#guessBudgets.set(peer.limitKey, bucket);
    }
    return bucket;
  }

  /** Only failed attempts cost budget; with none left, the server doesn't even look the code up. */
  #outOfGuesses(peer) {
    if (this.#budget(peer).canTake()) return false;
    this.#log.warn('wrong-code budget exhausted', { client: peer.limitKey });
    peer.sendError(ErrorReason.RATE_LIMITED);
    return true;
  }

  #wrongGuess(peer, reason) {
    this.#budget(peer).take();
    peer.sendError(reason);
  }

  // ── Message handlers ────────────────────────────────────────────────────

  #handleCreate(peer) {
    this.#leave(peer, { intentional: true });
    const { room, member } = this.#rooms.create(peer);
    this.#seat(peer, room, member);
    // No TURN credentials yet: the relay is only offered once two devices are paired.
    peer.send({
      type: ServerMessage.CREATED,
      code: room.code,
      token: member.token,
      iceServers: this.#iceServers({ withTurn: false }),
    });
    this.#log.info('room created', { room: room.code, peer: peer.id });
  }

  #handleJoin(peer, msg) {
    if (this.#outOfGuesses(peer)) return;
    const code = normalizeRoomCode(msg.code);
    if (!isValidRoomCode(code)) return this.#wrongGuess(peer, ErrorReason.INVALID_CODE);

    this.#leave(peer, { intentional: true });
    const result = this.#rooms.join(code, peer);
    if (result.error) return this.#wrongGuess(peer, JOIN_ERRORS[result.error]);

    const { room, member } = result;
    this.#seat(peer, room, member);
    peer.send({
      type: ServerMessage.JOINED,
      code,
      token: member.token,
      iceServers: this.#iceServers({ withTurn: true }),
    });
    // The creator makes the WebRTC offer once someone is there to answer it.
    this.#rooms
      .otherMember(room, member)
      ?.peer?.send({ type: ServerMessage.PEER_JOINED, iceServers: this.#iceServers({ withTurn: true }) });
    this.#log.info('room joined', { room: code, peer: peer.id });
  }

  #handleRejoin(peer, msg) {
    if (this.#outOfGuesses(peer)) return;
    const code = normalizeRoomCode(msg.code);
    if (!isValidRoomCode(code) || typeof msg.token !== 'string' || !MEMBER_TOKEN_PATTERN.test(msg.token)) {
      return this.#wrongGuess(peer, ErrorReason.REJOIN_FAILED);
    }
    const found = this.#rooms.findMember(code, msg.token);
    if (!found) return this.#wrongGuess(peer, ErrorReason.REJOIN_FAILED);

    const { room, member } = found;
    if (peer.member !== member) this.#leave(peer, { intentional: true });

    clearTimeout(member.graceTimer);
    member.graceTimer = null;
    const previous = member.peer;
    if (previous && previous !== peer) {
      // The old socket is a ghost (e.g. a half-open connection after a network switch).
      previous.detach();
      previous.socket.close(REPLACED_CLOSE_CODE, 'Replaced by a newer connection');
    }
    this.#seat(peer, room, member);

    const other = this.#rooms.otherMember(room, member);
    peer.send({
      type: ServerMessage.REJOINED,
      code,
      peerPresent: Boolean(other?.peer),
      iceServers: this.#iceServers({ withTurn: room.members.length === 2 }),
    });
    other?.peer?.send({ type: ServerMessage.PEER_RECONNECTED });
    this.#log.info('member rejoined', { room: code, peer: peer.id });
  }

  #handleSignal(peer, msg) {
    if (!peer.inRoom) return peer.sendError(ErrorReason.NOT_IN_ROOM);
    if (msg.data === null || typeof msg.data !== 'object' || Array.isArray(msg.data)) {
      return peer.sendError(ErrorReason.BAD_MESSAGE);
    }
    // Messages for a member that is mid-reconnect are dropped; the clients renegotiate once it's back.
    this.#rooms
      .otherMember(peer.room, peer.member)
      ?.peer?.send({ type: ServerMessage.SIGNAL, data: msg.data });
  }

  /**
   * Takes a socket out of its room.
   *  - intentional (`leave`, create/join elsewhere): the room closes now and the other side gets `peer-left`.
   *  - unexpected (socket dropped): the seat is held for the grace period so the device can `rejoin`.
   */
  #leave(peer, { intentional }) {
    const { room, member } = peer;
    if (!room) return;
    this.#unseat(peer);
    if (!this.#rooms.isOpen(room) || member.peer !== peer) return;

    if (intentional) {
      member.peer = null; // the leaver doesn't need its own peer-left
      this.#closeRoom(room, 'left');
      return;
    }

    member.peer = null;
    this.#rooms.otherMember(room, member)?.peer?.send({ type: ServerMessage.PEER_DISCONNECTED });
    member.graceTimer = setTimeout(() => {
      if (this.#rooms.isOpen(room) && !member.peer) this.#closeRoom(room, 'reconnect grace expired');
    }, this.#config.reconnectGraceMs);
    member.graceTimer.unref();
    this.#log.info('member disconnected', { room: room.code });
  }

  #closeRoom(room, reason) {
    if (!this.#rooms.close(room)) return;
    for (const member of room.members) {
      const seated = member.peer;
      member.peer = null;
      if (!seated) continue;
      this.#unseat(seated);
      seated.send({ type: ServerMessage.PEER_LEFT });
    }
    this.#log.info('room closed', { room: room.code, reason });
  }
}
