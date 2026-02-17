import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { enableI18nDevHotReload } from '@cosmosh/i18n';
import type { PrismaClient } from '@prisma/client';

import { DatabaseInitError, initializeDatabase, shutdownDatabase } from './db/prisma.js';
import { createBackendApp } from './http/create-app.js';
import { resolveRuntimeMode } from './runtime.js';

/**
 * Parse backend port from environment and validate safe numeric bounds.
 */
const resolvePort = (input: string | undefined): number => {
  if (!input) {
    return 3000;
  }

  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid COSMOSH_API_PORT: "${input}". Expected integer in range 1-65535.`);
  }

  return parsed;
};

const runtimeMode = resolveRuntimeMode(process.env.COSMOSH_RUNTIME_MODE);
const port = resolvePort(process.env.COSMOSH_API_PORT);
const internalToken = process.env.COSMOSH_INTERNAL_TOKEN;
const isSecureLocalMode = runtimeMode === 'electron-main';
const credentialEncryptionKeySource = process.env.COSMOSH_SECRET_KEY ?? internalToken;
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const workspaceRoot = path.resolve(currentDirPath, '../../..');
const i18nLocaleRootDir = path.join(workspaceRoot, 'packages', 'i18n', 'locales');
let disableI18nHotReload: (() => void) | null = null;

if (isSecureLocalMode && !internalToken) {
  throw new Error('COSMOSH_INTERNAL_TOKEN is required when COSMOSH_RUNTIME_MODE is electron-main.');
}

if (!credentialEncryptionKeySource) {
  throw new Error('COSMOSH_SECRET_KEY is required when storing SSH credentials.');
}

const credentialEncryptionKey = createHash('sha256').update(credentialEncryptionKeySource).digest();

let dbClient: PrismaClient | null = null;

const getDbClient = (): PrismaClient => {
  if (!dbClient) {
    throw new Error('Database service is not initialized.');
  }

  return dbClient;
};

const registerShutdownHooks = (): void => {
  // Handle process termination so DB handles are released cleanly.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`\n[shutdown] Received ${signal}. Shutting down backend...`);
    disableI18nHotReload?.();
    disableI18nHotReload = null;

    try {
      await shutdownDatabase();
      process.exit(0);
    } catch (error: unknown) {
      if (error instanceof DatabaseInitError) {
        console.error(`[shutdown][${error.code}] ${error.message}`, {
          signal,
          context: error.context,
          cause: error.cause,
        });
      } else {
        console.error('[shutdown][UNKNOWN] Failed to disconnect database during shutdown.', { signal, error });
      }

      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
};

/**
 * Backend bootstrap order:
 * 1) Initialize persistence
 * 2) Register shutdown hooks
 * 3) Start HTTP listener
 */
const bootstrap = async (): Promise<void> => {
  disableI18nHotReload = await enableI18nDevHotReload({ localeRootDir: i18nLocaleRootDir });

  // Database initialization is intentionally done before starting the HTTP server,
  // so runtime fails fast when persistence is not ready.
  dbClient = await initializeDatabase({ runtimeMode });

  const app = createBackendApp({
    runtimeMode,
    isSecureLocalMode,
    internalToken,
    credentialEncryptionKey,
    getDbClient,
  });

  console.log(`🚀 Cosmosh Backend starting on http://127.0.0.1:${port} (${runtimeMode})`);
  registerShutdownHooks();

  serve({
    fetch: app.fetch,
    port,
  });
};

void bootstrap().catch(async (error: unknown) => {
  disableI18nHotReload?.();
  disableI18nHotReload = null;

  if (error instanceof DatabaseInitError) {
    console.error(`[bootstrap][${error.code}] ${error.message}`, {
      context: error.context,
      cause: error.cause,
    });
  } else {
    console.error('[bootstrap][UNKNOWN] Failed to bootstrap backend service.', error);
  }

  await shutdownDatabase();
  process.exit(1);
});
