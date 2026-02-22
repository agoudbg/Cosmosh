import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient as PrismaClientType } from '@prisma/client';
import prismaClientPackage from '@prisma/client';

const { PrismaClient } = prismaClientPackage;
const require = createRequire(import.meta.url);

type BetterSqlite3LikeDatabase = {
  pragma: (statement: string) => unknown;
  prepare: (statement: string) => { get: () => unknown };
  close: () => void;
};

type BetterSqlite3LikeConstructor = new (filePath: string) => BetterSqlite3LikeDatabase;

export type RuntimeMode = 'standalone' | 'electron-main';

type InitializeDatabaseOptions = {
  runtimeMode: RuntimeMode;
};

type DatabaseErrorCode =
  | 'DB_PATH_RESOLVE_FAILED'
  | 'DB_KEY_RESOLVE_FAILED'
  | 'DB_DIRECTORY_PREPARE_FAILED'
  | 'DB_FILE_PREPARE_FAILED'
  | 'DB_ACL_APPLY_FAILED'
  | 'DB_SQLCIPHER_BOOTSTRAP_FAILED'
  | 'DB_CONNECT_FAILED'
  | 'DB_PRAGMA_FAILED'
  | 'DB_SCHEMA_BOOTSTRAP_FAILED'
  | 'DB_DISCONNECT_FAILED';

type DatabaseErrorContext = Record<string, string>;

export class DatabaseInitError extends Error {
  public readonly code: DatabaseErrorCode;
  public readonly context: DatabaseErrorContext;

  public constructor(code: DatabaseErrorCode, message: string, context: DatabaseErrorContext, cause?: unknown) {
    super(message, { cause });
    this.name = 'DatabaseInitError';
    this.code = code;
    this.context = context;
  }
}

const DB_FILE_NAME = 'cosmosh.db';
const DEV_DB_KEY = 'cosmosh_dev_key';
const isWindows = process.platform === 'win32';
const execFileAsync = promisify(execFile);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const backendRootDir = path.resolve(currentDirPath, '../..');
const workspaceRootDir = path.resolve(backendRootDir, '../..');

let prismaClient: PrismaClientType | null = null;
let initializingClientPromise: Promise<PrismaClientType> | null = null;
let cachedSqlCipherDriver: BetterSqlite3LikeConstructor | null | undefined;

