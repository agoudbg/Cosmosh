import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';
import type { Client, ClientChannel } from 'ssh2';

import type { AuditEventService } from '../audit/service.js';
import type { OpenSshClientResult } from '../ssh/connect.js';
import type { SshSessionService } from '../ssh/session-service.js';
import type { McpPairingService } from './pairing.js';
import { McpService } from './service.js';

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
 * Builds the terminal runtime surface required by MCP constructor wiring.
 *
 * @returns Inert SSH session service for background-only tests.
 */
const createSshSessionServiceStub = (): SshSessionService => {
  return {
    onAgentTerminalClosed: () => () => undefined,
    onAgentTerminalStatusChanged: () => () => undefined,
    closeSession: () => false,
    detachAgentTerminal: () => false,
    getAgentTerminalSession: () => undefined,
    stopAgentTerminalCommand: () => false,
  } as unknown as SshSessionService;
};

/**
 * Minimal ready ssh2 client double for policy-only service tests.
 */
class FakeSshClient extends EventEmitter {
  /**
   * Simulates an ssh2 infrastructure failure before a command channel opens.
   *
   * @param _command Ignored command.
   * @param callback ssh2 exec callback.
   * @returns This client.
   */
  public exec(_command: string, callback: (error?: Error | null, channel?: ClientChannel) => void): this {
    callback(new Error('exec transport failed'));
    return this;
  }

  /**
   * Satisfies the ssh2 teardown contract.
   *
   * @returns This client.
   */
  public end(): this {
    return this;
  }
}

/**
 * Creates an MCP service whose required audit writes can be failed on demand.
 *
 * @returns Service, failure control, and captured required audit actions.
 */
