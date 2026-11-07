import { ClientMessage, LANE_CHANNEL_LABEL, ServerMessage, TransferLimits } from '@hopline/protocol';
import { Emitter } from '../utils/emitter.js';
import { createId } from '../utils/id.js';
import { PeerSession } from './peer-session.js';

/** Lanes start one after another, so their signaling doesn't burst into the server's rate limit. */
const LANE_STAGGER_MS = 400;
/** A lane that hasn't opened by then is given up (it's an optimisation, never required). */
const LANE_OPEN_TIMEOUT_MS = 20_000;
const LANE_ID = /^([0-9a-f]{16})\.L([1-9])$/;

/**
 * Owns the WebRTC side of a room and replaces broken connections with fresh ones.
 *
 * The room creator ("host") always makes offers; the guest answers. Each attempt is a new PeerSession with
 * its own id; the guest switches to a new session when an offer with an unseen id arrives. A guest that
 * notices a dead connection first asks the host to reconnect.
 *
 * Once the main connection is open, the host adds up to MAX_LANES - 1 "lane" connections (session ids
 * `<main id>.L<n>`). Each is a separate RTCPeerConnection, so each has its own congestion control, which
 * multiplies throughput on long, lossy routes. Lanes are best effort: one failing never affects the main
 * connection, and they all close with it.
 *
 * Lanes are authenticated: every connection of a device uses the same DTLS certificate, and a lane is used
 * only if the other side's certificate on it equals the one on the main connection. So a signaling server
 * that answers a lane offer itself gets nothing, and the safety code (computed from the main connection's
 * certificates) covers the lanes too. Without a certificate, no lanes are opened.
 *
 * Events:
 *   'channel' ({ channel, session }) — the main data channel is open
 *   'lost'                           — the main connection broke (or an attempt failed)
 *   'lane' (RTCDataChannel)          — an extra lane channel is open
 *   'lane-lost' (RTCDataChannel)     — a lane closed
 *   'reconnect-requested'            — host only: the guest asked for a new connection
 */
export class ConnectionManager extends Emitter {
  #signaling;
  #role;
  #iceServers = [];
  #forceRelay;
  #laneCount;
  #certificate;
  #session = null;
  /** Lane sessions of the current main session, by id. */
  #lanes = new Map();
  #laneTimers = new Set();
  #unsubscribe;
  #closed = false;

  constructor({
    signaling,
    role,
    iceServers = [],
    forceRelay = false,
    certificate = null,
    lanes = TransferLimits.MAX_LANES - 1,
  }) {
    super();
    this.#certificate = certificate;
    this.#signaling = signaling;
    this.#role = role;
    this.#iceServers = iceServers;
    this.#forceRelay = forceRelay;
    this.#laneCount = certificate ? Math.max(0, Math.min(lanes, TransferLimits.MAX_LANES - 1)) : 0;
    this.#unsubscribe = signaling.on(ServerMessage.SIGNAL, ({ data }) => this.#route(data));
  }

  get session() {
    return this.#session;
  }

