import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import type { AuditEventService } from '../audit/service.js';
import type { McpPairingService } from './pairing.js';
import { McpService } from './service.js';

const SERVER = {
  id: 'server-1',
  name: 'Server One',
  host: 'server.example',
  port: 22,
  username: 'operator',
};

/**
 * Creates an MCP service whose required audit writes can be failed on demand.
 *
 * @returns Service, failure control, and captured required audit actions.
 */
const createService = (): {
  service: McpService;
  setRequiredAuditFailure: (failed: boolean) => void;
  requiredActions: string[];
} => {
  let requiredAuditFailure = false;
  const requiredActions: string[] = [];
  const db = {
    sshServer: {
      findUnique: async () => SERVER,
    },
  } as unknown as PrismaClient;
  const auditEventService = {
    logEvent: async () => 'best-effort-event',
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
      httpPort: 54_720,
      eventsHost: '127.0.0.1',
      eventsPort: 54_721,
      appVersion: '0.1.0-test',
    }),
    setRequiredAuditFailure: (failed) => {
      requiredAuditFailure = failed;
    },
    requiredActions,
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
