import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDroppedText } from './use-terminal-text-drop-zone';

test('resolveDroppedText reads the legacy Text drag payload', () => {
  const requestedTypes: string[] = [];
  const dataTransfer = {
    getData: (type: string): string => {
      requestedTypes.push(type);
      return type === 'Text' ? 'legacy text' : '';
    },
  };

  assert.equal(resolveDroppedText(dataTransfer), 'legacy text');
  assert.deepEqual(requestedTypes, ['text/plain', 'text', 'Text']);
});

test('resolveDroppedText prefers the standard plain-text payload', () => {
  const dataTransfer = {
    getData: (type: string): string => (type === 'text/plain' ? 'plain text' : 'legacy text'),
  };

  assert.equal(resolveDroppedText(dataTransfer), 'plain text');
});
