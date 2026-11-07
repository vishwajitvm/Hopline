import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CODE_ALPHABET, generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../src/index.js';

test('normalizeRoomCode cleans user input', () => {
  assert.equal(normalizeRoomCode(' k7q-2xm '), 'K7Q2XM');
  assert.equal(normalizeRoomCode('abcdefghij'), 'ABCDEF');
  assert.equal(normalizeRoomCode(null), '');
});

test('isValidRoomCode accepts only alphabet codes of the right length', () => {
  assert.equal(isValidRoomCode('K7Q2XM'), true);
  assert.equal(isValidRoomCode('K7Q2X'), false);
  assert.equal(isValidRoomCode('K7Q2X0'), false); // 0 is excluded
  assert.equal(isValidRoomCode(123456), false);
});

test('generateRoomCode uses the injected random source', () => {
  assert.equal(
    generateRoomCode(() => 0),
    ROOM_CODE_ALPHABET[0].repeat(6),
  );
  const random = generateRoomCode((max) => Math.floor(Math.random() * max));
  assert.equal(isValidRoomCode(random), true);
});
