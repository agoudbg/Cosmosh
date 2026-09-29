import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceFishInputBoundary, isFishInputBoundaryPending } from './editor-protocol.js';

test('Fish framing waits for split paste delimiters without storing pasted input', () => {
  let boundary = advanceFishInputBoundary(undefined, '\x1b[20');
  assert.equal(isFishInputBoundaryPending(boundary), true);
  boundary = advanceFishInputBoundary(boundary, '0~PRIVATE_SENTINEL\n中🐟\x1b[20');
  assert.deepEqual(boundary, { prefix: '\x1b[20', paste: true, uncertain: false });
  assert.equal(JSON.stringify(boundary).includes('PRIVATE_SENTINEL'), false);
  boundary = advanceFishInputBoundary(boundary, '1~');
  assert.equal(isFishInputBoundaryPending(boundary), false);
});

test('Fish framing accepts complete native keys and retains unknown-control uncertainty', () => {
  for (const input of ['echo 中🐟', '\x1b[D\x1b[3~', '\x01\x05', '\x03\r', '\t', '\x12', '\x1b[Z'])
    assert.equal(isFishInputBoundaryPending(advanceFishInputBoundary(undefined, input)), false);
  let boundary = advanceFishInputBoundary(undefined, '\x1b[');
  assert.equal(isFishInputBoundaryPending(boundary), true);
  boundary = advanceFishInputBoundary(boundary, 'D');
  assert.equal(isFishInputBoundaryPending(boundary), false);
  boundary = advanceFishInputBoundary(boundary, '\x18');
  assert.equal(isFishInputBoundaryPending(boundary), true);
  assert.equal(isFishInputBoundaryPending(advanceFishInputBoundary(boundary, 'ordinary')), true);
});

test('paste content cannot inject another start delimiter or expose arbitrary partial text', () => {
  const boundary = advanceFishInputBoundary(undefined, '\x1b[200~abc\x1b[200~PRIVATE\x1b[2x');
  assert.deepEqual(boundary, { prefix: '', paste: true, uncertain: false });
  assert.equal(isFishInputBoundaryPending(advanceFishInputBoundary(boundary, '\x1b[201~')), false);
});