const createService = (): {
  service: McpService;
  setRequiredAuditFailure: (failed: boolean) => void;
  updateServer: (updates: Partial<typeof SERVER>) => void;
  requiredActions: string[];
  bestEffortEvents: { action: string; outcome: string; metadata?: Record<string, unknown> }[];
} => {
  let requiredAuditFailure = false;
  let currentServer = { ...SERVER };
  const requiredActions: string[] = [];
  const bestEffortEvents: { action: string; outcome: string; metadata?: Record<string, unknown> }[] = [];
  const db = {
    sshServer: {
      findUnique: async () => currentServer,
    },
    sshKnownHost: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  } as unknown as PrismaClient;
  const auditEventService = {
    logEvent: async (input: { action: string; outcome: string; metadata?: Record<string, unknown> }) => {
      bestEffortEvents.push({ action: input.action, outcome: input.outcome, metadata: input.metadata });
      return 'best-effort-event';
    },
    logRequiredEvent: async (input: { action: string }) => {
      requiredActions.push(input.action);
      if (requiredAuditFailure) {
        throw new Error('audit storage unavailable');
      }
      return 'required-event';
    },
  } as unknown as AuditEventService;

  return {
    service: new McpService({
      getDbClient: () => db,
      auditEventService,
      credentialEncryptionKey: Buffer.alloc(32),
      pairingService: {} as McpPairingService,
      sshSessionService: createSshSessionServiceStub(),
      httpPort: 54_720,
      eventsHost: '127.0.0.1',
      eventsPort: 54_721,
      appVersion: '0.1.0-test',
      openClient: async (): Promise<OpenSshClientResult> => {
        return {
          type: 'ready',
          client: new FakeSshClient() as unknown as Client,
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
    setRequiredAuditFailure: (failed) => {
      requiredAuditFailure = failed;
    },
    updateServer: (updates) => {
      currentServer = { ...currentServer, ...updates };
    },
    requiredActions,
    bestEffortEvents,
  };
};

/**
 * Starts one connection-open operation with deterministic caller identity.
 *
 * @param service MCP service under test.
 * @param signal Caller cancellation signal.
 * @returns Pending tool outcome.
 */
const openConnection = (service: McpService, signal: AbortSignal) => {
  return service.openConnection({
    serverId: SERVER.id,
    reason: 'test required auditing',
    mcpSessionId: 'session-1',
    client: { name: 'test-client', version: '1.0.0' },
    mode: 'background',
    signal,
  });
};

/**
 * Starts one default visible connection-open operation.
 *
 * @param service MCP service under test.
 * @param signal Caller cancellation signal.
 * @returns Pending tool outcome.
 */
const openVisibleConnection = (service: McpService, signal: AbortSignal) => {
  return service.openConnection({
    serverId: SERVER.id,
    reason: 'test visible terminal auditing',
    mcpSessionId: 'session-1',
    client: { name: 'test-client', version: '1.0.0' },
    mode: 'terminal',
    signal,
  });
};

test('connection approval is not exposed when its required request audit fails', async () => {
  const { service, setRequiredAuditFailure, requiredActions } = createService();
  setRequiredAuditFailure(true);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const outcome = await openConnection(service, new AbortController().signal);

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, 'audit-unavailable');
    }
    assert.deepEqual(requiredActions, ['authorization-requested']);
    assert.equal(service.listApprovals().length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test('an approval remains pending when its required decision audit fails', async () => {
  const { service, setRequiredAuditFailure, requiredActions } = createService();
  const controller = new AbortController();
  const outcomePromise = openConnection(service, controller.signal);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const approval = service.listApprovals()[0];
  assert.ok(approval);
  setRequiredAuditFailure(true);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    assert.equal(await service.resolveApproval(approval.approvalId, 'approved'), 'audit-unavailable');
    assert.equal(service.listApprovals().length, 1);
    assert.deepEqual(requiredActions, ['authorization-requested', 'authorization-resolved']);
  } finally {
    console.error = originalConsoleError;
    controller.abort();
  }

  const outcome = await outcomePromise;
  assert.equal(outcome.ok, false);
});

test('a cancelled visible launch records a connection-open failure without creating a connection', async () => {
  const { service, bestEffortEvents } = createService();
  const controller = new AbortController();
  const outcomePromise = openVisibleConnection(service, controller.signal);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const approval = service.listApprovals()[0];
  assert.ok(approval);
  assert.equal(await service.resolveApproval(approval.approvalId, 'approved'), 'resolved');

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(service.listTerminalLaunches().length, 1);
  controller.abort();

  const outcome = await outcomePromise;
  assert.equal(outcome.ok, false);
  assert.equal(service.listConnectionSummaries().length, 0);
  const failureAudit = bestEffortEvents.find(
    (event) => event.action === 'connection-open' && event.outcome === 'failure',
  );
  assert.equal(failureAudit?.metadata?.mode, 'terminal');
  assert.equal(failureAudit?.metadata?.reason, 'terminal-launch-cancelled');
  assert.equal('terminalSessionId' in (failureAudit?.metadata ?? {}), false);
});

test('runCommand re-reads the server policy and revokes connection pre-approval after an edit', async () => {
  const { service, updateServer } = createService();
  const controller = new AbortController();
  const outcomePromise = openConnection(service, controller.signal);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const approval = service.listApprovals()[0];
  assert.ok(approval);
  assert.equal(await service.resolveApproval(approval.approvalId, 'approvedForConnection'), 'resolved');

  const openOutcome = await outcomePromise;
  assert.equal(openOutcome.ok, true);
  if (!openOutcome.ok) {
    throw new Error('Expected connection open to succeed.');
  }
  assert.equal(
    service.listConnections({ mcpSessionId: 'session-1', client: approval.client })[0]?.commandsPreApproved,
    true,
  );

  updateServer({
    mcpCommandPolicy: 'off',
    updatedAt: new Date('2026-07-27T00:01:00.000Z'),
  });
  const commandOutcome = await service.runCommand({
    connectionId: openOutcome.connection.connectionId,
    command: 'true',
    mcpSessionId: 'session-1',
    client: approval.client,
    signal: controller.signal,
  });

  assert.equal(commandOutcome.ok, false);
  if (!commandOutcome.ok) {
    assert.equal(commandOutcome.reason, 'policy-off');
  }
  assert.equal(
    service.listConnections({ mcpSessionId: 'session-1', client: approval.client })[0]?.commandsPreApproved,
    false,
  );
  assert.equal(
    (
      await service.closeConnection({
        connectionId: openOutcome.connection.connectionId,
        mcpSessionId: 'session-1',
        client: approval.client,
      })
    ).ok,
    true,
  );
});

test('runCommand returns an SSH exec infrastructure error as a failed tool outcome', async () => {
  const { service, updateServer, bestEffortEvents } = createService();
  updateServer({
    mcpCommandPolicy: 'allowWithinConnection',
    updatedAt: new Date('2026-07-27T00:02:00.000Z'),
  });
  const controller = new AbortController();
  const outcomePromise = openConnection(service, controller.signal);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const approval = service.listApprovals()[0];
  assert.ok(approval);
  assert.equal(await service.resolveApproval(approval.approvalId, 'approvedForConnection'), 'resolved');

  const openOutcome = await outcomePromise;
  assert.equal(openOutcome.ok, true);
  if (!openOutcome.ok) {
    throw new Error('Expected connection open to succeed.');
  }

  const commandOutcome = await service.runCommand({
    connectionId: openOutcome.connection.connectionId,
    command: 'true',
    mcpSessionId: 'session-1',
    client: approval.client,
    signal: controller.signal,
  });

  assert.deepEqual(commandOutcome, {
    ok: false,
    reason: 'failed',
    message: 'exec transport failed',
  });
  assert.equal(
    bestEffortEvents.some((event) => event.action === 'command-execute' && event.outcome === 'failure'),
    true,
  );
  await service.closeConnection({
    connectionId: openOutcome.connection.connectionId,
    mcpSessionId: 'session-1',
    client: approval.client,
  });
});
