import { createConnection, createServer, type Socket } from 'node:net';

/** Test-only loopback proxy. It delays encrypted SSH bytes without interpreting or persisting them. */
export type FixtureLatencyProxy = { port: number; close: () => void };

/**
 * Adds a known round-trip delay while retaining actual ssh2, helper and Shell behavior.
 * @param port Disposable SSH server port. @param roundTripMs Added round-trip delay.
 * @returns A connection-scoped proxy; its owner must close it on both startup failure and normal exit.
 */
export const openFixtureLatencyProxy = async (port: number, roundTripMs: 150 | 300): Promise<FixtureLatencyProxy> => {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let pendingBytes = 0;
  let closed = false;
  const server = createServer({ allowHalfOpen: true }, (incoming) => {
    const outgoing = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
    for (const socket of [incoming, outgoing]) sockets.add(socket);
    /** @returns Nothing; a failed socket cannot leave its peer waiting forever. */
    const dispose = (): void => {
      incoming.destroy();
      outgoing.destroy();
    };
    for (const [source, target] of [
      [incoming, outgoing],
      [outgoing, incoming],
    ] as const) {
      source.on('error', dispose);
      source.on('close', () => {
        sockets.delete(source);
        // A normal half-close must allow the opposite leg's delayed final bytes and FIN to drain.
        if (!source.readableEnded || !source.writableFinished) dispose();
      });
      source.on('data', (data: Buffer) => {
        if (pendingBytes + data.length > 2 * 1024 * 1024) {
          dispose();
          return;
        }
        pendingBytes += data.length;
        const timer = setTimeout(() => {
          timers.delete(timer);
          pendingBytes -= data.length;
          if (!closed && !target.destroyed) {
            if (!target.write(data)) source.pause();
          }
        }, roundTripMs / 2);
        timers.add(timer);
      });
      target.on('drain', () => source.resume());
      source.on('end', () => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!closed && !target.destroyed) target.end();
        }, roundTripMs / 2);
        timers.add(timer);
      });
    }
  });
  /** @returns Nothing; every byte buffer, socket, listener and timer belongs to this fixture. */
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture proxy did not bind a loopback port.');
    return { port: address.port, close };
  } catch (error) {
    close();
    throw error;
  }
};
