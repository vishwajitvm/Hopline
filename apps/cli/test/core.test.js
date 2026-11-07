import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { Direction, FrameCipher, createCpaceParty, deriveSessionKey } from '../src/core/crypto.js';
import { AuthError, ConnectionClosedError, ProtocolError } from '../src/core/errors.js';
import { FrameReader, encodeFrame } from '../src/core/framing.js';
import { generateTransferCode, parseTransferCode } from '../src/core/transfer-code.js';
import { WORDS } from '../src/core/wordlist.js';
import { describeRisk, sanitizeText, toSafePathSegments } from '../src/utils/files.js';
import { broadcastAddresses, parseHostPort } from '../src/utils/network.js';

describe('transfer codes', () => {
  test('word list has 256 unique, lowercase words', () => {
    assert.equal(WORDS.length, 256);
    assert.equal(new Set(WORDS).size, 256);
    assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)));
  });

  test('generated codes parse back, and input is normalized', () => {
    const code = generateTransferCode();
    assert.equal(parseTransferCode(code).code, code);
    assert.deepEqual(parseTransferCode('  42 Amber River Falcon '), {
      code: '42-amber-river-falcon',
      nameplate: '42',
    });
    assert.throws(() => parseTransferCode('hello'), /doesn't look like a Hopline code/);
  });
});

describe('CPace key exchange', () => {
  function exchange(senderCode, receiverCode) {
    const senderNonce = randomBytes(16);
    const receiverNonce = randomBytes(16);
    const sender = createCpaceParty({ code: senderCode, senderNonce, receiverNonce });
    const receiver = createCpaceParty({ code: receiverCode, senderNonce, receiverNonce });
    const common = {
      senderNonce,
      receiverNonce,
      senderShare: sender.publicShare,
      receiverShare: receiver.publicShare,
    };
    return {
      senderKey: deriveSessionKey({ ...common, sharedSecret: sender.sharedSecret(receiver.publicShare) }),
      receiverKey: deriveSessionKey({ ...common, sharedSecret: receiver.sharedSecret(sender.publicShare) }),
      sender,
      receiver,
    };
  }

  test('the same code yields the same key; a different code does not', () => {
    const same = exchange('42-amber-river-falcon', '42-amber-river-falcon');
    assert.ok(same.senderKey.equals(same.receiverKey));
    const different = exchange('42-amber-river-falcon', '42-amber-river-fox');
    assert.ok(!different.senderKey.equals(different.receiverKey));
  });

  test('fresh randomness every session (no reusable transcript)', () => {
    const a = exchange('11-a-b-c', '11-a-b-c');
    const b = exchange('11-a-b-c', '11-a-b-c');
    assert.ok(!a.senderKey.equals(b.senderKey));
    assert.ok(!a.sender.publicShare.equals(b.sender.publicShare));
  });

  test('rejects invalid and identity key shares', () => {
    const party = createCpaceParty({
      code: '11-a-b-c',
      senderNonce: randomBytes(16),
      receiverNonce: randomBytes(16),
    });
    assert.throws(() => party.sharedSecret(Buffer.alloc(32)), ProtocolError); // identity point
    assert.throws(() => party.sharedSecret(Buffer.alloc(32, 0xff)), ProtocolError); // not a valid encoding
    assert.throws(() => party.sharedSecret(Buffer.alloc(31)), ProtocolError);
  });
});

describe('FrameCipher', () => {
  const key = Buffer.alloc(32, 7);

  test('round-trips and detects tampering, replay and reordering', () => {
    const sender = new FrameCipher(key, Direction.SENDER);
    const receiver = new FrameCipher(key, Direction.RECEIVER);

    const first = sender.seal(Buffer.from('hello '), Buffer.from('world'));
    assert.equal(receiver.open(first).toString(), 'hello world');

    const tampered = Buffer.from(sender.seal(Buffer.from('second')));
    tampered[0] ^= 1;
    assert.throws(() => receiver.open(tampered), AuthError);

    const replayer = new FrameCipher(key, Direction.RECEIVER);
    replayer.open(first);
    assert.throws(() => replayer.open(first), AuthError); // replayed frame

    sender.seal(Buffer.from('skipped'));
    const later = sender.seal(Buffer.from('later'));
    assert.throws(() => new FrameCipher(key, Direction.RECEIVER).open(later), AuthError); // out of order
  });

  test('a different key cannot decrypt', () => {
    const sealed = new FrameCipher(key, Direction.SENDER).seal(Buffer.from('secret'));
    assert.throws(() => new FrameCipher(Buffer.alloc(32, 8), Direction.RECEIVER).open(sealed), AuthError);
  });
});

describe('FrameReader', () => {
  test('reassembles frames split across arbitrary chunk boundaries', async () => {
    const stream = new PassThrough();
    const reader = new FrameReader(stream);
    const wire = Buffer.concat([encodeFrame(Buffer.from('alpha')), encodeFrame(Buffer.from('beta-gamma'))]);
    for (let i = 0; i < wire.length; i += 3) stream.write(wire.subarray(i, i + 3));
    stream.end();
    assert.equal((await reader.readFrame()).toString(), 'alpha');
    assert.equal((await reader.readFrame()).toString(), 'beta-gamma');
    await assert.rejects(reader.readFrame(), ConnectionClosedError);
  });
});

describe('path safety', () => {
  test('keeps folder structure but blocks traversal and invalid names', () => {
    assert.deepEqual(toSafePathSegments('photos/2024/a.jpg'), ['photos', '2024', 'a.jpg']);
    assert.deepEqual(toSafePathSegments('/etc/passwd'), ['etc', 'passwd']);
    assert.deepEqual(toSafePathSegments('C:\\x\\y?.txt'), ['C_', 'x', 'y_.txt']);
    assert.deepEqual(toSafePathSegments('con.txt'), ['_con.txt']);
    assert.throws(() => toSafePathSegments('../../outside'), /unsafe path/);
    assert.throws(() => toSafePathSegments(''), /invalid file name/);
  });

  test('strips terminal escapes and disguising characters', () => {
    assert.equal(sanitizeText('\u001b]52;c;ZXZpbA==\u0007x'), '_]52;c;ZXZpbA==_x');
    const rlo = String.fromCharCode(0x202e);
    assert.deepEqual(toSafePathSegments(`invoice${rlo}fdp.exe`), ['invoicefdp.exe']);
    const zeroWidth = String.fromCharCode(0x200b) + String.fromCharCode(0x00ad);
    assert.deepEqual(toSafePathSegments(`a${zeroWidth}b\u0085.txt`), ['ab_.txt']);
  });

  test('flags programs and hidden files for the confirmation prompt', () => {
    const files = ['run.EXE', '.ssh/authorized_keys', 'photo.jpg'].map((p) => ({
      segments: toSafePathSegments(p),
    }));
    assert.match(describeRisk(files), /1 program\/script file\(s\) and 1 hidden file\(s\)/);
    assert.equal(describeRisk([{ segments: ['a.txt'] }]), null);
  });
});

describe('network helpers', () => {
  test('parses host:port', () => {
    assert.deepEqual(parseHostPort('192.168.1.20:5000'), { host: '192.168.1.20', port: 5000 });
    assert.throws(() => parseHostPort('192.168.1.20'), /isn't a valid address/);
  });

  test('always includes global broadcast and loopback', () => {
    const targets = broadcastAddresses();
    assert.ok(targets.includes('255.255.255.255'));
    assert.ok(targets.includes('127.0.0.1'));
  });
});
