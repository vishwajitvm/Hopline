import { randomBytes } from 'node:crypto';
import { Direction, FrameCipher, POINT_BYTES, createCpaceParty, deriveSessionKey } from './crypto.js';
import { ProtocolError } from './errors.js';

const MAGIC = Buffer.from('HOPL');
const VERSION = 2;
const NONCE_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1;

/**
 * Cleartext greeting + CPace key exchange (see crypto.js), then both sides hold the same session key
 * only if they used the same code:
 *
 *   sender   → MAGIC ‖ VERSION ‖ senderNonce(16)
 *   receiver → MAGIC ‖ VERSION ‖ receiverNonce(16) ‖ receiverShare(32)
 *   sender   → senderShare(32)
 *
 * Neither side has proven it knows the code yet; that happens with the first encrypted messages
 * (receiver HELLO, then sender MANIFEST), which only decrypt under the right key.
 */
export async function performHandshake({ socket, reader, role, code }) {
  const header = Buffer.concat([MAGIC, Buffer.of(VERSION)]);
  let senderNonce;
  let receiverNonce;
  let party;
  let peerShare;

  if (role === 'sender') {
    senderNonce = randomBytes(NONCE_BYTES);
    socket.write(Buffer.concat([header, senderNonce]));
    const reply = await reader.readExact(HEADER_BYTES + NONCE_BYTES + POINT_BYTES);
    assertHeader(reply);
    receiverNonce = Buffer.from(reply.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES));
    peerShare = Buffer.from(reply.subarray(HEADER_BYTES + NONCE_BYTES));
    party = createCpaceParty({ code, senderNonce, receiverNonce });
    socket.write(party.publicShare);
  } else {
    const greeting = await reader.readExact(HEADER_BYTES + NONCE_BYTES);
    assertHeader(greeting);
    senderNonce = Buffer.from(greeting.subarray(HEADER_BYTES));
    receiverNonce = randomBytes(NONCE_BYTES);
    party = createCpaceParty({ code, senderNonce, receiverNonce });
    socket.write(Buffer.concat([header, receiverNonce, party.publicShare]));
    peerShare = Buffer.from(await reader.readExact(POINT_BYTES));
  }

  const isSender = role === 'sender';
  const key = deriveSessionKey({
    sharedSecret: party.sharedSecret(peerShare),
    senderNonce,
    receiverNonce,
    senderShare: isSender ? party.publicShare : peerShare,
    receiverShare: isSender ? peerShare : party.publicShare,
  });
  return new FrameCipher(key, isSender ? Direction.SENDER : Direction.RECEIVER);
}

function assertHeader(greeting) {
  if (!greeting.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ProtocolError('The other side is not a Hopline client.');
  }
  const version = greeting[MAGIC.length];
  if (version !== VERSION) {
    throw new ProtocolError(
      `The other side uses Hopline protocol v${version}; this version speaks v${VERSION}.`,
    );
  }
}
