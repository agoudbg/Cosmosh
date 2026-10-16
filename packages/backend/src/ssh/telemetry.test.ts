import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelemetryOutput, TELEMETRY_COMMAND } from './telemetry.js';

test('parseTelemetryOutput parses CPU, memory, and network values', () => {
  assert.deepEqual(parseTelemetryOutput('12.5\n1048576 4194304\n100 200\n'), {
    cpuUsagePercent: 12.5,
    memoryUsedBytes: 1_048_576,
    memoryTotalBytes: 4_194_304,
    networkRxBytesTotal: 100,
    networkTxBytesTotal: 200,
  });
});

test('parseTelemetryOutput clamps CPU and counters to safe ranges', () => {
  assert.deepEqual(parseTelemetryOutput('125\n-1 0\n-2 -3\n'), {
    cpuUsagePercent: 100,
    memoryUsedBytes: 0,
    memoryTotalBytes: 0,
    networkRxBytesTotal: 0,
    networkTxBytesTotal: 0,
  });
});

test('parseTelemetryOutput rejects incomplete or malformed probe output', () => {
  assert.equal(parseTelemetryOutput('0\n1 2\n'), null);
  assert.equal(parseTelemetryOutput('not-a-number\n1 2\n3 4\n'), null);
  assert.equal(parseTelemetryOutput('1\ninvalid 2\n3 4\n'), null);
});

test('telemetry command preserves awk field references for the remote shell', () => {
  assert.equal(TELEMETRY_COMMAND.includes('if(\\$i==\\"id\\"){print 100-\\$(i-1);'), true);
  assert.equal(TELEMETRY_COMMAND.includes('idle=\\$5;total=0;for(i=2;i<=NF;i++){total+=\\$i}'), true);
});
