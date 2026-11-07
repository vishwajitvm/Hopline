/**
 * Signaling protocol between a browser/desktop client and the Hopline server.
 * Every message is a JSON object with a string `type`.
 *
 * Client → server:
 *   { type: 'create' }
 *   { type: 'join', code }
 *   { type: 'rejoin', code, token }     // after a dropped WebSocket, within the reconnect grace period
 *   { type: 'signal', data }            // relayed verbatim to the other peer
 *   { type: 'leave' }                   // intentional: closes the room immediately
 *   { type: 'ping' }                    // keep-alive through proxies and idle-sleeping hosts
 *
 * Server → client:
 *   { type: 'created', code, token, iceServers }
 *   { type: 'joined', code, token, iceServers }
 *   { type: 'rejoined', code, peerPresent, iceServers }
 *   { type: 'peer-joined' }             // sent to the room creator; it starts the WebRTC offer
 *   { type: 'peer-disconnected' }       // the other side's connection dropped; it may come back
 *   { type: 'peer-reconnected' }
 *   { type: 'peer-left' }               // the other side left for good; the room is closed
 *   { type: 'signal', data }
 *   { type: 'error', reason, message }
 *
 * `token` is a per-member secret that lets the same device reclaim its place after a reconnect.
 * `iceServers` are STUN/TURN servers (TURN credentials are short-lived and issued per member).
 */

export const SIGNALING_PATH = '/ws';
export const MAX_SIGNAL_MESSAGE_BYTES = 64 * 1024;
export const MEMBER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export const ClientMessage = Object.freeze({
  CREATE: 'create',
  JOIN: 'join',
  REJOIN: 'rejoin',
  SIGNAL: 'signal',
  LEAVE: 'leave',
  PING: 'ping',
});

export const ServerMessage = Object.freeze({
  CREATED: 'created',
  JOINED: 'joined',
  REJOINED: 'rejoined',
  PEER_JOINED: 'peer-joined',
  PEER_DISCONNECTED: 'peer-disconnected',
  PEER_RECONNECTED: 'peer-reconnected',
  PEER_LEFT: 'peer-left',
  SIGNAL: 'signal',
  ERROR: 'error',
});

export const ErrorReason = Object.freeze({
  BAD_MESSAGE: 'bad-message',
  UNKNOWN_TYPE: 'unknown-type',
  INVALID_CODE: 'invalid-code',
  NOT_FOUND: 'not-found',
  ROOM_FULL: 'room-full',
  EXPIRED: 'expired',
  RATE_LIMITED: 'rate-limited',
  NOT_IN_ROOM: 'not-in-room',
  REJOIN_FAILED: 'rejoin-failed',
});

export const ErrorMessages = Object.freeze({
  [ErrorReason.BAD_MESSAGE]: 'The server could not read that message.',
  [ErrorReason.UNKNOWN_TYPE]: 'The server does not understand that request.',
  [ErrorReason.INVALID_CODE]: 'Room codes are 6 letters and numbers, like K7Q2XM.',
  [ErrorReason.NOT_FOUND]: 'No room with that code. Check the code and try again.',
  [ErrorReason.ROOM_FULL]:
    'That room already has two devices in it. If this device was one of them, reopen Hopline in the same tab within ' +
    'two minutes and it reconnects by itself; otherwise ask for a new code.',
  [ErrorReason.EXPIRED]: 'This room expired before anyone joined. Create a new one.',
  [ErrorReason.RATE_LIMITED]: 'Too many requests. Slow down and try again.',
  [ErrorReason.NOT_IN_ROOM]: 'You are not in a room.',
  [ErrorReason.REJOIN_FAILED]: 'The connection was gone too long and the room was closed.',
});
