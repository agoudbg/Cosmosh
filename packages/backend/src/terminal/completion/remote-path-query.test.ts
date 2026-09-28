import assert from 'node:assert/strict';
import test from 'node:test';

import type { ShellPathQueryRequest, ShellPathQueryResult } from '@cosmosh/api-contract';

import {
  emptyPathResult,
  normalizePathQueryResult,
  prepareRemotePathQuery,
  RemotePathQueryController,
} from './remote-path-query.js';

const request: ShellPathQueryRequest = {
  directory: '/actual',
  fragment: 'file',
  directoriesOnly: false,
  fuzzyMatch: false,
  limit: 10,
};
const result: ShellPathQueryResult = { status: 'ok', scanned: 1000, entries: [{ name: ' file 🐟 ', kind: 'file' }] };

test('path transport rejects malformed structures and preserves complete literal filename data', () => {
  assert.deepEqual(normalizePathQueryResult(result), result);
  for (const value of [
    { ...result, scanned: 10_001 },
    { ...result, scanned: 1.5 },
    { ...result, status: 'unexpected' },
    { ...result, status: 'denied' },
    { ...result, entries: Array(129).fill(result.entries[0]) },
    ...['../x', '.', '..', 'bad\u0000', '\ud800'].map((name) => ({ ...result, entries: [{ name, kind: 'file' }] })),
  ])
    assert.equal(normalizePathQueryResult(value), null);
});

test('remote path intent resolves only unquoted HOME and preserves symlink parent components', () => {
  const directory = { logical: '/link', physical: '/space folder ', home: '/custom home ' };
  const options = { directoriesOnly: false, fuzzyMatch: false, limit: 10 };
  const relative = prepareRemotePathQuery({ prefix: './link/../fi', homeRelative: false }, directory, options)!;
  assert.equal(relative.request.directory, '/space folder /./link/../');
  assert.equal(relative.insertPrefix, './link/../');
  assert.equal(
    prepareRemotePathQuery({ prefix: '', homeRelative: true }, directory, options)?.request.directory,
    '/space folder /',
  );
  const home = prepareRemotePathQuery({ prefix: '~/fi', homeRelative: true }, directory, options)!;
  assert.equal(home.request.directory, '/custom home /');
  assert.equal(home.insertPrefix, '/custom home /');
  assert.equal(home.displayPrefix, '~/');
  assert.equal(
    prepareRemotePathQuery({ prefix: '~', homeRelative: true }, directory, options)?.request.directory,
    '/custom home /',
  );
  assert.equal(
    prepareRemotePathQuery({ prefix: '~/fi', homeRelative: false }, directory, options)?.request.directory,
    '/space folder /~/',
  );
  assert.equal(
    prepareRemotePathQuery({ prefix: '~/fi', homeRelative: true }, { ...directory, home: null }, options),
    null,
  );
});

test('path queries coalesce, cancel stale work and erase permission-scoped caches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls: Array<{ signal: AbortSignal; finish: (result: ShellPathQueryResult) => void }> = [];
  const controller = new RemotePathQueryController(
    async (_request, signal) => await new Promise((finish) => calls.push({ signal, finish })),
  );
  const first = controller.query(request);
  const equal = controller.query({ ...request });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  calls[0].finish(result);
  const observed = await first;
  observed.entries[0].name = 'mutated';
  assert.deepEqual(await equal, result);
  assert.deepEqual(await controller.query(request), result);
  assert.equal(calls.length, 1);
  const other = controller.query({ ...request, fragment: 'other' });
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.deepEqual(await controller.query(request), result);
  assert.equal(calls[1].signal.aborted, true, 'a cache hit still cancels obsolete work');
  calls[1].finish(result);
  assert.deepEqual(await other, emptyPathResult('cancelled'));
  t.mock.timers.tick(2000);
  assert.equal((controller as unknown as { cache: Map<string, unknown> }).cache.size, 0);
  const expired = controller.query(request);
  await Promise.resolve();
  assert.equal(calls.length, 3);
  controller.clear();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].finish(result);
  assert.deepEqual(await expired, emptyPathResult('cancelled'));
});

test('path executor exceptions are contained and never cached', async () => {
  let calls = 0;
  const controller = new RemotePathQueryController(() => {
    calls += 1;
    throw new Error('private path');
  });
  assert.deepEqual(await controller.query(request), emptyPathResult('unavailable'));
  assert.deepEqual(await controller.query(request), emptyPathResult('unavailable'));
  assert.equal(calls, 2);
  controller.clear();
});
