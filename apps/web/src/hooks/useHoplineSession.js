import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ClientMessage, ErrorReason, ServerMessage } from '@hopline/protocol';
import { resolveIceServers, resolveSignalingUrl } from '../config/runtime.js';
import { ConnectionManager } from '../services/connection-manager.js';
import { SignalingClient } from '../services/signaling-client.js';
import { clearBrowserStorage, nativeBridge } from '../services/storage/sinks.js';
import { TransferManager } from '../services/transfer/transfer-manager.js';
import { clearSeat, loadSeat, saveSeat } from '../utils/seat-storage.js';
import { SessionAction, initialSessionState, sessionReducer } from '../state/session-reducer.js';

const INITIAL_CONNECT_TIMEOUT_MS = 60_000;
const RECONNECT_TIMEOUT_MS = 3 * 60_000;
const RETRY_INTERVAL_MS = 15_000;
const STATS_INTERVAL_MS = 2000;
/** A host ignores "please reconnect" this soon after its channel opened (the request is stale). */
const FRESH_CHANNEL_MS = 5000;

const Notice = {
  PEER_LEFT: 'The other device left the room.',
  NO_ROUTE:
    "Couldn't open a connection between the devices. Their networks block direct connections and no relay " +
    'server is available. See "TURN relay" in the docs.',
  RECONNECT_FAILED:
    'The connection was lost and could not be restored. Files you already received are below.',
  REJOIN_FAILED: 'The connection was gone too long and the room was closed.',
  SERVER_LOST: 'Lost the connection to the Hopline server.',
  SERVER_RESTARTED:
    'The Hopline server restarted. Your devices are still connected directly, so transfers continue. If this ' +
    'connection drops, start a new room.',
  NO_RELAY:
    '"Hide my IP address" needs a relay server, and this server has none — so nothing was connected and ' +
    'your IP stayed private. Turn the option off to connect directly, or ask the server owner to set up TURN.',
};

const hasRelay = (iceServers) =>
  iceServers.some((server) => [].concat(server.urls).some((url) => /^turns?:/.test(url)));

function blankSession() {
  return {
    signaling: null,
    connection: null,
    transfers: null,
    role: null,
    hideIp: false,
    iceServers: [],
    certificate: null,
    /** { code, token, role, hideIp } once the server gave us a seat: lets a reload rejoin it. */
    seat: null,
    resuming: false,
    everConnected: false,
    channelOpen: false,
    channelOpenedAt: 0,
    peerOnline: false,
    ended: false,
    deadline: null,
    retryTimer: null,
    statsTimer: null,
  };
}

/**
 * Owns the whole session: signaling → WebRTC → transfers, including automatic reconnection.
 * Network objects live in a ref (never React state); the UI gets plain state plus actions.
 */
