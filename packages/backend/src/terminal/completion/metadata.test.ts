import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCommandMetadata } from './metadata.js';

test('case-sensitive flags retain their own value metadata when another flag differs only by case', () => {
  const lower = resolveCommandMetadata(['ssh-keygen', '-a', ''], 2, '', false);
  assert.ok(lower.some((item) => item.insertText === '16' && item.insertion === 'literal'));
  const upper = resolveCommandMetadata(['ssh-keygen', '-A', ''], 2, '', false);
  assert.equal(
    upper.some((item) => item.insertText === '16'),
    false,
  );
});
