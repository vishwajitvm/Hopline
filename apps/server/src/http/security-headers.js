/**
 * Content-Security-Policy for the web app:
 *  - scripts only from this origin ('wasm-unsafe-eval' lets the SHA-256 WebAssembly module compile —
 *    it does NOT allow eval of JavaScript),
 *  - connections only to this origin and WebSocket/HTTPS endpoints (signaling may live on another host),
 *  - no plugins, no framing (clickjacking), no form posts, no <base> tricks.
 * Received files are opened as blob: URLs; a blob document inherits this policy, so even a hostile
 * HTML file couldn't run script in the app's origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

/** HSTS only when the request really arrived over HTTPS (directly or via a trusted proxy). */
export function isHttps(req, trustedProxyHops) {
  if (req.socket?.encrypted) return true;
  if (!trustedProxyHops) return false;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',').pop().trim() === 'https';
}

export const HSTS_HEADER = ['strict-transport-security', 'max-age=31536000; includeSubDomains'];
