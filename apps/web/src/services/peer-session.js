import { ClientMessage, DATA_CHANNEL_LABEL } from '@hopline/protocol';
import { Emitter } from '../utils/emitter.js';
import { sha256Hex } from './crypto/sha256.js';

/** A "disconnected" ICE state often recovers on its own; give it this long before calling it lost. */
const DISCONNECTED_GRACE_MS = 8000;
/** ICE candidates buffered before the remote description arrives (a real browser sends a handful). */
const MAX_PENDING_CANDIDATES = 100;

/**
 * One WebRTC connection attempt (a "session"). Every signal carries the session id, so messages from an
 * earlier attempt can never confuse a newer one after a reconnect.
 *
 * Events:
 *   'channel' (RTCDataChannel) — open and ready
 *   'closed'                    — the data channel closed
 *   'failed'                    — ICE found no route, or the route died
 *   'error'   (Error)
 */
export class PeerSession extends Emitter {
  #pc;
  #signaling;
  #channel = null;
  #pendingCandidates = [];
  #closed = false;
  #ended = false;
  #disconnectTimer = null;

  constructor({
    id,
    signaling,
    initiator,
    iceServers,
    forceRelay = false,
    label = DATA_CHANNEL_LABEL,
    certificate = null,
    ordered = true,
  }) {
    super();
    this.id = id;
    this.#signaling = signaling;
    this.#pc = new RTCPeerConnection({
      iceServers,
      // forceRelay hides this device's IP address from the other side: only TURN relay candidates are used.
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
      // One certificate for all of this device's connections lets the other side prove a lane reaches the
      // same device as the main connection (whose certificate the safety code verifies).
      ...(certificate ? { certificates: [certificate] } : {}),
    });

    this.#pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) this.#signal({ candidate: candidate.toJSON() });
    });
    this.#pc.addEventListener('connectionstatechange', () => this.#onConnectionState());

    if (initiator) {
      this.#attachChannel(this.#pc.createDataChannel(label, { ordered }));
      void this.#makeOffer();
    } else {
      this.#pc.addEventListener('datachannel', ({ channel }) => this.#attachChannel(channel));
    }
  }

  get channelOpen() {
    return this.#channel?.readyState === 'open';
  }

  /** Testing aid: closes the data channel as if the network dropped (both sides see it close). */
  simulateDrop() {
    this.#channel?.close();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#disconnectTimer);
    this.removeAllListeners();
    this.#channel?.close();
    this.#pc.close();
  }

  async handleSignal(data) {
    if (this.#closed) return;
    try {
      if (data.description) {
        await this.#pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await this.#pc.setLocalDescription(await this.#pc.createAnswer());
          this.#sendLocalDescription();
        }
        const pending = this.#pendingCandidates;
        this.#pendingCandidates = [];
        for (const candidate of pending) await this.#pc.addIceCandidate(candidate);
      } else if (data.candidate) {
        if (this.#pc.remoteDescription) await this.#pc.addIceCandidate(data.candidate);
        else if (this.#pendingCandidates.length < MAX_PENDING_CANDIDATES)
          this.#pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** The route in use: { route: 'direct' | 'relay', localType, remoteType, protocol, rttMs } or null. */
  async connectionInfo() {
    if (this.#closed) return null;
    const stats = await this.#pc.getStats();
    const byId = new Map();
    stats.forEach((report) => byId.set(report.id, report));
    let pair = null;
    for (const report of byId.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId)
        pair = byId.get(report.selectedCandidatePairId);
    }
    if (!pair) {
      for (const report of byId.values()) {
        if (
          report.type === 'candidate-pair' &&
          (report.selected || (report.nominated && report.state === 'succeeded'))
        ) {
          pair = report;
          break;
        }
      }
    }
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    return {
      route: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct',
      localType: local?.candidateType ?? null,
      remoteType: remote?.candidateType ?? null,
      protocol: local?.protocol ?? null,
      rttMs:
        typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  }

  /**
   * The certificate fingerprints DTLS actually used (from getStats, not the SDP text, which could contain
   * decoy lines). Returns [mine, theirs] or null.
   */
  async #certificateFingerprints() {
    const stats = await this.#pc.getStats();
    const byId = new Map();
    stats.forEach((report) => byId.set(report.id, report));
    for (const report of byId.values()) {
      if (report.type !== 'transport' || !report.localCertificateId || !report.remoteCertificateId) continue;
      const local = byId.get(report.localCertificateId);
      const remote = byId.get(report.remoteCertificateId);
      if (local?.fingerprint && remote?.fingerprint) {
        const format = (c) =>
          `${String(c.fingerprintAlgorithm).toLowerCase()} ${String(c.fingerprint).toUpperCase()}`;
        return [format(local), format(remote)];
      }
    }
    return null;
  }

  /** The other side's DTLS certificate fingerprint (as actually used), or null. */
  async remoteFingerprint() {
    if (this.#closed) return null;
    return (await this.#certificateFingerprints())?.[1] ?? null;
  }

  /**
   * A 16-digit code derived from both sides' DTLS certificate fingerprints. Both devices compute the same
   * code only if nobody (including the signaling server) swapped the certificates — so comparing it over a
   * phone call proves the connection is end-to-end encrypted with no one in the middle. 16 digits (~53 bits)
   * makes grinding a matching fake certificate within the connection timeout infeasible.
   */
  async safetyCode() {
    if (this.#closed) return null;
    const pair = await this.#certificateFingerprints();
    if (!pair) return null;
    const hex = await sha256Hex(new TextEncoder().encode([...pair].sort().join('\n')));
    const digits = (BigInt(`0x${hex.slice(0, 24)}`) % 10n ** 16n).toString().padStart(16, '0');
    return digits.match(/.{4}/g).join(' ');
  }

  #signal(payload) {
    this.#signaling.send(ClientMessage.SIGNAL, { data: { session: this.id, ...payload } });
  }

  #attachChannel(channel) {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    const onOpen = () => {
      if (!this.#closed) this.emit('channel', channel);
    };
    if (channel.readyState === 'open') onOpen();
    else channel.addEventListener('open', onOpen, { once: true });
    channel.addEventListener('close', () => this.#end('closed'));
  }

  #onConnectionState() {
    const state = this.#pc.connectionState;
    clearTimeout(this.#disconnectTimer);
    if (state === 'failed') this.#end('failed');
    else if (state === 'disconnected') {
      this.#disconnectTimer = setTimeout(() => this.#end('failed'), DISCONNECTED_GRACE_MS);
    }
  }

  #end(event) {
    if (this.#closed || this.#ended) return;
    this.#ended = true;
    this.emit(event);
  }

  async #makeOffer() {
    try {
      await this.#pc.setLocalDescription(await this.#pc.createOffer());
      this.#sendLocalDescription();
    } catch (err) {
      this.emit('error', err);
      this.#end('failed');
    }
  }

  #sendLocalDescription() {
    const { type, sdp } = this.#pc.localDescription;
    this.#signal({ description: { type, sdp } });
  }
}
