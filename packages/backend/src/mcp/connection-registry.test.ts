import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';
import type { Client } from 'ssh2';

import type { AuditEventService } from '../audit/service.js';
import type { OpenSshClientResult } from '../ssh/connect.js';
import { McpConnectionRegistry } from './connection-registry.js';
import { MCP_MAX_CONNECTIONS } from './constants.js';

const SERVER = {
  id: 'server-1',
  name: 'Server One',
  host: 'server.example',
  port: 22,
  username: 'operator',
  strictHostKey: true,
  mcpCommandPolicy: 'ask',
  keychain: null,
  updatedAt: new Date('2026-07-27T00:00:00.000Z'),
};

/**
 * Minimal ssh2 client double used to observe registry teardown.
 */
class FakeSshClient extends EventEmitter {
  public endCallCount = 0;

  /**
   * Records one client shutdown.
   *
   * @returns This client for ssh2 API compatibility.
   */
  public end(): this {
    this.endCallCount += 1;
    return this;
  }
}

/**
 * Creates an isolated registry with deterministic database and SSH dependencies.
 *
 * @returns Registry plus the clients created by successful opens.
 */
const createRegistry = (options?: {
  beforeServerRead?: () => Promise<void>;
}): {
  registry: McpConnectionRegistry;
  clients: FakeSshClient[];
  updateServer: (updates: Partial<typeof SERVER>) => void;
} => {
  let currentServer = { ...SERVER };
  const db = {
    sshServer: {
      findUnique: async () => {
        await options?.beforeServerRead?.();
        return currentServer;
      },
    },
    sshKnownHost: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
  const auditEventService = {
    logEvent: async () => 'audit-event',
  } as unknown as AuditEventService;
  const clients: FakeSshClient[] = [];

  return {
    registry: new McpConnectionRegistry({
      getDbClient: () => db,
      auditEventService,
      credentialEncryptionKey: Buffer.alloc(32),
      emitEvent: () => {},
      openClient: async (): Promise<OpenSshClientResult> => {
        const client = new FakeSshClient();
        clients.push(client);
        return {
          type: 'ready',
          client: client as unknown as Client,
          completionSecretValue: null,
          lifecycleMonitor: {
            readError: () => null,
            isClosed: () => false,
            release: () => {},
            releaseAfterClose: () => {},
          },
          proxyMetadata: {},
        } as OpenSshClientResult;
      },
    }),
    clients,
    updateServer: (updates) => {
      currentServer = { ...currentServer, ...updates };
    },
  };
};

/**
 * Opens one registry connection for the requested protocol session.
 *
 * @param registry Registry under test.
 * @param ownerSessionId Owning MCP session.
 * @returns New connection id.
 */
const openOwnedConnection = async (registry: McpConnectionRegistry, ownerSessionId: string): Promise<string> => {
  const result = await registry.open({
    serverId: SERVER.id,
    approvedTarget: {
      serverId: SERVER.id,
      name: SERVER.name,
      host: SERVER.host,
      port: SERVER.port,
      username: SERVER.username,
    },
    ownerSessionId,
    client: { name: 'test-client', version: '1.0.0' },
    requestId: `request-${ownerSessionId}`,
  });
  assert.equal(result.type, 'success');
  if (result.type !== 'success') {
    throw new Error('Expected registry open to succeed.');
  }
  return result.summary.connectionId;
};

test('an approved connection is rejected when the persisted destination changes before open', async () => {
  const { registry, clients, updateServer } = createRegistry();
  updateServer({ host: 'changed.example' });

  const result = await registry.open({
    serverId: SERVER.id,
    approvedTarget: {
      serverId: SERVER.id,
      name: SERVER.name,
      host: SERVER.host,
      port: SERVER.port,
      username: SERVER.username,
    },
    ownerSessionId: 'session-a',
    client: { name: 'test-client', version: '1.0.0' },
    requestId: 'request-target-change',
  });

  assert.equal(result.type, 'target-changed');
  assert.equal(clients.length, 0);
  assert.equal(registry.count(), 0);
});

test('concurrent opens atomically reserve the connection cap before SSH bootstrap', async (context) => {
  let releaseServerReads: (() => void) | undefined;
  const serverReadGate = new Promise<void>((resolve) => {
    releaseServerReads = resolve;
  });
  const { registry, clients } = createRegistry({
    beforeServerRead: async () => await serverReadGate,
  });
  context.after(async () => {
    await registry.closeAll('shutdown');
  });

  const attempts = Array.from({ length: MCP_MAX_CONNECTIONS + 1 }, (_, index) =>
    registry.open({
      serverId: SERVER.id,
      approvedTarget: {
        serverId: SERVER.id,
        name: SERVER.name,
        host: SERVER.host,
        port: SERVER.port,
        username: SERVER.username,
      },
      ownerSessionId: `session-${index}`,
      client: { name: 'test-client', version: '1.0.0' },
      requestId: `request-cap-${index}`,
    }),
  );

  releaseServerReads?.();
  const results = await Promise.all(attempts);

  assert.equal(results.filter((result) => result.type === 'success').length, MCP_MAX_CONNECTIONS);
  assert.equal(results.filter((result) => result.type === 'limit-reached').length, 1);
  assert.equal(clients.length, MCP_MAX_CONNECTIONS);
  assert.equal(registry.count(), MCP_MAX_CONNECTIONS);
});

test('connection access is isolated to the owning MCP session', async (context) => {
  const { registry } = createRegistry();
  context.after(async () => {
    await registry.closeAll('shutdown');
  });
  const firstId = await openOwnedConnection(registry, 'session-a');
  await openOwnedConnection(registry, 'session-b');

  assert.deepEqual(
    registry.listOwned('session-a').map((connection) => connection.connectionId),
    [firstId],
  );
  assert.equal(registry.getOwned(firstId, 'session-b'), undefined);
  assert.equal(await registry.closeOwned(firstId, 'session-b', 'tool'), false);
  assert.equal(await registry.closeOwned(firstId, 'session-a', 'tool'), true);
});

test('disconnect cleanup closes only connections owned by that session', async (context) => {
  const { registry, clients } = createRegistry();
  context.after(async () => {
    await registry.closeAll('shutdown');
  });
  await openOwnedConnection(registry, 'session-a');
  const secondId = await openOwnedConnection(registry, 'session-b');

  await registry.closeOwnedBySession('session-a');

  assert.equal(clients[0]?.endCallCount, 1);
  assert.equal(clients[1]?.endCallCount, 0);
  assert.deepEqual(
    registry.listOwned('session-b').map((connection) => connection.connectionId),
    [secondId],
  );
});
