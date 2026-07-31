import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpCommandPolicy, McpServerCommandPolicy } from '@cosmosh/api-contract';
import { resolveEffectiveMcpCommandPolicy } from '@cosmosh/api-contract';

/**
 * Documents the full override matrix the run_command policy gate depends on:
 * a per-server `default` inherits the global setting, any explicit per-server
 * value wins outright.
 */
const GLOBALS: McpCommandPolicy[] = ['off', 'ask', 'allowWithinConnection'];
const SERVER_OVERRIDES: McpServerCommandPolicy[] = ['default', 'off', 'ask', 'allowWithinConnection'];

test('default per-server policy inherits every global setting verbatim', () => {
  for (const globalPolicy of GLOBALS) {
    assert.equal(resolveEffectiveMcpCommandPolicy('default', globalPolicy), globalPolicy);
  }
});

test('an explicit per-server override wins over every global setting', () => {
  for (const serverPolicy of SERVER_OVERRIDES) {
    if (serverPolicy === 'default') {
      continue;
    }

    for (const globalPolicy of GLOBALS) {
      assert.equal(resolveEffectiveMcpCommandPolicy(serverPolicy, globalPolicy), serverPolicy);
    }
  }
});
