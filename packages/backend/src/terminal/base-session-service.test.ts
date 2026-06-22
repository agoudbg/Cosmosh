import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  BaseTerminalSessionService,
  resolveTerminalWebSocketSessionId,
  TERMINAL_CLIENT_MESSAGE_MAX_BYTES,
  type TerminalManagedSessionBase,
} from './base-session-service.js';

type OutboundMessage =
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'exit';
      reason: string;
    };

type MockSession = TerminalManagedSessionBase & {
  sent: OutboundMessage[];
};

class MockTerminalService extends BaseTerminalSessionService<MockSession, OutboundMessage> {
  public constructor(port = 0) {
    super({
      host: '127.0.0.1',
      port,
      pathPrefix: '/ws/test/',
    });
  }

  public addSession(session: MockSession): void {
    this.registerSession(session);
  }

  public pushOutput(session: MockSession, data: string): void {
    this.sendServerMessage(session, {
      type: 'output',
      data,
    });
  }

  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  protected handleClientMessage(): void {
    // No-op for test.
  }

  protected onSessionAttached(): void {
    // No-op for test.
  }

  protected disposeSession(sessionId: string): void {
    this.disposeSessionWithCommonLifecycle(sessionId, 'ws.sessionClosedByApiRequest', undefined, {
      createExitMessage: (reason) => ({ type: 'exit', reason }),
      disposeTransport: () => undefined,
    });
  }
}

/**
 * Reserves an available loopback port for a WebSocket integration test.
 *
 * @returns Available TCP port.
 */
const findAvailablePort = async (): Promise<number> => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a test port.'));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
};

/**
 * Waits for a WebSocket client to open or fail.
 *
 * @param socket WebSocket client.
 * @returns Promise resolved after the connection opens.
 */
const waitForSocketOpen = async (socket: WebSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
};

/**
 * Waits for a WebSocket client to close.
 *
 * @param socket WebSocket client.
 * @returns Close code emitted by the server.
 */
const waitForSocketClose = async (socket: WebSocket): Promise<number> => {
  return await new Promise<number>((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
};

/**
 * Waits for and parses one server message.
 *
 * @param socket WebSocket client.
 * @returns Parsed outbound message.
 */
const waitForSocketMessage = async (socket: WebSocket): Promise<OutboundMessage> => {
  return await new Promise<OutboundMessage>((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as OutboundMessage);
      } catch (error: unknown) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
};

/**
 * Creates a reusable mock terminal session.
 *
 * @param sessionId Session identifier.
 * @returns Mock session record.
 */
const createMockSession = (sessionId: string): MockSession => {
  return {
    sessionId,
    websocketToken: 'token-1',
    pendingOutput: [],
    pendingOutputBytes: 0,
    pendingOutputDropCount: 0,
    attachTimeout: setTimeout(() => undefined, 60_000),
    t: ((key: string) => key) as MockSession['t'],
    locale: 'en',
    socket: null,
    disposed: false,
    telemetryInterval: null,
    historySyncTimeout: null,
    sent: [],
  };
};

test('pending output buffer enforces hard caps and tracks dropped chunks', async () => {
  const service = new MockTerminalService();

  try {
    const session = createMockSession('session-1');

    service.addSession(session);

    for (let index = 0; index < 3000; index += 1) {
      service.pushOutput(session, `line-${index.toString().padStart(4, '0')}::${'x'.repeat(600)}`);
    }

    assert.ok(session.pendingOutput.length <= 2048);
    assert.ok(session.pendingOutputBytes <= 1024 * 1024);
    assert.ok(session.pendingOutputDropCount > 0);
  } finally {
    await service.stop();
  }
});

test('WebSocket session path decoding rejects malformed percent-encoding', () => {
  assert.equal(resolveTerminalWebSocketSessionId('/ws/test/session-1', '/ws/test/'), 'session-1');
  assert.equal(resolveTerminalWebSocketSessionId('/ws/test/%', '/ws/test/'), null);
  assert.equal(resolveTerminalWebSocketSessionId('/ws/test/', '/ws/test/'), null);
  assert.equal(resolveTerminalWebSocketSessionId('/ws/other/session-1', '/ws/test/'), null);
});

test('replacing a WebSocket does not let the stale close event dispose the session', async () => {
  const port = await findAvailablePort();
  const service = new MockTerminalService(port);
  const session = createMockSession('session-reconnect');
  service.addSession(session);

  const firstSocket = new WebSocket(`${service.getWebSocketBaseUrl()}/ws/test/session-reconnect?token=token-1`);
  let secondSocket: WebSocket | null = null;

  try {
    await waitForSocketOpen(firstSocket);
    const firstClosePromise = waitForSocketClose(firstSocket);

    secondSocket = new WebSocket(`${service.getWebSocketBaseUrl()}/ws/test/session-reconnect?token=token-1`);
    await waitForSocketOpen(secondSocket);

    assert.equal(await firstClosePromise, 1012);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.hasSession(session.sessionId), true);
    assert.equal(secondSocket.readyState, WebSocket.OPEN);
  } finally {
    secondSocket?.close();
    firstSocket.close();
    await service.stop();
  }
});

test('WebSocket rejects client messages above the terminal payload limit', async () => {
  const port = await findAvailablePort();
  const service = new MockTerminalService(port);
  const session = createMockSession('session-oversized-payload');
  service.addSession(session);

  const socket = new WebSocket(`${service.getWebSocketBaseUrl()}/ws/test/session-oversized-payload?token=token-1`);
  socket.on('error', () => undefined);

  try {
    await waitForSocketOpen(socket);
    const closePromise = waitForSocketClose(socket);

    socket.send(Buffer.alloc(TERMINAL_CLIENT_MESSAGE_MAX_BYTES + 1));

    assert.equal(await closePromise, 1009);
  } finally {
    socket.close();
    await service.stop();
  }
});

test('closing a session sends the final exit message before the socket closes', async () => {
  const port = await findAvailablePort();
  const service = new MockTerminalService(port);
  const session = createMockSession('session-close');
  service.addSession(session);

  const socket = new WebSocket(`${service.getWebSocketBaseUrl()}/ws/test/session-close?token=token-1`);

  try {
    await waitForSocketOpen(socket);
    const exitMessagePromise = waitForSocketMessage(socket);
    const closePromise = waitForSocketClose(socket);

    assert.equal(service.closeSession(session.sessionId), true);
    assert.deepEqual(await exitMessagePromise, {
      type: 'exit',
      reason: 'ws.sessionClosedByApiRequest',
    });
    assert.equal(await closePromise, 1000);
  } finally {
    socket.close();
    await service.stop();
  }
});
