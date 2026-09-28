import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTerminalClientMessage } from './shared.js';

test('input acknowledgements accept only bounded opaque identifiers', () => {
  const token = '01234567-89ab-4def-8123-456789abcdef';
  const input = { type: 'input', data: 'cd /example\r', submissionToken: token };
  assert.deepEqual(normalizeTerminalClientMessage(Buffer.from(JSON.stringify(input))), input);
  for (const submissionToken of ['', 'private input text', 'a'.repeat(4096), {}, 1, null]) {
    assert.equal(normalizeTerminalClientMessage(Buffer.from(JSON.stringify({ ...input, submissionToken }))), null);
  }
  assert.deepEqual(normalizeTerminalClientMessage(Buffer.from('{"type":"input","data":"x"}')), {
    type: 'input',
    data: 'x',
  });
});