export function useHoplineSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const session = useRef(blankSession());

  const clearTimers = useCallback(() => {
    const s = session.current;
    clearTimeout(s.deadline);
    clearTimeout(s.retryTimer);
    clearInterval(s.statsTimer);
    s.deadline = s.retryTimer = s.statsTimer = null;
  }, []);

  const closeNetwork = useCallback(() => {
    const s = session.current;
    clearTimers();
    s.connection?.close();
    s.signaling?.close();
    s.connection = null;
    s.signaling = null;
    s.channelOpen = false;
  }, [clearTimers]);

  /** Ends the session; finished files stay available. */
  const end = useCallback(
    (notice) => {
      const s = session.current;
      if (s.ended) return;
      s.ended = true;
      clearSeat();
      s.signaling?.send(ClientMessage.LEAVE); // let the other device know now (no-op if the room is gone)
      closeNetwork();
      s.transfers?.stop(notice);
      dispatch({ type: SessionAction.ENDED, notice });
    },
    [closeNetwork],
  );

  /** Fails before the devices ever connected: back to the start screen with an error. */
  const fail = useCallback(
    (error) => {
      const s = session.current;
      // Tell the server we're leaving on purpose, so the other device learns right away instead of waiting
      // out the reconnect grace period.
      s.signaling?.send(ClientMessage.LEAVE);
      clearSeat();
      closeNetwork();
      s.transfers?.dispose();
      session.current = blankSession();
      dispatch({ type: SessionAction.FAILED, error });
    },
    [closeNetwork],
  );

  const reset = useCallback(() => {
    const s = session.current;
    if (s.signaling && !s.ended) s.signaling.send(ClientMessage.LEAVE);
    clearSeat();
    closeNetwork();
    s.transfers?.dispose();
    session.current = blankSession();
    void clearBrowserStorage();
    dispatch({ type: SessionAction.RESET });
  }, [closeNetwork]);

  const armDeadline = useCallback(
    (ms, notice) => {
      const s = session.current;
      if (s.deadline) return;
      s.deadline = setTimeout(() => {
        s.deadline = null;
        if (!s.channelOpen) end(notice);
      }, ms);
    },
    [end],
  );

  /** Keeps trying to restore the connection until it opens or the deadline ends the session. */
  const scheduleAttempt = useCallback((delay) => {
    const s = session.current;
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => {
      if (s.ended || s.channelOpen || !s.connection) return;
      if (s.role === 'host') {
        if (s.signaling?.online && s.peerOnline) s.connection.connect();
      } else {
        s.connection.requestReconnect();
      }
      scheduleAttempt(RETRY_INTERVAL_MS);
    }, delay);
  }, []);

  const onChannel = useCallback(({ channel, session: peer }) => {
    const s = session.current;
    if (s.ended) return;
    s.channelOpen = true;
    s.everConnected = true;
    s.channelOpenedAt = Date.now();
    clearTimeout(s.deadline);
    clearTimeout(s.retryTimer);
    s.deadline = s.retryTimer = null;
    s.transfers.attach(channel);
    dispatch({ type: SessionAction.CONNECTED });

    clearInterval(s.statsTimer);
    const poll = async () => {
      const info = await peer.connectionInfo().catch(() => null);
      if (info && s.channelOpen)
        dispatch({ type: SessionAction.CONNECTION_INFO, info: { ...info, lanes: s.transfers.laneCount } });
    };
    void poll();
    s.statsTimer = setInterval(poll, STATS_INTERVAL_MS);
    peer
      .safetyCode()
      .then((code) => code && dispatch({ type: SessionAction.SAFETY_CODE, code }))
      .catch(() => {});
  }, []);

  const onLost = useCallback(() => {
    const s = session.current;
    if (s.ended) return;
    s.channelOpen = false;
    clearInterval(s.statsTimer);
    s.transfers.detach();
    if (s.everConnected) {
      dispatch({ type: SessionAction.RECONNECTING });
      armDeadline(RECONNECT_TIMEOUT_MS, Notice.RECONNECT_FAILED);
    } else {
      armDeadline(INITIAL_CONNECT_TIMEOUT_MS, Notice.NO_ROUTE);
    }
    scheduleAttempt(1000);
  }, [armDeadline, scheduleAttempt]);

  /**
   * Creates the WebRTC side once both devices are in the room (that's when the server hands out relay
   * credentials). "Hide my IP" fails closed: without a relay, nothing connects rather than leaking the IP.
   */
  const ensureConnection = useCallback(() => {
    const s = session.current;
    if (s.connection) return true;
    if (s.hideIp && !hasRelay(s.iceServers)) {
      if (s.everConnected) end(Notice.NO_RELAY);
      else fail(Notice.NO_RELAY);
      return false;
    }
    const connection = new ConnectionManager({
      signaling: s.signaling,
      role: s.role,
      iceServers: s.iceServers,
      forceRelay: s.hideIp,
      certificate: s.certificate,
    });
    connection.on('channel', onChannel);
    connection.on('lost', onLost);
    // Extra parallel connections for file data (they belong to the current main connection).
    connection.on('lane', (channel) => s.transfers?.addLane(channel));
    connection.on('lane-lost', (channel) => s.transfers?.removeLane(channel));
    connection.on('reconnect-requested', () => {
      if (s.channelOpen && Date.now() - s.channelOpenedAt < FRESH_CHANNEL_MS) return;
      connection.connect();
    });
    s.connection = connection;
    return true;
  }, [onChannel, onLost, end, fail]);

  const start = useCallback(
    async (message, { hideIp = false, resume = null } = {}) => {
      reset();
      dispatch({ type: SessionAction.START });
      const s = session.current;
      s.hideIp = hideIp;
      if (resume) {
        s.role = resume.role;
        s.seat = { ...resume, hideIp };
        s.resuming = true;
      }
      s.iceServers = resolveIceServers();

      const signaling = new SignalingClient(resolveSignalingUrl());
      s.signaling = signaling;
      // A free-plan server may be asleep: if it doesn't answer quickly, say so while we keep trying.
      const waking = setTimeout(() => {
        if (session.current === s) dispatch({ type: SessionAction.SERVER_WAKING });
      }, 3000);
      try {
        // One certificate for every connection of this session (see ConnectionManager: lane authentication).
        const [certificate] = await Promise.all([
          RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }).catch(() => null),
          signaling.connect(),
        ]);
        s.certificate = certificate;
      } catch (err) {
        if (session.current === s && s.signaling === signaling) fail(err.message);
        return;
      } finally {
        clearTimeout(waking);
      }
      if (session.current !== s || s.signaling !== signaling) return; // user moved on meanwhile

      // In the desktop app, files between two desktop apps go over a direct TCP link when possible.
      const transfers = new TransferManager({ direct: nativeBridge() });
      transfers.on('change', (list) => dispatch({ type: SessionAction.TRANSFERS_CHANGED, transfers: list }));
      // The engine ended the session itself (incompatible version, protocol abuse): say so instead of
      // looking connected while nothing works.
      transfers.on('stopped', (reason) => end(reason));
      s.transfers = transfers;
      const keepSeat = (code, token) => {
        s.seat = { code, token, role: s.role, hideIp: s.hideIp };
        saveSeat(s.seat);
        signaling.setRejoin(code, token);
      };
      if (resume) signaling.setRejoin(resume.code, resume.token);

      const takeIceServers = (msg) => {
        if (!Array.isArray(msg.iceServers) || msg.iceServers.length === 0) return;
        s.iceServers = msg.iceServers;
        s.connection?.setIceServers(msg.iceServers);
      };

      signaling.on(ServerMessage.CREATED, (msg) => {
        s.role = 'host';
        takeIceServers(msg);
        keepSeat(msg.code, msg.token);
        dispatch({
          type: SessionAction.ROOM_CREATED,
          code: msg.code,
          relayAvailable: hasRelay(s.iceServers),
        });
      });
      signaling.on(ServerMessage.JOINED, (msg) => {
        s.role = 'guest';
        s.peerOnline = true;
        takeIceServers(msg);
        keepSeat(msg.code, msg.token);
        if (!ensureConnection()) return;
        dispatch({ type: SessionAction.ROOM_JOINED, code: msg.code, relayAvailable: hasRelay(s.iceServers) });
        armDeadline(INITIAL_CONNECT_TIMEOUT_MS, Notice.NO_ROUTE);
      });
      signaling.on(ServerMessage.PEER_JOINED, (msg) => {
        s.peerOnline = true;
        takeIceServers(msg);
        if (!ensureConnection()) return;
        dispatch({ type: SessionAction.PEER_JOINED });
        armDeadline(INITIAL_CONNECT_TIMEOUT_MS, Notice.NO_ROUTE);
        s.connection.connect();
      });
      signaling.on(ServerMessage.REJOINED, (msg) => {
        takeIceServers(msg);
        s.peerOnline = msg.peerPresent === true;
        if (s.resuming) {
          // Back in our seat after a page reload.
          s.resuming = false;
          saveSeat(s.seat);
          dispatch({
            type: SessionAction.ROOM_RESUMED,
            code: s.seat.code,
            role: s.role,
            peerPresent: s.peerOnline,
            relayAvailable: hasRelay(s.iceServers),
          });
          if (s.peerOnline) armDeadline(INITIAL_CONNECT_TIMEOUT_MS, Notice.NO_ROUTE);
        }
        dispatch({ type: SessionAction.SERVER_PRESENCE, online: true });
        dispatch({ type: SessionAction.PEER_PRESENCE, online: s.peerOnline });
        if (s.peerOnline && !s.channelOpen && ensureConnection()) scheduleAttempt(200);
      });
      signaling.on(ServerMessage.PEER_DISCONNECTED, () => {
        s.peerOnline = false;
        dispatch({ type: SessionAction.PEER_PRESENCE, online: false });
      });
      signaling.on(ServerMessage.PEER_RECONNECTED, () => {
        s.peerOnline = true;
        dispatch({ type: SessionAction.PEER_PRESENCE, online: true });
        if (!s.channelOpen && ensureConnection()) scheduleAttempt(200);
      });
      signaling.on(ServerMessage.PEER_LEFT, () => end(Notice.PEER_LEFT));
      signaling.on(ServerMessage.ERROR, ({ reason, message: text }) => {
        if (reason === ErrorReason.REJOIN_FAILED) {
          // The server forgot the room (restart, redeploy, a free plan going to sleep). If the devices are
          // still connected directly they don't need it: keep the transfer going.
          if (s.channelOpen) {
            clearSeat();
            s.seat = null;
            dispatch({ type: SessionAction.NOTICE, notice: Notice.SERVER_RESTARTED });
          } else if (s.everConnected) end(Notice.REJOIN_FAILED);
          else fail(text || Notice.REJOIN_FAILED);
        } else if (!s.everConnected) {
          fail(text || 'Something went wrong. Please try again.');
        } else {
          console.warn('[hopline] server error', reason, text);
        }
      });
      signaling.on('disconnected', () => dispatch({ type: SessionAction.SERVER_PRESENCE, online: false }));
      signaling.on('lost', () => {
        if (s.channelOpen) {
          // Only the introduction service is gone; the devices are connected directly.
          dispatch({ type: SessionAction.SERVER_PRESENCE, online: false });
          dispatch({ type: SessionAction.NOTICE, notice: Notice.SERVER_RESTARTED });
        } else if (s.everConnected) {
          end(Notice.SERVER_LOST); // keeps received files on screen
        } else {
          fail(Notice.SERVER_LOST);
        }
      });

      signaling.send(message.type, message.payload);
    },
    [reset, fail, end, armDeadline, scheduleAttempt, ensureConnection],
  );

  const createRoom = useCallback((options) => start({ type: ClientMessage.CREATE }, options), [start]);

  // After a reload, quietly take back this tab's seat (the server holds it for a couple of minutes).
  const resumeTried = useRef(false);
  useEffect(() => {
    const seat = resumeTried.current ? null : loadSeat();
    resumeTried.current = true;
    if (seat) {
      void start(
        { type: ClientMessage.REJOIN, payload: { code: seat.code, token: seat.token } },
        { hideIp: seat.hideIp, resume: seat },
      );
    }
    // Refresh the timestamp when the page goes away, so the age check measures time since the reload.
    const onPageHide = () => {
      const s = session.current;
      if (s.seat && !s.ended) saveSeat(s.seat);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [start]);
  const joinRoom = useCallback(
    (code, options) => start({ type: ClientMessage.JOIN, payload: { code } }, options),
    [start],
  );
  const sendFiles = useCallback((items) => session.current.transfers?.send(items), []);
  const declineOffer = useCallback((batchId) => session.current.transfers?.decline(batchId), []);
  const cancelTransfer = useCallback((id) => session.current.transfers?.cancel(id), []);

  /** Must be called directly from a click handler: the folder picker needs the user's gesture. */
  const acceptOffer = useCallback(async (batchId, destination) => {
    const transfers = session.current.transfers;
    if (!transfers) return;
    const bridge = nativeBridge();
    if (bridge) {
      // Desktop app: a real folder (native dialog), or Downloads/Hopline <date>. Needed for Direct mode, and
      // faster than browser storage for everything else.
      const folder = destination === 'folder' ? await bridge.chooseFolder() : await bridge.defaultFolder();
      if (!folder) return; // dialog dismissed
      transfers.accept(batchId, { kind: 'native', folderId: folder.folderId, label: folder.label });
      return;
    }
    if (destination === 'folder') {
      let directory;
      try {
        directory = await window.showDirectoryPicker({
          id: 'hopline',
          mode: 'readwrite',
          startIn: 'downloads',
        });
      } catch (err) {
        if (err?.name === 'AbortError') return; // picker dismissed
        throw err;
      }
      transfers.accept(batchId, { kind: 'folder', directory });
    } else {
      transfers.accept(batchId, { kind: 'browser' });
    }
  }, []);

  useDebugHooks(session);

  return {
    ...state,
    createRoom,
    joinRoom,
    sendFiles,
    acceptOffer,
    declineOffer,
    cancelTransfer,
    leave: reset,
  };
}

/**
 * Opt-in testing aids (run `localStorage.setItem('hopline:debug', '1')` and reload):
 * window.__hopline.dropConnection() / dropServer() simulate network failures.
 */
function useDebugHooks(session) {
  useEffect(() => {
    let enabled = false;
    try {
      enabled = window.localStorage.getItem('hopline:debug') === '1';
    } catch {
      enabled = false;
    }
    if (!enabled) return undefined;
    window.__hopline = {
      dropConnection: () => session.current.connection?.session?.simulateDrop(),
      dropServer: () => session.current.signaling?.simulateDrop(),
      diagnostics: () => ({
        transfers: session.current.transfers?.diagnostics(),
        connection: session.current.connection?.diagnostics(),
      }),
      state: () => ({
        ...session.current,
        signaling: undefined,
        connection: undefined,
        transfers: undefined,
      }),
    };
    return () => {
      delete window.__hopline;
    };
  }, [session]);
}
