import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { AUDIT_REDACTION_PLACEHOLDER } from './constants.js';
import { sanitizeAuditMetadata } from './sanitizer.js';
import { AuditEventService } from './service.js';

/**
 * Builds a Prisma-like client mock with only auditEvent methods used by tests.
 *
 * @param overrides Optional method overrides.
 * @returns Minimal Prisma client mock.
 */
const createMockDbClient = (overrides?: {
  create?: (input: unknown) => Promise<unknown>;
  deleteMany?: (input: unknown) => Promise<unknown>;
  count?: (input: unknown) => Promise<number>;
  findMany?: (input: unknown) => Promise<unknown[]>;
  findUnique?: (input: unknown) => Promise<unknown>;
}): PrismaClient => {
  return {
    auditEvent: {
      create: overrides?.create ?? (async () => ({ eventId: 'evt_test' })),
      deleteMany: overrides?.deleteMany ?? (async () => ({ count: 0 })),
      count: overrides?.count ?? (async () => 0),
      findMany: overrides?.findMany ?? (async () => []),
      findUnique: overrides?.findUnique ?? (async () => null),
    },
  } as unknown as PrismaClient;
};

test('sanitizeAuditMetadata redacts sensitive fields recursively', () => {
  const sanitized = sanitizeAuditMetadata({
    password: 'super-secret',
    nested: {
      privateKey: '-----BEGIN PRIVATE KEY-----',
      authToken: 'token-value',
    },
    allowed: 'visible',
  });

  assert.equal(typeof sanitized.metadataJson, 'string');
  assert.equal(sanitized.metadataValue.password, AUDIT_REDACTION_PLACEHOLDER);
  assert.deepEqual(sanitized.metadataValue.nested, {
    privateKey: AUDIT_REDACTION_PLACEHOLDER,
    authToken: AUDIT_REDACTION_PLACEHOLDER,
  });
  assert.equal(sanitized.metadataValue.allowed, 'visible');
});

test('AuditEventService.logEvent swallows write errors and returns null', async () => {
  const service = new AuditEventService({
    getDbClient: () =>
      createMockDbClient({
        create: async () => {
          throw new Error('write failed');
        },
      }),
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    const eventId = await service.logEvent({
      category: 'settings',
      action: 'update',
      outcome: 'success',
      severity: 'info',
      metadata: {
        changedKeys: ['language'],
      },
    });

    assert.equal(eventId, null);
  } finally {
    console.error = originalConsoleError;
  }
});

test('AuditEventService.logRequiredEvent propagates write errors', async () => {
  const service = new AuditEventService({
    getDbClient: () =>
      createMockDbClient({
        create: async () => {
          throw new Error('required write failed');
        },
      }),
  });

  await assert.rejects(
    service.logRequiredEvent({
      category: 'mcp',
      action: 'authorization-requested',
      outcome: 'success',
      severity: 'warning',
      metadata: {},
    }),
    /required write failed/,
  );
});

test('AuditEventService.listEvents returns normalized pagination payload', async () => {
  let receivedFindManyArgs: unknown;

  const service = new AuditEventService({
    getDbClient: () =>
      createMockDbClient({
        count: async () => 3,
        findMany: async (args) => {
          receivedFindManyArgs = args;
          return [
            {
              eventId: 'evt_1',
              occurredAt: new Date('2026-03-29T10:00:00.000Z'),
              category: 'ssh-session',
              action: 'connect',
              outcome: 'success',
              severity: 'info',
              scopeAccountId: '',
              scopeDeviceId: 'local-device',
              entityType: 'ssh-server',
              entityId: 'srv_1',
              sessionId: 'sess_1',
              requestId: 'req_1',
              correlationId: null,
              relatedRecordId: 'login_1',
              metadataJson: '{}',
              retentionUntilAt: new Date('2026-09-25T10:00:00.000Z'),
              createdAt: new Date('2026-03-29T10:00:00.000Z'),
            },
          ];
        },
      }),
  });

  const result = await service.listEvents({
    page: 1,
    pageSize: 50,
    category: 'ssh-session',
  });

  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.pageSize, 50);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.eventId, 'evt_1');

  assert.equal(typeof receivedFindManyArgs, 'object');
});