const resolveSqlCipherDriver = (): BetterSqlite3LikeConstructor | null => {
  if (cachedSqlCipherDriver !== undefined) {
    return cachedSqlCipherDriver;
  }

  try {
    const loadedModule = require('better-sqlite3-multiple-ciphers') as BetterSqlite3LikeConstructor;
    cachedSqlCipherDriver = loadedModule;
    return loadedModule;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[db:init] SQLCipher native driver unavailable. Falling back to Prisma SQLite mode. ${message}`);
    cachedSqlCipherDriver = null;
    return null;
  }
};

const isDevelopmentRuntime = (): boolean => {
  if (process.env.COSMOSH_APP_ENV === 'development') {
    return true;
  }

  if (process.env.COSMOSH_APP_ENV === 'production') {
    return false;
  }

  return process.env.NODE_ENV !== 'production';
};

const withDbError = (
  code: DatabaseErrorCode,
  message: string,
  context: DatabaseErrorContext,
  cause: unknown,
): never => {
  throw new DatabaseInitError(code, message, context, cause);
};

const resolveWindowsIdentity = async (): Promise<string> => {
  const userName = process.env.USERNAME;
  if (userName) {
    const userDomain = process.env.USERDOMAIN;
    return userDomain ? `${userDomain}\\${userName}` : userName;
  }

  const { stdout } = await execFileAsync('whoami', []);
  const identity = stdout.trim();
  if (!identity) {
    throw new Error('Failed to resolve current Windows identity via whoami.');
  }

  return identity;
};

const applyWindowsAcl = async (targetPath: string, isDirectory: boolean): Promise<void> => {
  const identity = await resolveWindowsIdentity();
  const userPermission = isDirectory ? `${identity}:(OI)(CI)F` : `${identity}:F`;
  const systemPermission = isDirectory ? 'SYSTEM:(OI)(CI)F' : 'SYSTEM:F';

  await execFileAsync('icacls', [targetPath, '/inheritance:r']);
  await execFileAsync('icacls', [targetPath, '/grant:r', userPermission, systemPermission]);
};

const ensureSecureDirectory = async (directoryPath: string): Promise<void> => {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });

  if (!isWindows) {
    await chmod(directoryPath, 0o700);
    return;
  }

  try {
    await applyWindowsAcl(directoryPath, true);
  } catch (error: unknown) {
    withDbError('DB_ACL_APPLY_FAILED', 'Failed to apply Windows ACL to SQLite directory.', { directoryPath }, error);
  }
};

const ensureSecureFile = async (filePath: string): Promise<void> => {
  try {
    const fileHandle = await open(filePath, 'wx', 0o600);
    await fileHandle.close();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw error;
    }
  }

  if (!isWindows) {
    await chmod(filePath, 0o600);
  } else {
    try {
      await applyWindowsAcl(filePath, false);
    } catch (error: unknown) {
      withDbError('DB_ACL_APPLY_FAILED', 'Failed to apply Windows ACL to SQLite file.', { filePath }, error);
    }
  }

  await access(filePath, fsConstants.R_OK | fsConstants.W_OK);
};

const backupUnreadableDatabaseFiles = async (databaseFilePath: string): Promise<void> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const candidates = [databaseFilePath, `${databaseFilePath}-wal`, `${databaseFilePath}-shm`];

  for (const sourcePath of candidates) {
    try {
      await access(sourcePath, fsConstants.F_OK);
    } catch {
      continue;
    }

    const targetPath = `${sourcePath}.unreadable-${timestamp}.bak`;
    await rename(sourcePath, targetPath);
  }
};

export const getDatabasePath = (): string => {
  if (isDevelopmentRuntime()) {
    return path.join(workspaceRootDir, '.dev_data', DB_FILE_NAME);
  }

  const userDataPath = process.env.COSMOSH_USER_DATA_PATH;
  if (!userDataPath) {
    throw new Error('COSMOSH_USER_DATA_PATH is required in production runtime to resolve encrypted database path.');
  }

  return path.join(userDataPath, DB_FILE_NAME);
};

export const getDatabaseEncryptionKey = (): string => {
  if (isDevelopmentRuntime()) {
    return DEV_DB_KEY;
  }

  const envKey = process.env.COSMOSH_DB_ENCRYPTION_KEY;
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  throw new Error(
    '[db:key] Missing COSMOSH_DB_ENCRYPTION_KEY in production runtime. If Electron safeStorage is unavailable, configure master_password_hash and bootstrap key derivation in main process, or temporarily set COSMOSH_DB_MASTER_PASSWORD according to fallback policy.',
  );
};

const toPrismaSqliteUrl = (filePath: string): string => {
  const normalizedPath = filePath.split(path.sep).join('/');
  return `file:${normalizedPath}`;
};

const escapeSqliteLiteral = (input: string): string => {
  return input.replace(/'/g, "''");
};

const isNativeDriverUnavailableError = (error: unknown): boolean => {
  const code = (error as { code?: string })?.code;
  if (code === 'ERR_DLOPEN_FAILED') {
    return true;
  }

  const topLevelMessage =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === 'string'
        ? ((error as { message: string }).message ?? '')
        : String(error);

  const nestedCause = (error as { cause?: unknown })?.cause;
  const causeMessage =
    nestedCause instanceof Error
      ? nestedCause.message
      : typeof (nestedCause as { message?: unknown })?.message === 'string'
        ? ((nestedCause as { message: string }).message ?? '')
        : nestedCause != null
          ? String(nestedCause)
          : '';

  const message = `${topLevelMessage}\n${causeMessage}`;

  if (message.includes('NODE_MODULE_VERSION')) {
    return true;
  }

  if (message.includes('Could not locate the bindings file')) {
    return isDevelopmentRuntime();
  }

  return false;
};

const isPrismaSqliteFileUnreadableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('file is not a database')) {
    return true;
  }

  const code = (error as { code?: string })?.code;
  const metaCode = (error as { meta?: { code?: string } })?.meta?.code;
  return code === 'P2010' && metaCode === '26';
};

const ensureDevelopmentPlaintextDatabase = (databaseFilePath: string, databaseKey: string): void => {
  const SqlCipherDriver = resolveSqlCipherDriver();
  if (!SqlCipherDriver) {
    return;
  }

  let encryptedDb: BetterSqlite3LikeDatabase | null = null;

  try {
    encryptedDb = new SqlCipherDriver(databaseFilePath);
    encryptedDb.pragma('wal_checkpoint(FULL)');
    encryptedDb.pragma('journal_mode = DELETE');
    encryptedDb.pragma("cipher = 'sqlcipher'");
    encryptedDb.pragma(`key = '${escapeSqliteLiteral(databaseKey)}'`);
    encryptedDb.prepare('SELECT count(*) AS tableCount FROM sqlite_master').get();
    encryptedDb.pragma("rekey = ''");
    console.warn(
      '[db:init] Development mode compatibility: decrypted SQLCipher database to plaintext for Prisma runtime.',
    );
  } catch (error: unknown) {
    if (isNativeDriverUnavailableError(error)) {
      console.warn(
        '[db:init] SQLCipher native addon is unavailable in development runtime. Compatibility conversion is skipped.',
      );
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('file is not a database')) {
      return;
    }

    throw error;
  } finally {
    encryptedDb?.close();
  }
};

const bootstrapSqlCipher = (databaseFilePath: string, databaseKey: string): boolean => {
  const SqlCipherDriver = resolveSqlCipherDriver();
  if (!SqlCipherDriver) {
    return false;
  }

  let sqlite: BetterSqlite3LikeDatabase | null = null;

  try {
    sqlite = new SqlCipherDriver(databaseFilePath);

    sqlite.pragma("cipher = 'sqlcipher'");
    sqlite.pragma(`key = '${escapeSqliteLiteral(databaseKey)}'`);
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.prepare('SELECT count(*) AS tableCount FROM sqlite_master').get();
    console.log('[db:init] SQLCipher bootstrap completed successfully.');
    return true;
  } catch (error: unknown) {
    if (isNativeDriverUnavailableError(error)) {
      if (isDevelopmentRuntime()) {
        console.warn(
          '[db:init] SQLCipher native addon is unavailable in development runtime. Falling back to Prisma SQLite mode.',
        );
        return false;
      }

      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('file is not a database')) {
      console.warn(
        '[db:init] Existing plaintext database detected. Skipping SQLCipher conversion for Prisma compatibility in current runtime.',
      );
      return false;
    }

    throw error;
  } finally {
    sqlite?.close();
  }
};

const applyPragmas = async (
  client: PrismaClientType,
  runtimeMode: RuntimeMode,
  databaseKey: string,
  sqlCipherEnabled: boolean,
): Promise<void> => {
  if (!isDevelopmentRuntime() && sqlCipherEnabled) {
    await client.$queryRawUnsafe(`PRAGMA key = '${escapeSqliteLiteral(databaseKey)}';`);
  }
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');

  if (runtimeMode === 'electron-main' && !isDevelopmentRuntime() && sqlCipherEnabled) {
    await client.$queryRawUnsafe('PRAGMA locking_mode = EXCLUSIVE;');
  }
};

const ensureSchema = async (client: PrismaClientType): Promise<void> => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS "SshFolder" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "note" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "SshFolder_name_key" ON "SshFolder"("name");',
    `CREATE TABLE IF NOT EXISTS "SshTag" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "SshTag_name_key" ON "SshTag"("name");',
    `CREATE TABLE IF NOT EXISTS "SshServer" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "host" TEXT NOT NULL,
      "port" INTEGER NOT NULL DEFAULT 22,
      "username" TEXT NOT NULL,
      "authType" TEXT NOT NULL,
      "passwordEncrypted" TEXT,
      "privateKeyEncrypted" TEXT,
      "privateKeyPassphraseEncrypted" TEXT,
      "note" TEXT,
      "folderId" TEXT,
      "systemHostname" TEXT,
      "systemOs" TEXT,
      "systemArch" TEXT,
      "systemKernel" TEXT,
      "lastSystemSyncAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("folderId") REFERENCES "SshFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE
    );`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "SshServer_host_port_username_key" ON "SshServer"("host", "port", "username");',
    'CREATE INDEX IF NOT EXISTS "SshServer_folderId_idx" ON "SshServer"("folderId");',
    `CREATE TABLE IF NOT EXISTS "SshKnownHost" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "host" TEXT NOT NULL,
      "port" INTEGER NOT NULL DEFAULT 22,
      "keyType" TEXT NOT NULL,
      "fingerprint" TEXT NOT NULL,
      "trusted" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    'CREATE INDEX IF NOT EXISTS "SshKnownHost_host_port_idx" ON "SshKnownHost"("host", "port");',
    `CREATE TABLE IF NOT EXISTS "AppSettings" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "scopeAccountId" TEXT NOT NULL DEFAULT '',
      "scopeDeviceId" TEXT NOT NULL,
      "payloadJson" TEXT NOT NULL,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "AppSettings_scopeAccountId_scopeDeviceId_key" ON "AppSettings"("scopeAccountId", "scopeDeviceId");',
    'CREATE INDEX IF NOT EXISTS "AppSettings_scopeDeviceId_idx" ON "AppSettings"("scopeDeviceId");',
    `CREATE TABLE IF NOT EXISTS "SshServerTag" (
      "serverId" TEXT NOT NULL,
      "tagId" TEXT NOT NULL,
      PRIMARY KEY ("serverId", "tagId"),
      FOREIGN KEY ("serverId") REFERENCES "SshServer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY ("tagId") REFERENCES "SshTag"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    'CREATE INDEX IF NOT EXISTS "SshServerTag_tagId_idx" ON "SshServerTag"("tagId");',
    `CREATE TABLE IF NOT EXISTS "SshLoginAudit" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "result" TEXT NOT NULL,
      "failureReason" TEXT,
      "clientIp" TEXT,
      "sessionId" TEXT,
      "sessionStartedAt" DATETIME,
      "sessionEndedAt" DATETIME,
      "commandCount" INTEGER NOT NULL DEFAULT 0,
      "metadataJson" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY ("serverId") REFERENCES "SshServer"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    'CREATE INDEX IF NOT EXISTS "SshLoginAudit_serverId_attemptedAt_idx" ON "SshLoginAudit"("serverId", "attemptedAt");',
  ];

  for (const statement of statements) {
    await client.$executeRawUnsafe(statement);
  }
};

