import assert from 'node:assert/strict';
import test from 'node:test';

import { McpConnectionCapacity } from './connection-capacity.js';

test('capacity reservations enforce one shared hard limit and release idempotently', () => {
  const capacity = new McpConnectionCapacity(2);
  const first = capacity.tryReserve();
  const second = capacity.tryReserve();

  assert.ok(first);
  assert.ok(second);
  assert.equal(capacity.count(), 2);
  assert.equal(capacity.tryReserve(), null);

  first.release();
  first.release();
  assert.equal(capacity.count(), 1);

  const replacement = capacity.tryReserve();
  assert.ok(replacement);
  assert.equal(capacity.count(), 2);

  second.release();
  replacement.release();
  assert.equal(capacity.count(), 0);
});
