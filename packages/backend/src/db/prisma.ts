import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';

export type RuntimeMode = 'standalone' | 'electron-main';

type InitializeDatabaseOptions = {
  runtimeMode: RuntimeMode;
};

type DatabaseErrorCode =
  | 'DB_PATH_RESOLVE_FAILED'
  | 'DB_DIRECTORY_PREPARE_FAILED'
  | 'DB_FILE_PREPARE_FAILED'
  | 'DB_ACL_APPLY_FAILED'
  | 'DB_CONNECT_FAILED'
  | 'DB_PRAGMA_FAILED'
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

const DB_FILE_NAME = 'cosmosh.sqlite';
const isWindows = process.platform === 'win32';
const execFileAsync = promisify(execFile);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const backendRootDir = path.resolve(currentDirPath, '../..');

// Keep a single Prisma instance in-process to avoid multiple SQLite handles.
let prismaClient: PrismaClient | null = null;
let initializingClientPromise: Promise<PrismaClient> | null = null;

/**
 * Resolve a per-user data root directory for local persistence.
 *
 * Priority order is explicit OS-level user data locations, then a
 * conservative home-directory fallback for non-Windows environments.
 */
const resolveDataRootDir = (): string => {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }

  if (process.env.XDG_DATA_HOME) {
    return process.env.XDG_DATA_HOME;
  }

  return path.join(os.homedir(), '.local', 'share');
};

/**
 * Compute the final SQLite file path by runtime mode.
 *
 * - `electron-main`: user-local application storage
 * - `standalone`: backend package-local hidden directory
 */
const resolveDatabaseFilePath = (runtimeMode: RuntimeMode): string => {
  // Electron mode stores DB under user-local app data.
  if (runtimeMode === 'electron-main') {
    return path.join(resolveDataRootDir(), 'Cosmosh', 'backend', 'storage', DB_FILE_NAME);
  }

  // Standalone backend keeps DB under backend package-local hidden folder.
  return path.join(backendRootDir, '.cosmosh', 'backend', 'storage', DB_FILE_NAME);
};

/**
 * Convert an internal failure into a structured database initialization error.
 */
const withDbError = (
  code: DatabaseErrorCode,
  message: string,
  context: DatabaseErrorContext,
  cause: unknown,
): never => {
  throw new DatabaseInitError(code, message, context, cause);
};

/**
 * Resolve DB path and normalize failure into `DatabaseInitError`.
 */
const resolveDatabaseFilePathOrThrow = (runtimeMode: RuntimeMode): string => {
  try {
    return resolveDatabaseFilePath(runtimeMode);
  } catch (error: unknown) {
    withDbError('DB_PATH_RESOLVE_FAILED', 'Failed to resolve SQLite database path.', { runtimeMode }, error);
    throw new Error('Unreachable');
  }
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

/**
 * Ensure the directory exists with restrictive permissions where supported.
 */
const ensureSecureDirectory = async (directoryPath: string): Promise<void> => {
  // Restrict directory access to current user where platform supports POSIX modes.
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

/**
 * Ensure DB file exists and remains writable by current process.
 */
const ensureSecureFile = async (filePath: string): Promise<void> => {
  try {
    // Create-once semantics prevent accidental overwrite of an existing DB file.
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

/**
 * Convert OS path format into a Prisma SQLite datasource URL.
 */
const toPrismaSqliteUrl = (filePath: string): string => {
  const normalizedPath = filePath.split(path.sep).join('/');
  return `file:${encodeURI(normalizedPath)}`;
};

/**
 * Apply runtime safety/performance pragmas immediately after connect.
 */
const applyPragmas = async (client: PrismaClient, runtimeMode: RuntimeMode): Promise<void> => {
  // These pragmas are applied at startup to enforce baseline SQLite safety and runtime behavior.
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');

  // In electron-main mode we favor single-owner access semantics over shared file usage.
  if (runtimeMode === 'electron-main') {
    await client.$queryRawUnsafe('PRAGMA locking_mode = EXCLUSIVE;');
  }
};

/**
 * Initialize Prisma + SQLite once per process.
 *
 * Steps:
 * 1) Resolve path
 * 2) Prepare directory and file
 * 3) Build datasource URL
 * 4) Connect Prisma client
 * 5) Apply pragmas
 */
export const initializeDatabase = async ({ runtimeMode }: InitializeDatabaseOptions): Promise<PrismaClient> => {
  // Initialization is idempotent for repeated bootstrap calls in the same process.
  if (prismaClient) {
    return prismaClient;
  }

  if (initializingClientPromise) {
    return initializingClientPromise;
  }

  initializingClientPromise = (async () => {
    const databaseFilePath = resolveDatabaseFilePathOrThrow(runtimeMode);
    const databaseDirPath = path.dirname(databaseFilePath);
    const databaseUrl = toPrismaSqliteUrl(databaseFilePath);

    try {
      await ensureSecureDirectory(databaseDirPath);
    } catch (error: unknown) {
      withDbError(
        'DB_DIRECTORY_PREPARE_FAILED',
        'Failed to prepare secure SQLite directory.',
        { runtimeMode, databaseDirPath },
        error,
      );
    }

    try {
      await ensureSecureFile(databaseFilePath);
    } catch (error: unknown) {
      withDbError(
        'DB_FILE_PREPARE_FAILED',
        'Failed to prepare secure SQLite database file.',
        { runtimeMode, databaseFilePath },
        error,
      );
    }

    // Avoid mutating global process env; keep datasource URL local to this client.
    const client = new PrismaClient({
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
        'Failed to connect Prisma client to SQLite.',
        { runtimeMode, databaseFilePath },
        error,
      );
    }

    try {
      await applyPragmas(client, runtimeMode);
    } catch (error: unknown) {
      await client.$disconnect();
      withDbError(
        'DB_PRAGMA_FAILED',
        'Failed to apply SQLite PRAGMA settings.',
        { runtimeMode, databaseFilePath },
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

/**
 * Disconnect Prisma client if initialized.
 */
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
