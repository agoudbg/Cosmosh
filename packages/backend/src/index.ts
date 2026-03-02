import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import type { PrismaClient } from '@prisma/client';

import { DatabaseInitError, initializeDatabase, shutdownDatabase } from './db/prisma.js';
import { createBackendApp } from './http/create-app.js';
import { enableI18nDevHotReload } from './i18n-bridge.js';
import { LocalTerminalSessionService } from './local-terminal/session-service.js';
import { resolveRuntimeMode } from './runtime.js';
import { SshSessionService } from './ssh/session-service.js';

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

const findAvailablePort = async (): Promise<number> => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to resolve an available local port.'));
        return;
      }

      const { port: availablePort } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(availablePort);
      });
    });
  });
};

const runtimeMode = resolveRuntimeMode(process.env.COSMOSH_RUNTIME_MODE);
const port = resolvePort(process.env.COSMOSH_API_PORT);
const internalToken = process.env.COSMOSH_INTERNAL_TOKEN;
const isSecureLocalMode = runtimeMode === 'electron-main';
// Hash source is normalized below to fixed-size key material.
const credentialEncryptionKeySource = process.env.COSMOSH_SECRET_KEY ?? internalToken;
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const workspaceRoot = path.resolve(currentDirPath, '../../..');
const i18nLocaleRootDir = path.join(workspaceRoot, 'packages', 'i18n', 'locales');
let disableI18nHotReload: (() => void) | null = null;
let sshSessionService: SshSessionService | null = null;
let localTerminalSessionService: LocalTerminalSessionService | null = null;
let httpServer: ReturnType<typeof serve> | null = null;
let shutdownPromise: Promise<void> | null = null;

if (isSecureLocalMode && !internalToken) {
  throw new Error('COSMOSH_INTERNAL_TOKEN is required when COSMOSH_RUNTIME_MODE is electron-main.');
}

if (!credentialEncryptionKeySource) {
  throw new Error('COSMOSH_SECRET_KEY is required when storing SSH credentials.');
}

const credentialEncryptionKey = createHash('sha256').update(credentialEncryptionKeySource).digest();

let dbClient: PrismaClient | null = null;

/**
 * Returns initialized Prisma client or throws when bootstrap did not complete.
 */
const getDbClient = (): PrismaClient => {
  if (!dbClient) {
    throw new Error('Database service is not initialized.');
  }

  return dbClient;
};

/**
 * Registers process signal handlers that gracefully stop session services and DB resources.
 */
const registerShutdownHooks = (): void => {
  const stopHttpServer = async (): Promise<void> => {
    if (!httpServer) {
      return;
    }

    await new Promise<void>((resolve) => {
      httpServer?.close(() => {
        resolve();
      });
    });

    httpServer = null;
  };

  const shutdown = async (origin: string, exitCode?: number): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        console.log(`\n[shutdown] Triggered by ${origin}. Shutting down backend...`);
        disableI18nHotReload?.();
        disableI18nHotReload = null;

        if (sshSessionService) {
          await sshSessionService.stop();
          sshSessionService = null;
        }

        if (localTerminalSessionService) {
          await localTerminalSessionService.stop();
          localTerminalSessionService = null;
        }

        await stopHttpServer();
        await shutdownDatabase();
      })();
    }

    try {
      await shutdownPromise;
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
    } catch (error: unknown) {
      if (error instanceof DatabaseInitError) {
        console.error(`[shutdown][${error.code}] ${error.message}`, {
          origin,
          context: error.context,
          cause: error.cause,
        });
      } else {
        console.error('[shutdown][UNKNOWN] Failed during graceful shutdown.', { origin, error });
      }

      if (typeof exitCode === 'number') {
        process.exit(1);
      }
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.once('SIGBREAK', () => {
    void shutdown('SIGBREAK', 0);
  });

  process.once('SIGHUP', () => {
    void shutdown('SIGHUP', 0);
  });

  process.once('beforeExit', (code) => {
    void shutdown(`beforeExit:${code}`);
  });

  process.once('uncaughtException', (error: Error) => {
    console.error('[runtime][uncaughtException] Backend crashed unexpectedly.', error);
    void shutdown('uncaughtException', 1);
  });

  process.once('unhandledRejection', (reason: unknown) => {
    console.error('[runtime][unhandledRejection] Unhandled promise rejection in backend.', reason);
    void shutdown('unhandledRejection', 1);
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
  const sshWebSocketPort = await findAvailablePort();
  const localTerminalWebSocketPort = await findAvailablePort();

  sshSessionService = new SshSessionService({
    host: '127.0.0.1',
    port: sshWebSocketPort,
    getDbClient,
    credentialEncryptionKey,
  });

  localTerminalSessionService = new LocalTerminalSessionService({
    host: '127.0.0.1',
    port: localTerminalWebSocketPort,
  });

  const app = createBackendApp({
    runtimeMode,
    isSecureLocalMode,
    internalToken,
    credentialEncryptionKey,
    getDbClient,
    sshSessionService,
    localTerminalSessionService,
  });

  console.log(`🚀 Cosmosh Backend starting on http://127.0.0.1:${port} (${runtimeMode})`);
  registerShutdownHooks();

  httpServer = serve({
    fetch: app.fetch,
    port,
  });
};

/**
 * Centralized bootstrap failure path with best-effort cleanup.
 */
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

  if (sshSessionService) {
    await sshSessionService.stop().catch((serviceError: unknown) => {
      console.error('[bootstrap][SSH_SESSION] Failed to stop SSH session service.', serviceError);
    });
    sshSessionService = null;
  }

  if (localTerminalSessionService) {
    await localTerminalSessionService.stop().catch((serviceError: unknown) => {
      console.error('[bootstrap][LOCAL_TERMINAL_SESSION] Failed to stop local terminal session service.', serviceError);
    });
    localTerminalSessionService = null;
  }

  await shutdownDatabase();
  process.exit(1);
});
