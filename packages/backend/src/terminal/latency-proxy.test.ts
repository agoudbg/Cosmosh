import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import test from 'node:test';

import { openFixtureLatencyProxy } from './integration/latency-proxy.js';

for (const roundTripMs of [150, 300] as const) {
  test(
    'latency fixture delivers final bytes before both half-closes at ' + roundTripMs + ' ms',
    { timeout: 5_000 },
    async (t) => {
      const peers = new Set<Socket>();
      const target = createServer({ allowHalfOpen: true }, (socket) => {
        peers.add(socket);
        let received = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          received += chunk;
        });
        socket.once('end', () => socket.end('confirmed:' + received));
        socket.once('close', () => peers.delete(socket));
      });
      t.after(() => {
        for (const peer of peers) peer.destroy();
        target.close();
      });
      target.listen(0, '127.0.0.1');
      await once(target, 'listening');
      const address = target.address();
      assert.ok(address && typeof address !== 'string');
      const proxy = await openFixtureLatencyProxy(address.port, roundTripMs);
      t.after(proxy.close);
      const client = createConnection({ host: '127.0.0.1', port: proxy.port, allowHalfOpen: true });
      t.after(() => client.destroy());
      let received = '';
      client.setEncoding('utf8');
      client.on('data', (chunk: string) => {
        received += chunk;
      });
      const ended = once(client, 'end');
      await once(client, 'connect');
      client.end('final-payload');
      await ended;
      assert.equal(received, 'confirmed:final-payload');
    },
  );
}
