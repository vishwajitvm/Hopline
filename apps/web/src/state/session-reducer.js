/**
 * Session lifecycle:
 *
 *   idle ─create/join─▶ starting ─created─▶ waiting ─peer-joined─┐
 *                          │                                     ▼
 *                          └──────joined──────────────────▶ connecting ─channel open─▶ connected
 *                                                                                   ▲      │
 *                                                       channel open (resume) ──────┘      │ connection lost
 *                                                                          reconnecting ◀──┘
 *
 *   Any phase after "starting" can end ("ended"): the peer left, or reconnecting timed out.
 *   Received files stay saveable until the user starts over. Errors before connecting return to "idle".
 */
export const Phase = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  WAITING: 'waiting',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ENDED: 'ended',
});

export const SessionAction = Object.freeze({
  START: 'start',
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  ROOM_RESUMED: 'room-resumed',
  PEER_JOINED: 'peer-joined',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  PEER_PRESENCE: 'peer-presence',
  SERVER_PRESENCE: 'server-presence',
  SERVER_WAKING: 'server-waking',
  CONNECTION_INFO: 'connection-info',
  SAFETY_CODE: 'safety-code',
  TRANSFERS_CHANGED: 'transfers-changed',
  NOTICE: 'notice',
  ENDED: 'ended',
  FAILED: 'failed',
  RESET: 'reset',
});

export const initialSessionState = Object.freeze({
  phase: Phase.IDLE,
  code: '',
  role: null,
  error: '',
  notice: '',
  transfers: [],
  connection: null,
  safetyCode: null,
  peerOnline: false,
  serverOnline: true,
  /** The first server connection is taking a while (a sleeping free-plan host waking up). */
  serverWaking: false,
  relayAvailable: false,
});

export function sessionReducer(state, action) {
  switch (action.type) {
    case SessionAction.START:
      return { ...initialSessionState, phase: Phase.STARTING };
    case SessionAction.ROOM_CREATED:
      return {
        ...state,
        phase: Phase.WAITING,
        code: action.code,
        role: 'host',
        relayAvailable: action.relayAvailable,
      };
    case SessionAction.ROOM_JOINED:
      return {
        ...state,
        phase: Phase.CONNECTING,
        code: action.code,
        role: 'guest',
        peerOnline: true,
        relayAvailable: action.relayAvailable,
      };
    case SessionAction.ROOM_RESUMED:
      return {
        ...state,
        phase: action.peerPresent ? Phase.CONNECTING : Phase.WAITING,
        code: action.code,
        role: action.role,
        peerOnline: action.peerPresent,
        relayAvailable: action.relayAvailable,
      };
    case SessionAction.PEER_JOINED:
      return { ...state, phase: Phase.CONNECTING, peerOnline: true };
    case SessionAction.CONNECTED:
      return { ...state, phase: Phase.CONNECTED, notice: '' };
    case SessionAction.RECONNECTING:
      return state.phase === Phase.ENDED
        ? state
        : { ...state, phase: Phase.RECONNECTING, connection: null, safetyCode: null };
    case SessionAction.PEER_PRESENCE:
      return { ...state, peerOnline: action.online };
    case SessionAction.SERVER_WAKING:
      return state.phase === Phase.STARTING ? { ...state, serverWaking: true } : state;
    case SessionAction.SERVER_PRESENCE:
      return { ...state, serverOnline: action.online };
    case SessionAction.CONNECTION_INFO:
      return { ...state, connection: action.info };
    case SessionAction.SAFETY_CODE:
      return { ...state, safetyCode: action.code };
    case SessionAction.TRANSFERS_CHANGED:
      return { ...state, transfers: action.transfers };
    case SessionAction.NOTICE:
      return { ...state, notice: action.notice };
    case SessionAction.ENDED:
      return state.phase === Phase.ENDED
        ? state
        : { ...state, phase: Phase.ENDED, notice: action.notice, connection: null };
    case SessionAction.FAILED:
      return { ...initialSessionState, error: action.error };
    case SessionAction.RESET:
      return initialSessionState;
    default:
      return state;
  }
}
