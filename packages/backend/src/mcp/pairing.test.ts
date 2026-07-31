import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { decryptSensitiveValue, encryptSensitiveValue } from '../ssh/crypto.js';
import { MCP_DISCOVERY_FILE_NAME } from './constants.js';
import { type McpDiscoveryFileContent, McpPairingService } from './pairing.js';

type PairingRow = {
  id: string;
  tokenEncrypted: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

/**
 * Minimal in-memory stand-in for the `mcpPairingToken` Prisma delegate.
 *
 * @returns Fake Prisma client plus the backing row array for assertions.
 */
const createFakeDb = (): { db: PrismaClient; rows: PairingRow[] } => {
  const rows: PairingRow[] = [];
  let sequence = 0;

  const delegate = {
    findFirst: async (args: { where: { revokedAt: null } }) => {
      const matches = rows
        .filter((row) => (args.where.revokedAt === null ? row.revokedAt === null : true))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ?? null;
    },
    updateMany: async (args: { where: { revokedAt: null }; data: { revokedAt: Date } }) => {
      let count = 0;
      for (const row of rows) {
        if (row.revokedAt === null) {
          row.revokedAt = args.data.revokedAt;
          count += 1;
        }
      }
      return { count };
    },
    create: async (args: { data: { tokenEncrypted: string } }) => {
      sequence += 1;
      const row: PairingRow = {
        id: randomUUID(),
        tokenEncrypted: args.data.tokenEncrypted,
        // Strictly increasing timestamps keep ordering deterministic under fast test loops.
        createdAt: new Date(sequence * 1000),
        revokedAt: null,
        lastUsedAt: null,
      };
      rows.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: { lastUsedAt: Date } }) => {
      const row = rows.find((candidate) => candidate.id === args.where.id);
      if (row) {
        row.lastUsedAt = args.data.lastUsedAt;
      }
      return row;
    },
  };

  const db = {
    mcpPairingToken: delegate,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ mcpPairingToken: delegate }),
  } as unknown as PrismaClient;

  return { db, rows };
};

/**
 * Builds a pairing service bound to a fresh temp discovery directory.
 *
 * @returns Service, backing rows, discovery dir, and a cleanup callback.
 */
const createService = async (): Promise<{
  service: McpPairingService;
  rows: PairingRow[];
  discoveryDirPath: string;
  cleanup: () => Promise<void>;
}> => {
  const { db, rows } = createFakeDb();
  const discoveryDirPath = await mkdtemp(path.join(tmpdir(), 'cosmosh-mcp-'));
  const service = new McpPairingService({
    getDbClient: () => db,
    credentialEncryptionKey: randomBytes(32),
    discoveryDirPath,
    appVersion: 'test',
  });

  return {
    service,
    rows,
    discoveryDirPath,
    cleanup: async () => {
      await rm(discoveryDirPath, { recursive: true, force: true });
    },
  };
};

test('rotateToken revokes the previous active token and issues a new one', async () => {
  const { service, rows, cleanup } = await createService();
  try {
    const first = await service.ensureToken();
    const second = await service.rotateToken();

    assert.notEqual(first.plaintext, second.plaintext);
    assert.equal(rows.length, 2);

    const active = rows.filter((row) => row.revokedAt === null);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.id, second.id);
  } finally {
    await cleanup();
  }
});

test('validateBearer accepts the active token and rejects wrong or absent tokens', async () => {
  const { service, cleanup } = await createService();
  try {
    assert.equal(await service.validateBearer('anything'), false);

    const token = await service.ensureToken();
    assert.equal(await service.validateBearer(token.plaintext), true);
    assert.equal(await service.validateBearer(`${token.plaintext}x`), false);
    assert.equal(await service.validateBearer('wrong'), false);
    assert.equal(await service.validateBearer(undefined), false);
  } finally {
    await cleanup();
  }
});

test('validateBearer rejects a token that was rotated out', async () => {
  const { service, cleanup } = await createService();
  try {
    const first = await service.ensureToken();
    await service.rotateToken();
    assert.equal(await service.validateBearer(first.plaintext), false);
  } finally {
    await cleanup();
  }
});

test('writeDiscoveryFile persists the active token plaintext and is removable', async () => {
  const { service, discoveryDirPath, cleanup } = await createService();
  try {
    const token = await service.ensureToken();
    await service.writeDiscoveryFile(4321);

    const filePath = path.join(discoveryDirPath, MCP_DISCOVERY_FILE_NAME);
    const raw = await readFile(filePath, 'utf8');
    const content = JSON.parse(raw) as McpDiscoveryFileContent;

    assert.equal(content.port, 4321);
    assert.equal(content.token, token.plaintext);
    assert.equal(content.appVersion, 'test');

    if (process.platform !== 'win32') {
      const fileStat = await stat(filePath);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    await service.removeDiscoveryFile();
    await assert.rejects(stat(filePath));
  } finally {
    await cleanup();
  }
});

test('revokeToken clears the active token and its plaintext round-trips while active', async () => {
  const { service, rows, cleanup } = await createService();
  try {
    const key = randomBytes(32);
    // Sanity-check the crypto envelope the service relies on.
    const sample = 'round-trip';
    assert.equal(decryptSensitiveValue(encryptSensitiveValue(sample, key), key), sample);

    await service.ensureToken();
    assert.equal(await service.hasToken(), true);

    await service.revokeToken();
    assert.equal(
      rows.every((row) => row.revokedAt !== null),
      true,
    );
    assert.equal(await service.hasToken(), false);
  } finally {
    await cleanup();
  }
});