export const initializeDatabase = async ({ runtimeMode }: InitializeDatabaseOptions): Promise<PrismaClientType> => {
  if (prismaClient) {
    return prismaClient;
  }

  if (initializingClientPromise) {
    return initializingClientPromise;
  }

  initializingClientPromise = (async () => {
    let databaseFilePath: string;
    let databaseKey: string;

    try {
      databaseFilePath = getDatabasePath();
    } catch (error: unknown) {
      withDbError('DB_PATH_RESOLVE_FAILED', 'Failed to resolve database path.', { runtimeMode }, error);
    }

    try {
      databaseKey = getDatabaseEncryptionKey();
    } catch (error: unknown) {
      withDbError('DB_KEY_RESOLVE_FAILED', 'Failed to resolve database encryption key.', { runtimeMode }, error);
    }

    const databaseDirPath = path.dirname(databaseFilePath!);
    const databaseUrl = toPrismaSqliteUrl(databaseFilePath!);

    try {
      await ensureSecureDirectory(databaseDirPath);
    } catch (error: unknown) {
      withDbError(
        'DB_DIRECTORY_PREPARE_FAILED',
        'Failed to prepare secure database directory.',
        { runtimeMode, databaseDirPath },
        error,
      );
    }

    try {
      await ensureSecureFile(databaseFilePath!);
    } catch (error: unknown) {
      withDbError(
        'DB_FILE_PREPARE_FAILED',
        'Failed to prepare secure database file.',
        { runtimeMode, databaseFilePath: databaseFilePath! },
        error,
      );
    }

    let sqlCipherEnabled = false;

    try {
      if (isDevelopmentRuntime()) {
        ensureDevelopmentPlaintextDatabase(databaseFilePath!, databaseKey!);
        sqlCipherEnabled = false;
      } else {
        sqlCipherEnabled = bootstrapSqlCipher(databaseFilePath!, databaseKey!);
      }
    } catch (error: unknown) {
      withDbError(
        'DB_SQLCIPHER_BOOTSTRAP_FAILED',
        'Failed to bootstrap SQLCipher before Prisma initialization.',
        { runtimeMode, databaseFilePath: databaseFilePath! },
        error,
      );
    }

    let client = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });

    try {
      await client.$connect();
    } catch (error: unknown) {
      withDbError(
        'DB_CONNECT_FAILED',
        'Failed to connect Prisma client to database.',
        { runtimeMode, databaseFilePath: databaseFilePath! },
        error,
      );
    }

    try {
      await applyPragmas(client, runtimeMode, databaseKey!, sqlCipherEnabled);
    } catch (error: unknown) {
      const shouldFallbackToCompatibilityMode =
        !isDevelopmentRuntime() && sqlCipherEnabled && isPrismaSqliteFileUnreadableError(error);

      if (shouldFallbackToCompatibilityMode) {
        console.warn(
          '[db:init] Prisma could not read SQLCipher database. Falling back to compatibility mode by decrypting database for Prisma runtime.',
        );
        await client.$disconnect();
        ensureDevelopmentPlaintextDatabase(databaseFilePath!, databaseKey!);

        client = new PrismaClient({
          datasources: {
            db: {
              url: databaseUrl,
            },
          },
        });

        await client.$connect();
        try {
          await applyPragmas(client, runtimeMode, databaseKey!, false);
        } catch (fallbackError: unknown) {
          if (isPrismaSqliteFileUnreadableError(fallbackError)) {
            console.warn(
              '[db:init] Database remains unreadable after compatibility fallback. Backing up corrupted files and reinitializing a fresh database.',
            );
            await client.$disconnect();
            await backupUnreadableDatabaseFiles(databaseFilePath!);
            await ensureSecureFile(databaseFilePath!);

            client = new PrismaClient({
              datasources: {
                db: {
                  url: databaseUrl,
                },
              },
            });

            await client.$connect();
            await applyPragmas(client, runtimeMode, databaseKey!, false);
          } else {
            await client.$disconnect();
            withDbError(
              'DB_PRAGMA_FAILED',
              'Failed to apply SQLite PRAGMA settings.',
              { runtimeMode, databaseFilePath: databaseFilePath! },
              fallbackError,
            );
          }
        }
      } else {
        await client.$disconnect();
        withDbError(
          'DB_PRAGMA_FAILED',
          'Failed to apply SQLite PRAGMA settings.',
          { runtimeMode, databaseFilePath: databaseFilePath! },
          error,
        );
      }
    }

    try {
      await ensureSchema(client);
    } catch (error: unknown) {
      await client.$disconnect();
      withDbError(
        'DB_SCHEMA_BOOTSTRAP_FAILED',
        'Failed to bootstrap database schema for runtime startup.',
        { runtimeMode, databaseFilePath: databaseFilePath! },
        error,
      );
    }

    prismaClient = client;
    return client;
  })();

  try {
    return await initializingClientPromise;
  } finally {
    initializingClientPromise = null;
  }
};

export const shutdownDatabase = async (): Promise<void> => {
  if (!prismaClient) {
    return;
  }

  try {
    await prismaClient.$disconnect();
    prismaClient = null;
  } catch (error: unknown) {
    withDbError('DB_DISCONNECT_FAILED', 'Failed to disconnect Prisma client.', {}, error);
  }
};