  get connected() {
    return Boolean(this.#session?.channelOpen);
  }

  /** A snapshot of internal state for troubleshooting (opt-in debug tools only). */
  diagnostics() {
    return {
      session: this.#session?.id ?? null,
      channelOpen: this.connected,
      lanes: [...this.#lanes.entries()].map(([id, lane]) => ({ id, open: lane.channelOpen })),
    };
  }

  setIceServers(iceServers) {
    if (Array.isArray(iceServers) && iceServers.length > 0) this.#iceServers = iceServers;
  }

  /** Host: start a new connection attempt (replacing any current one). */
  connect() {
    if (this.#closed || this.#role !== 'host') return;
    this.#replace(createId(), true);
  }

  /** Guest: ask the host to start over (the guest can't make offers itself). */
  requestReconnect() {
    if (this.#closed || this.#role !== 'guest') return;
    this.#signaling.send(ClientMessage.SIGNAL, { data: { reconnect: true } });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#closeLanes();
    this.#session?.close();
    this.#session = null;
    this.removeAllListeners();
  }

  #route(data) {
    if (this.#closed || data === null || typeof data !== 'object') return;
    if (data.reconnect === true) {
      if (this.#role === 'host') this.emit('reconnect-requested');
      return;
    }
    if (typeof data.session !== 'string' || data.session.length > 64) return;

    const lane = LANE_ID.exec(data.session);
    if (lane) {
      // Lanes only ever belong to the current main session.
      if (lane[1] !== this.#session?.id) return;
      if (Number(lane[2]) > this.#laneCount) return;
      if (this.#role === 'guest' && data.description?.type === 'offer' && !this.#lanes.has(data.session)) {
        this.#openLane(this.#session, data.session, false);
      }
      void this.#lanes.get(data.session)?.handleSignal(data);
      return;
    }

    const isNewOffer = data.description?.type === 'offer' && data.session !== this.#session?.id;
    if (this.#role === 'guest' && isNewOffer) this.#replace(data.session, false);
    if (this.#session?.id === data.session) void this.#session.handleSignal(data);
  }

  #replace(id, initiator) {
    const previous = this.#session;
    const wasOpen = Boolean(previous?.channelOpen);
    this.#closeLanes();
    previous?.close();
    if (wasOpen) this.emit('lost');

    const session = new PeerSession({
      id,
      signaling: this.#signaling,
      initiator,
      iceServers: this.#iceServers,
      forceRelay: this.#forceRelay,
      certificate: this.#certificate,
    });
    this.#session = session;
    session.on('channel', (channel) => {
      this.emit('channel', { channel, session });
      if (initiator) this.#scheduleLanes(session);
    });
    const onEnd = () => {
      if (this.#session !== session) return;
      this.#closeLanes();
      session.close();
      this.#session = null;
      this.emit('lost');
    };
    session.on('closed', onEnd);
    session.on('failed', onEnd);
    session.on('error', (err) => console.warn('[hopline] WebRTC negotiation error', err));
  }

  /** Host: open the lanes one by one while this main session stays current and open. */
  #scheduleLanes(main) {
    for (let n = 1; n <= this.#laneCount; n++) {
      const timer = setTimeout(() => {
        this.#laneTimers.delete(timer);
        if (this.#closed || this.#session !== main || !main.channelOpen) return;
        this.#openLane(main, `${main.id}.L${n}`, true);
      }, n * LANE_STAGGER_MS);
      this.#laneTimers.add(timer);
    }
  }

  #openLane(main, id, initiator) {
    const lane = new PeerSession({
      id,
      signaling: this.#signaling,
      initiator,
      iceServers: this.#iceServers,
      forceRelay: this.#forceRelay, // "Hide my IP" applies to every connection
      label: LANE_CHANNEL_LABEL,
      certificate: this.#certificate,
      // Reliable but unordered: frames carry their offset, so SCTP needn't hold later frames behind a lost
      // packet (no head-of-line blocking on lossy links).
      ordered: false,
    });
    this.#lanes.set(id, lane);
    let channel = null;
    let giveUp = null;
    const end = () => {
      clearTimeout(giveUp);
      this.#laneTimers.delete(giveUp);
      if (this.#lanes.get(id) !== lane) return;
      this.#lanes.delete(id);
      lane.close();
      if (channel) this.emit('lane-lost', channel);
    };
    giveUp = setTimeout(() => !channel && end(), LANE_OPEN_TIMEOUT_MS);
    this.#laneTimers.add(giveUp);
    lane.on('channel', async (open) => {
      clearTimeout(giveUp);
      const [laneFingerprint, mainFingerprint] = await Promise.all([
        lane.remoteFingerprint().catch(() => null),
        main.remoteFingerprint().catch(() => null),
      ]);
      if (this.#lanes.get(id) !== lane || this.#session !== main) return;
      if (!laneFingerprint || laneFingerprint !== mainFingerprint) {
        console.warn(
          '[hopline] a lane reached a different device than the main connection, so it was closed',
        );
        end();
        return;
      }
      channel = open;
      this.emit('lane', open);
    });
    lane.on('closed', end);
    lane.on('failed', end);
    lane.on('error', () => {}); // a lane that can't negotiate just isn't used
  }

  #closeLanes() {
    for (const timer of this.#laneTimers) clearTimeout(timer);
    this.#laneTimers.clear();
    for (const lane of this.#lanes.values()) lane.close();
    this.#lanes.clear();
  }
}
