import { createHmac, randomBytes } from 'node:crypto';

/**
 * Builds the STUN/TURN list handed to each room member.
 *
 * With TURN_SECRET set, credentials follow the "TURN REST API" scheme that coturn implements
 * (`use-auth-secret`): username = "<unix-expiry>:<random>", credential = base64(HMAC-SHA1(secret, username)).
 * They expire on their own, so a leaked credential is only useful for a limited time, and the
 * secret itself never leaves the server.
 */
export function createIceServerProvider({ stunUrls, turn }, now = Date.now) {
  return function iceServers({ withTurn = true } = {}) {
    const servers = [];
    if (stunUrls.length > 0) servers.push({ urls: [...stunUrls] });
    if (!withTurn || turn.urls.length === 0) return servers;

    if (turn.secret) {
      const expiresAt = Math.floor(now() / 1000) + turn.ttlSeconds;
      const username = `${expiresAt}:${randomBytes(6).toString('hex')}`;
      const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
      servers.push({ urls: [...turn.urls], username, credential });
    } else {
      servers.push({ urls: [...turn.urls], username: turn.username, credential: turn.credential });
    }
    return servers;
  };
}
