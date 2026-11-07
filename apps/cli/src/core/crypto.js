import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { AuthError, ProtocolError } from './errors.js';

const KEY_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
export const POINT_BYTES = 32;

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const CPACE_DST = 'hopline/v2/cpace-ristretto255';
const HKDF_INFO = Buffer.from('hopline/v2 session key');

export const Direction = Object.freeze({ SENDER: 0, RECEIVER: 1 });

const lengthPrefixed = (bytes) => {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

/**
 * CPace (a balanced PAKE, draft-irtf-cfrg-cpace) over ristretto255, via the audited @noble/curves library.
 *
 *   G   = hash_to_curve(code ‖ senderNonce ‖ receiverNonce)   — a generator only the code-holders share
 *   Y_i = y_i · G     (y_i random per connection)
 *   K   = y_s · Y_r = y_r · Y_s
 *
 * Why this matters: whoever doesn't know the code gets exactly ONE guess per connection. Unlike a
 * key derived from the code with a KDF, a recorded handshake gives an attacker nothing to brute-force offline
 * (testing a guess would require solving Diffie-Hellman). Both nonces bind the generator to this session.
 */
export function createCpaceParty({ code, senderNonce, receiverNonce }) {
  const message = Buffer.concat([lengthPrefixed(Buffer.from(code, 'utf8')), senderNonce, receiverNonce]);
  const generator = ristretto255_hasher.hashToCurve(message, { DST: CPACE_DST });
  let scalar = 0n;
  while (scalar === 0n) scalar = BigInt(`0x${randomBytes(64).toString('hex')}`) % ORDER;
  return {
    publicShare: Buffer.from(generator.multiply(scalar).toBytes()),
    /** Validates the peer's share and returns the shared secret (32 bytes). */
    sharedSecret(peerShare) {
      let peer;
      try {
        peer = Point.fromBytes(new Uint8Array(peerShare));
      } catch {
        throw new ProtocolError('The other side sent an invalid key share.');
      }
      if (peer.is0()) throw new ProtocolError('The other side sent an invalid key share.');
      const shared = peer.multiply(scalar);
      if (shared.is0()) throw new ProtocolError('Key exchange failed.');
      return Buffer.from(shared.toBytes());
    },
  };
}

/** Session key bound to both nonces and both key shares (the full transcript). */
export function deriveSessionKey({ sharedSecret, senderNonce, receiverNonce, senderShare, receiverShare }) {
  const salt = Buffer.concat([senderNonce, receiverNonce]);
  const info = Buffer.concat([HKDF_INFO, senderShare, receiverShare]);
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, KEY_BYTES));
}

/**
 * AES-256-GCM with deterministic nonces: [4-byte direction][8-byte counter].
 * Each side counts its own messages, so nonces never repeat, and any dropped, reordered
 * or replayed frame fails authentication.
 */
export class FrameCipher {
  #key;
  #sendDirection;
  #receiveDirection;
  #sendCounter = 0n;
  #receiveCounter = 0n;

  constructor(key, direction) {
    this.#key = key;
    this.#sendDirection = direction;
    this.#receiveDirection = direction === Direction.SENDER ? Direction.RECEIVER : Direction.SENDER;
  }

  static #nonce(direction, counter) {
    const nonce = Buffer.alloc(NONCE_BYTES);
    nonce.writeUInt32BE(direction, 0);
    nonce.writeBigUInt64BE(counter, 4);
    return nonce;
  }

  /** Encrypts `parts` (concatenated) and returns ciphertext ‖ tag. Taking parts avoids an extra copy. */
  seal(...parts) {
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.#key,
      FrameCipher.#nonce(this.#sendDirection, this.#sendCounter++),
    );
    const encrypted = parts.map((part) => cipher.update(part));
    encrypted.push(cipher.final(), cipher.getAuthTag());
    return Buffer.concat(encrypted);
  }

  open(sealed) {
    if (sealed.length < TAG_BYTES) throw new AuthError('Received a truncated message.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      FrameCipher.#nonce(this.#receiveDirection, this.#receiveCounter++),
    );
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new AuthError(
        'Could not decrypt data from the other device — the code is wrong or the data was altered.',
      );
    }
  }
}
