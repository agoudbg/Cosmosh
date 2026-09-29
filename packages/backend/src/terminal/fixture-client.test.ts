import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openFixtureTerminal } from './integration/fixture-client.js';

test('invalid fixture keys close the real latency proxy before SSH creates a socket', { timeout: 5_000 }, async (t) => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const directory = path.join(workspace, '.cosmosh/terminal-fixture');
  const configPath = path.join(directory, 'connection.json');
  const privateKeyPath = path.join(directory, 'id_ed25519');
  const originalRead = fs.readFileSync;
  const originalCreateServer = net.createServer;
  const proxies: { server: net.Server; closed: Promise<unknown[]> }[] = [];
  let descriptorReads = 0;
  let keyReads = 0;
  let listening = 0;

  t.after(async () => {
    // Restore both CJS objects and ESM bindings, even if the lifecycle assertion fails.
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const proxy of proxies) if (proxy.server.listening) proxy.server.close();
    await Promise.all(proxies.map((proxy) => proxy.closed));
  });
  t.mock.method(
    fs,
    'readFileSync',
    /** @param args Real filesystem read arguments. @returns Only fixture connection data is replaced. */
    (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => {
      if (args[0] === configPath) {
        descriptorReads += 1;
        return JSON.stringify({
          host: '127.0.0.1',
          port: 1,
          privateKeyPath,
          hostFingerprint: 'a'.repeat(64),
        });
      }
      if (args[0] === privateKeyPath) {
        keyReads += 1;
        return Buffer.from('invalid-fixture-private-key');
      }
      return originalRead(...args);
    },
  );
  t.mock.method(
    net,
    'createServer',
    /** @param args Actual proxy listener options. @returns The unmodified real TCP server. */
    (...args: Parameters<typeof net.createServer>): net.Server => {
      const server = originalCreateServer(...args);
      const closed = once(server, 'close');
      server.once('listening', () => {
        listening += 1;
      });
      proxies.push({ server, closed });
      return server;
    },
  );
  syncBuiltinESMExports();

  // Real ssh2 rejects this key synchronously, before it owns a socket or can emit close.
  await assert.rejects(
    openFixtureTerminal('bash', undefined, { roundTripLatencyMs: 150 }),
    /Cannot parse privateKey:/u,
  );
  assert.equal(descriptorReads, 1);
  assert.equal(keyReads, 1);
  assert.equal(listening, 1, 'the production proxy must have actually bound a loopback port');
  assert.equal(proxies.length, 1);
  const proxy = proxies[0]!;
  await t.waitFor(() => assert.equal(proxy.server.listening, false), { timeout: 1_000, interval: 10 });
  await proxy.closed;
  assert.equal(proxy.server.address(), null);
});
