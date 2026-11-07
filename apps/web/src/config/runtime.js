import { SIGNALING_PATH } from '@hopline/protocol';

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Where to reach the signaling server, in priority order:
 *  1. The desktop app's preload script (window.hopline.signalingUrl)
 *  2. VITE_SIGNALING_URL at build time (when the web app is hosted separately from the server)
 *  3. Same origin as the page — the default for `npm start`, the Vite dev proxy, Docker and Render
 */
export function resolveSignalingUrl() {
  const fromDesktop = window.hopline?.signalingUrl;
  if (fromDesktop) return fromDesktop;
  const fromBuild = import.meta.env.VITE_SIGNALING_URL;
  if (fromBuild) return fromBuild;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${SIGNALING_PATH}`;
}

/**
 * Fallback ICE servers (STUN only). The signaling server normally sends the real list when you create or
 * join a room — including short-lived TURN relay credentials — so nothing secret is baked into the build.
 */
export function resolveIceServers() {
  const stunUrls = splitList(import.meta.env.VITE_STUN_URLS);
  return [{ urls: stunUrls.length ? stunUrls : DEFAULT_STUN_URLS }];
}

/** Invite links only make sense when the page is served over HTTP(S) — not inside the desktop app. */
export function canShareInviteLinks() {
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

export function isLoopbackHost(hostname = window.location.hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
