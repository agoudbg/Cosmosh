import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient as PrismaClientType } from '@prisma/client';
import prismaClientPackage from '@prisma/client';

const { PrismaClient, Prisma } = prismaClientPackage;
const require = createRequire(import.meta.url);

/**
 * Minimal SQLCipher-capable database shape used from better-sqlite3-multiple-ciphers.
 */
type BetterSqlite3LikeDatabase = {
  pragma: (statement: string) => unknown;
  prepare: (statement: string) => { get: () => unknown };
  close: () => void;
};

/**
 * Constructor signature for SQLCipher driver used by bootstrap helpers.
 */
type BetterSqlite3LikeConstructor = new (filePath: string) => BetterSqlite3LikeDatabase;

/**
 * Backend runtime execution mode.
 */
export type RuntimeMode = 'standalone' | 'electron-main';

/**
 * Runtime options for database initialization.
 */
type InitializeDatabaseOptions = {
  runtimeMode: RuntimeMode;
};

type RuntimeMigrationFile = {
  migrationName: string;
  migrationSqlPath: string;
};

type RuntimeMigrationRecordRow = {
  migration_name: string;
};

type RuntimeMigrationExecuteClient = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
};

type RuntimeMigrationSqlClient = RuntimeMigrationExecuteClient & {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
};

type RuntimeAddColumnMigrationStatement = {
  statement: string;
  tableName: string;
  columnName: string;
};

type SqliteTableColumnRow = {
  name: string;
};

/**
 * Stable error codes emitted by database bootstrap/runtime operations.
 */
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

/**
 * Additional structured context included in DatabaseInitError.
 */
type DatabaseErrorContext = Record<string, string>;

/**
 * Structured database initialization/runtime error with stable code and context.
 */
export class DatabaseInitError extends Error {
  public readonly code: DatabaseErrorCode;
  public readonly context: DatabaseErrorContext;

  /**
   * Creates a structured database initialization/runtime error.
   *
   * @param code Stable error code.
   * @param message Human-readable error message.
   * @param context Structured diagnostic context.
   * @param cause Original underlying error.
   */
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

/**
 * Formats elapsed database startup timing in milliseconds.
 *
 * @param startedAt Epoch millisecond timestamp captured before the measured work.
 * @returns Human-readable elapsed duration in milliseconds.
 */
const formatDbElapsedMs = (startedAt: number): string => {
  return `${Date.now() - startedAt}ms`;
};

/**
 * Lazily resolves the optional SQLCipher-capable sqlite driver.
 *
 * @returns SQLCipher driver constructor when available, otherwise null.
 */
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

/**
 * Resolves whether current process should run with development behaviors.
 *
 * @returns True when development runtime flags are active.
 */
const isDevelopmentRuntime = (): boolean => {
  if (process.env.COSMOSH_APP_ENV === 'development') {
    return true;
  }

  if (process.env.COSMOSH_APP_ENV === 'production') {
    return false;
  }

  return process.env.NODE_ENV !== 'production';
};

/**
 * Throws a strongly typed database error with stable code and context.
 *
 * @param code Stable initialization/runtime error code.
 * @param message Human-readable error message.
 * @param context Structured context for diagnostics.
 * @param cause Original underlying error.
 * @returns Never returns because it always throws.
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
 * Resolves the current Windows user identity for ACL assignment.
 *
 * @returns Domain-qualified identity when available, otherwise local username.
 */
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

/**
 * Applies restrictive ACLs for the current user and SYSTEM on Windows.
 *
 * @param targetPath File or directory path to protect.
 * @param isDirectory Whether the target path is a directory.
 * @returns Promise that resolves when ACL changes are applied.
 */
const applyWindowsAcl = async (targetPath: string, isDirectory: boolean): Promise<void> => {
  const identity = await resolveWindowsIdentity();
  const userPermission = isDirectory ? `${identity}:(OI)(CI)F` : `${identity}:F`;
  const systemPermission = isDirectory ? 'SYSTEM:(OI)(CI)F' : 'SYSTEM:F';

  await execFileAsync('icacls', [targetPath, '/inheritance:r']);
  await execFileAsync('icacls', [targetPath, '/grant:r', userPermission, systemPermission]);
};

/**
 * Ensures secure directory permissions for database storage.
 *
 * @param directoryPath Absolute directory path containing sqlite files.
 * @returns Promise that resolves after permissions are enforced.
 */
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

/**
 * Ensures database file existence and secure read/write permissions.
 *
 * @param filePath Absolute sqlite file path.
 * @returns Promise that resolves after file permission checks pass.
 */
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

/**
 * Resolves database file path for current runtime mode.
 *
 * @returns Absolute sqlite database file path.
 */
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

/**
 * Resolves database encryption key from runtime mode/environment.
 *
 * @returns Encryption key used by SQLCipher/bootstrap flow.
 */
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

/**
 * Converts an absolute file path into Prisma sqlite datasource URL format.
 *
 * @param filePath Absolute sqlite file path.
 * @returns Prisma sqlite URL string.
 */
const toPrismaSqliteUrl = (filePath: string): string => {
  const normalizedPath = filePath.split(path.sep).join('/');
  return `file:${normalizedPath}`;
};

/**
 * Escapes single quotes for SQLite string literals used in PRAGMA statements.
 *
 * @param input Raw string value.
 * @returns Escaped string safe for SQL string literal embedding.
 */
const escapeSqliteLiteral = (input: string): string => {
  return input.replace(/'/g, "''");
};

/**
 * Escapes double quotes for SQLite identifiers embedded in trusted metadata queries.
 *
 * @param input Raw identifier value.
 * @returns Identifier text safe to wrap in double quotes.
 */
const escapeSqliteIdentifier = (input: string): string => {
  return input.replace(/"/g, '""');
};

/**
 * Detects native driver load/runtime incompatibility conditions.
 *
 * @param error Unknown thrown error value.
 * @returns True when error indicates missing/incompatible native bindings.
 */
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

/**
 * Detects unreadable SQLite file errors returned through Prisma.
 *
 * @param error Unknown thrown error value.
 * @returns True when Prisma reports sqlite file corruption/incompatibility.
 */
const isPrismaSqliteFileUnreadableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('file is not a database')) {
    return true;
  }

  const code = (error as { code?: string })?.code;
  const metaCode = (error as { meta?: { code?: string } })?.meta?.code;
  return code === 'P2010' && metaCode === '26';
};

/**
 * Converts an SQLCipher-encrypted development DB file back to plaintext.
 *
 * @param databaseFilePath SQLite file path.
 * @param databaseKey Encryption key used to unlock SQLCipher file.
 * @returns Void.
 */
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

/**
 * Verifies SQLCipher access and prepares encrypted runtime behavior.
 *
 * @param databaseFilePath SQLite file path.
 * @param databaseKey Encryption key used for SQLCipher bootstrap.
 * @returns True when SQLCipher path is active; false when falling back to plaintext compatibility mode.
 */
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

/**
 * Creates a Prisma client bound to the runtime-resolved SQLite datasource URL.
 *
 * @param databaseUrl Prisma sqlite datasource URL.
 * @returns Configured Prisma client instance.
 */
const createPrismaClient = (databaseUrl: string): PrismaClientType => {
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
};

/**
 * Connects a Prisma client and wraps failures with stable DB_CONNECT_FAILED metadata.
 *
 * @param client Prisma client to connect.
 * @param runtimeMode Backend runtime mode for diagnostics.
 * @param databaseFilePath SQLite file path for diagnostics.
 * @returns Promise that resolves after successful client connection.
 */
const connectPrismaClient = async (
  client: PrismaClientType,
  runtimeMode: RuntimeMode,
  databaseFilePath: string,
): Promise<void> => {
  try {
    await client.$connect();
  } catch (error: unknown) {
    withDbError(
      'DB_CONNECT_FAILED',
      'Failed to connect Prisma client to database.',
      { runtimeMode, databaseFilePath },
      error,
    );
  }
};

/**
 * Runs a SQLite PRAGMA statement through Prisma query mode.
 *
 * Prisma `$executeRaw` rejects SQLite statements that return result rows.
 * Several PRAGMA statements (for example `journal_mode` and `locking_mode`)
 * always return values, so this helper keeps PRAGMA execution stable.
 *
 * @param client Active Prisma client.
 * @param statement Complete PRAGMA SQL statement.
 * @returns Promise that resolves after Prisma has executed the statement.
 */
const runPragma = async (client: PrismaClientType, statement: string): Promise<void> => {
  await client.$queryRawUnsafe(statement);
};

/**
 * Applies required SQLite pragmas for reliability and runtime locking behavior.
 *
 * @param client Active Prisma client.
 * @param runtimeMode Current backend runtime mode.
 * @param databaseKey Resolved database encryption key.
 * @param sqlCipherEnabled Whether SQLCipher mode is currently active.
 * @returns Promise that resolves after all pragmas are applied.
 */
const applyPragmas = async (
  client: PrismaClientType,
  runtimeMode: RuntimeMode,
  databaseKey: string,
  sqlCipherEnabled: boolean,
): Promise<void> => {
  if (!isDevelopmentRuntime() && sqlCipherEnabled) {
    await runPragma(client, `PRAGMA key = '${escapeSqliteLiteral(databaseKey)}';`);
  }
  await runPragma(client, 'PRAGMA foreign_keys = ON;');
  await runPragma(client, 'PRAGMA journal_mode = WAL;');
  await runPragma(client, 'PRAGMA synchronous = NORMAL;');
  await runPragma(client, 'PRAGMA busy_timeout = 5000;');

  if (runtimeMode === 'electron-main' && !isDevelopmentRuntime() && sqlCipherEnabled) {
    await runPragma(client, 'PRAGMA locking_mode = EXCLUSIVE;');
  }
};

const requiredSchemaTables = [
  'SshFolder',
  'SshTag',
  'SshServer',
  'SshKnownHost',
  'AppSettings',
  'SshServerTag',
  'SshLoginAudit',
  'PortForwardRule',
] as const;

const RUNTIME_MIGRATION_TABLE_NAME = '_prisma_migrations';

/**
 * Resolves Prisma migration directory path for the current backend runtime package.
 *
 * @returns Absolute directory path containing Prisma migrations.
 */
const getPrismaMigrationsDirPath = (): string => {
  return path.join(backendRootDir, 'prisma', 'migrations');
};

/**
 * Ensures migration bookkeeping table exists before applying runtime migrations.
 *
 * @param client Active Prisma client.
 * @returns Promise that resolves when migration bookkeeping table is ready.
 */
const ensureRuntimeMigrationTable = async (client: PrismaClientType): Promise<void> => {
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${RUNTIME_MIGRATION_TABLE_NAME}" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL UNIQUE, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0);`,
  );
};

/**
 * Builds a deterministic Prisma migration row id from migration metadata.
 *
 * @param migrationName Migration directory name.
 * @param checksum SHA-256 checksum of migration SQL payload.
 * @returns Stable migration id string.
 */
const buildMigrationRecordId = (migrationName: string, checksum: string): string => {
  return `${migrationName}-${checksum.slice(0, 16)}`;
};

/**
 * Discovers migration folders that contain Prisma-generated migration.sql payloads.
 *
 * @returns Sorted migration descriptors ready for runtime execution.
 */
const listPrismaMigrationFiles = async (): Promise<RuntimeMigrationFile[]> => {
  const migrationsDirPath = getPrismaMigrationsDirPath();

  let entries;
  try {
    entries = await readdir(migrationsDirPath, { withFileTypes: true });
  } catch (error: unknown) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const migrationDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const migrationFiles: RuntimeMigrationFile[] = [];
  for (const migrationName of migrationDirectories) {
    const migrationSqlPath = path.join(migrationsDirPath, migrationName, 'migration.sql');

    try {
      await access(migrationSqlPath, fsConstants.R_OK);
      migrationFiles.push({ migrationName, migrationSqlPath });
    } catch (error: unknown) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        throw error;
      }
    }
  }

  return migrationFiles;
};

/**
 * Reads migration names already applied in the current database file.
 *
 * @param client Active Prisma client.
 * @returns Set of migration names already recorded as applied.
 */
const readAppliedMigrationSet = async (client: PrismaClientType): Promise<Set<string>> => {
  const rows = (await client.$queryRawUnsafe(
    `SELECT "migration_name" FROM "${RUNTIME_MIGRATION_TABLE_NAME}" WHERE "rolled_back_at" IS NULL AND "finished_at" IS NOT NULL ORDER BY "migration_name" ASC;`,
  )) as RuntimeMigrationRecordRow[];

  return new Set(rows.map((row) => row.migration_name));
};

/**
 * Detects whether this DB already has the current schema but no migration ledger yet.
 *
 * @param client Active Prisma client.
 * @returns True when required schema tables already exist.
 */
const hasRequiredSchemaTables = async (client: PrismaClientType): Promise<boolean> => {
  const foundRows = (await client.$queryRaw(
    Prisma.sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${Prisma.join(requiredSchemaTables)});`,
  )) as Array<{ name: string }>;

  return foundRows.length === requiredSchemaTables.length;
};

/**
 * Records all migration files as already applied for legacy databases.
 *
 * @param client Active Prisma client.
 * @param migrationFiles Discovered migration file descriptors.
 * @returns Promise that resolves once baseline records are persisted.
 */
const baselineExistingSchemaMigrations = async (
  client: PrismaClientType,
  migrationFiles: RuntimeMigrationFile[],
): Promise<void> => {
  for (const migrationFile of migrationFiles) {
    const migrationSql = await readFile(migrationFile.migrationSqlPath, 'utf8');
    const checksum = createHash('sha256').update(migrationSql).digest('hex');
    const migrationRecordId = buildMigrationRecordId(migrationFile.migrationName, checksum);

    await client.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "${RUNTIME_MIGRATION_TABLE_NAME}" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count") VALUES ('${escapeSqliteLiteral(migrationRecordId)}', '${escapeSqliteLiteral(checksum)}', '${escapeSqliteLiteral(migrationFile.migrationName)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1);`,
    );
  }
};

const PRISMA_ADD_COLUMN_STATEMENT_PATTERN =
  /^ALTER\s+TABLE\s+"((?:[^"]|"")*)"\s+ADD\s+COLUMN\s+"((?:[^"]|"")*)"(?:\s|$)/iu;

/**
 * Restores a SQLite double-quoted identifier to logical identifier text.
 *
 * @param quotedContent Content captured from inside double quotes.
 * @returns Unescaped identifier text.
 */
const unescapeSqliteQuotedIdentifier = (quotedContent: string): string => {
  return quotedContent.replace(/""/g, '"');
};

/**
 * Parses a Prisma-generated SQLite ADD COLUMN statement.
 *
 * @param statement SQL statement without the trailing semicolon.
 * @returns Parsed ADD COLUMN metadata, or `null` for unsupported SQL.
 */
const parsePrismaAddColumnStatement = (statement: string): RuntimeAddColumnMigrationStatement | null => {
  const match = statement.match(PRISMA_ADD_COLUMN_STATEMENT_PATTERN);
  if (!match) {
    return null;
  }

  return {
    statement,
    tableName: unescapeSqliteQuotedIdentifier(match[1]),
    columnName: unescapeSqliteQuotedIdentifier(match[2]),
  };
};

/**
 * Parses a migration only when every statement is a Prisma-generated ADD COLUMN.
 *
 * @param statements SQL statements from one migration file.
 * @returns Parsed ADD COLUMN statements, or `null` when any statement is unsupported.
 */
const parsePrismaAddColumnMigrationStatements = (statements: string[]): RuntimeAddColumnMigrationStatement[] | null => {
  if (statements.length === 0) {
    return null;
  }

  const parsedStatements: RuntimeAddColumnMigrationStatement[] = [];
  for (const statement of statements) {
    const parsedStatement = parsePrismaAddColumnStatement(statement);
    if (!parsedStatement) {
      return null;
    }

    parsedStatements.push(parsedStatement);
  }

  return parsedStatements;
};

/**
 * Reads the current column names for a SQLite table.
 *
 * @param client Prisma client or transaction client.
 * @param tableName Table name to inspect.
 * @returns Set of existing column names.
 */
const listSqliteTableColumnNames = async (
  client: RuntimeMigrationSqlClient,
  tableName: string,
): Promise<Set<string>> => {
  const rows = (await client.$queryRawUnsafe(
    `PRAGMA table_info("${escapeSqliteIdentifier(tableName)}");`,
  )) as SqliteTableColumnRow[];

  return new Set(rows.map((row) => row.name));
};

/**
 * Applies a simple ADD COLUMN migration while tolerating already-present columns.
 *
 * This protects runtime startup from branch-transfer or interrupted-bootstrap
 * states where SQLite already contains the column but `_prisma_migrations`
 * does not yet contain the matching migration row.
 *
 * @param client Prisma client or transaction client.
 * @param statements Parsed ADD COLUMN statements for one migration file.
 * @param migrationName Migration name used in diagnostic logging.
 * @returns Promise that resolves once missing columns are added.
 */
const applyPrismaAddColumnMigrationStatements = async (
  client: RuntimeMigrationSqlClient,
  statements: RuntimeAddColumnMigrationStatement[],
  migrationName: string,
): Promise<void> => {
  const columnNameCache = new Map<string, Set<string>>();

  for (const statement of statements) {
    let columnNames = columnNameCache.get(statement.tableName);
    if (!columnNames) {
      columnNames = await listSqliteTableColumnNames(client, statement.tableName);
      columnNameCache.set(statement.tableName, columnNames);
    }

    if (columnNames.has(statement.columnName)) {
      console.log(
        `[db:init] Skipped already-applied ADD COLUMN statement for ${migrationName}: ${statement.tableName}.${statement.columnName}.`,
      );
      continue;
    }

    await client.$executeRawUnsafe(statement.statement);
    columnNames.add(statement.columnName);
  }
};

/**
 * Splits a Prisma migration SQL file into executable statements.
 *
 * @param migrationSql Prisma migration.sql file contents.
 * @returns SQL statements without comments and trailing semicolons.
 */
const splitMigrationStatements = (migrationSql: string): string[] => {
  const sqlWithoutLineComments = migrationSql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  return sqlWithoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
};

/**
 * Detects whether a migration needs non-transactional execution.
 *
 * SQLite ignores `PRAGMA foreign_keys=OFF` inside an active transaction.
 * Prisma-generated SQLite migrations commonly rely on this pragma while
 * rebuilding tables, so these files must execute statement-by-statement
 * outside `client.$transaction(...)`.
 *
 * @param migrationSql Full migration.sql contents.
 * @returns True when migration toggles SQLite foreign key enforcement.
 */
const requiresNonTransactionalSqliteExecution = (migrationSql: string): boolean => {
  return /PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)/i.test(migrationSql);
};

/**
 * Records a runtime migration as successfully applied.
 *
 * @param client Prisma client or transaction client.
 * @param migrationName Migration directory name.
 * @param checksum SHA-256 checksum for the migration SQL.
 * @param appliedStepsCount Number of executable SQL statements represented by the migration.
 * @returns Promise that resolves after the ledger row is inserted.
 */
const recordRuntimeMigrationApplied = async (
  client: RuntimeMigrationExecuteClient,
  migrationName: string,
  checksum: string,
  appliedStepsCount: number,
): Promise<void> => {
  const migrationRecordId = buildMigrationRecordId(migrationName, checksum);

  await client.$executeRawUnsafe(
    `INSERT INTO "${RUNTIME_MIGRATION_TABLE_NAME}" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count") VALUES ('${escapeSqliteLiteral(migrationRecordId)}', '${escapeSqliteLiteral(checksum)}', '${escapeSqliteLiteral(migrationName)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ${appliedStepsCount});`,
  );
};

/**
 * Applies pending Prisma migration files in-order on backend startup.
 *
 * @param client Active Prisma client.
 * @returns Number of migration files discovered in runtime directory.
 */
const applyPendingPrismaMigrations = async (client: PrismaClientType): Promise<number> => {
  await ensureRuntimeMigrationTable(client);

  const migrationFiles = await listPrismaMigrationFiles();
  const appliedMigrationSet = await readAppliedMigrationSet(client);
  let appliedCount = 0;

  if (appliedMigrationSet.size === 0 && migrationFiles.length > 0 && (await hasRequiredSchemaTables(client))) {
    await baselineExistingSchemaMigrations(client, migrationFiles);
    console.log(
      `[db:init] Baseline migration ledger created for legacy schema database (${migrationFiles.length} records).`,
    );
    return migrationFiles.length;
  }

  for (const migrationFile of migrationFiles) {
    if (appliedMigrationSet.has(migrationFile.migrationName)) {
      continue;
    }

    const migrationSql = await readFile(migrationFile.migrationSqlPath, 'utf8');
    const statements = splitMigrationStatements(migrationSql);
    const checksum = createHash('sha256').update(migrationSql).digest('hex');
    const migrationStartedAt = Date.now();
    const runWithoutTransaction = requiresNonTransactionalSqliteExecution(migrationSql);
    const addColumnStatements = parsePrismaAddColumnMigrationStatements(statements);

    if (addColumnStatements) {
      await client.$transaction(async (transactionClient) => {
        await applyPrismaAddColumnMigrationStatements(
          transactionClient,
          addColumnStatements,
          migrationFile.migrationName,
        );
        await recordRuntimeMigrationApplied(
          transactionClient,
          migrationFile.migrationName,
          checksum,
          statements.length,
        );
      });
    } else if (runWithoutTransaction) {
      for (const statement of statements) {
        await client.$executeRawUnsafe(statement);
      }

      await recordRuntimeMigrationApplied(client, migrationFile.migrationName, checksum, statements.length);
    } else {
      await client.$transaction(async (transactionClient) => {
        for (const statement of statements) {
          await transactionClient.$executeRawUnsafe(statement);
        }

        await recordRuntimeMigrationApplied(
          transactionClient,
          migrationFile.migrationName,
          checksum,
          statements.length,
        );
      });
    }

    console.log(`[db:init] Applied Prisma migration: ${migrationFile.migrationName}`);
    console.log(
      `[db:init] Migration ${migrationFile.migrationName} completed in ${Date.now() - migrationStartedAt}ms.`,
    );
    appliedCount += 1;
  }

  console.log(
    `[db:init] Prisma migration sync complete. discovered=${migrationFiles.length}, applied=${appliedCount}.`,
  );

  return migrationFiles.length;
};

/**
 * Synchronizes and validates required Prisma-managed schema objects at runtime.
 *
 * Startup executes pending Prisma migration files before opening HTTP routes,
 * ensuring install-time and upgrade-time databases are always reconciled.
 *
 * @param client Active Prisma client.
 * @returns Promise that resolves when all required tables are present.
 */
const ensureSchema = async (client: PrismaClientType): Promise<void> => {
  const discoveredMigrationCount = await applyPendingPrismaMigrations(client);

  if (discoveredMigrationCount === 0) {
    throw new Error(
      `No Prisma migration files found at ${getPrismaMigrationsDirPath()}. Backend startup requires bundled migrations for schema upgrades.`,
    );
  }

  const foundRows = (await client.$queryRaw(
    Prisma.sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${Prisma.join(requiredSchemaTables)});`,
  )) as Array<{ name: string }>;

  const existingTableSet = new Set(foundRows.map((row) => row.name));
  const missingTables = requiredSchemaTables.filter((table) => !existingTableSet.has(table));

  if (missingTables.length > 0) {
    throw new Error(`Missing required Prisma schema tables after runtime migrations: ${missingTables.join(', ')}.`);
  }
};

/**
 * Initializes Prisma client and database prerequisites with secure bootstrap flow.
 *
 * @param options Database initialization options.
 * @param options.runtimeMode Backend runtime mode used for lock/profile decisions.
 * @returns Singleton Prisma client ready for runtime operations.
 */
export const initializeDatabase = async ({ runtimeMode }: InitializeDatabaseOptions): Promise<PrismaClientType> => {
  if (prismaClient) {
    console.log('[startup][backend][db] Reusing initialized Prisma client.');
    return prismaClient;
  }

  if (initializingClientPromise) {
    const awaitExistingStartedAt = Date.now();
    const client = await initializingClientPromise;
    console.log(
      `[startup][backend][db] Reused in-flight database initialization after ${formatDbElapsedMs(awaitExistingStartedAt)}.`,
    );
    return client;
  }

  initializingClientPromise = (async () => {
    const initializationStartedAt = Date.now();
    console.log(`[startup][backend][db] initializeDatabase begin. runtimeMode=${runtimeMode}.`);
    let databaseFilePath: string;
    let databaseKey: string;

    try {
      const pathStartedAt = Date.now();
      databaseFilePath = getDatabasePath();
      console.log(`[startup][backend][db] Database path resolved in ${formatDbElapsedMs(pathStartedAt)}.`);
    } catch (error: unknown) {
      withDbError('DB_PATH_RESOLVE_FAILED', 'Failed to resolve database path.', { runtimeMode }, error);
    }

    try {
      const keyStartedAt = Date.now();
      databaseKey = getDatabaseEncryptionKey();
      console.log(`[startup][backend][db] Database key resolved in ${formatDbElapsedMs(keyStartedAt)}.`);
    } catch (error: unknown) {
      withDbError('DB_KEY_RESOLVE_FAILED', 'Failed to resolve database encryption key.', { runtimeMode }, error);
    }

    const databaseDirPath = path.dirname(databaseFilePath!);
    const databaseUrl = toPrismaSqliteUrl(databaseFilePath!);

    try {
      const directoryStartedAt = Date.now();
      await ensureSecureDirectory(databaseDirPath);
      console.log(
        `[startup][backend][db] Secure database directory prepared in ${formatDbElapsedMs(directoryStartedAt)}.`,
      );
    } catch (error: unknown) {
      withDbError(
        'DB_DIRECTORY_PREPARE_FAILED',
        'Failed to prepare secure database directory.',
        { runtimeMode, databaseDirPath },
        error,
      );
    }

    try {
      const fileStartedAt = Date.now();
      await ensureSecureFile(databaseFilePath!);
      console.log(`[startup][backend][db] Secure database file prepared in ${formatDbElapsedMs(fileStartedAt)}.`);
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
      const sqlCipherStartedAt = Date.now();
      if (isDevelopmentRuntime()) {
        ensureDevelopmentPlaintextDatabase(databaseFilePath!, databaseKey!);
        sqlCipherEnabled = false;
      } else {
        sqlCipherEnabled = bootstrapSqlCipher(databaseFilePath!, databaseKey!);
      }
      console.log(
        `[startup][backend][db] SQLCipher bootstrap completed in ${formatDbElapsedMs(sqlCipherStartedAt)}. enabled=${sqlCipherEnabled}.`,
      );
    } catch (error: unknown) {
      withDbError(
        'DB_SQLCIPHER_BOOTSTRAP_FAILED',
        'Failed to bootstrap SQLCipher before Prisma initialization.',
        { runtimeMode, databaseFilePath: databaseFilePath! },
        error,
      );
    }

    const clientCreatedAt = Date.now();
    const client = createPrismaClient(databaseUrl);
    console.log(`[startup][backend][db] Prisma client created in ${formatDbElapsedMs(clientCreatedAt)}.`);

    const connectStartedAt = Date.now();
    await connectPrismaClient(client, runtimeMode, databaseFilePath!);
    console.log(`[startup][backend][db] Prisma client connected in ${formatDbElapsedMs(connectStartedAt)}.`);

    try {
      const pragmaStartedAt = Date.now();
      await applyPragmas(client, runtimeMode, databaseKey!, sqlCipherEnabled);
      console.log(`[startup][backend][db] SQLite pragmas applied in ${formatDbElapsedMs(pragmaStartedAt)}.`);
    } catch (error: unknown) {
      await client.$disconnect();

      const strictModeMessage =
        !isDevelopmentRuntime() && sqlCipherEnabled && isPrismaSqliteFileUnreadableError(error)
          ? 'Prisma failed to read SQLCipher database in strict mode. Fix SQLCipher/Prisma compatibility or run approved schema migration flow before startup.'
          : 'Failed to apply SQLite PRAGMA settings.';

      withDbError('DB_PRAGMA_FAILED', strictModeMessage, { runtimeMode, databaseFilePath: databaseFilePath! }, error);
    }

    try {
      const schemaStartedAt = Date.now();
      await ensureSchema(client);
      console.log(`[startup][backend][db] Schema sync completed in ${formatDbElapsedMs(schemaStartedAt)}.`);
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
    console.log(`[startup][backend][db] initializeDatabase complete in ${formatDbElapsedMs(initializationStartedAt)}.`);
    return client;
  })();

  try {
    return await initializingClientPromise;
  } finally {
    initializingClientPromise = null;
  }
};

/**
 * Shuts down active Prisma client and releases DB resources.
 *
 * @returns Promise that resolves after all active/pending clients are disconnected.
 */
export const shutdownDatabase = async (): Promise<void> => {
  const activeClient = prismaClient;
  const pendingClientPromise = initializingClientPromise;

  if (!activeClient && !pendingClientPromise) {
    return;
  }

  try {
    if (activeClient) {
      await activeClient.$disconnect();
    } else if (pendingClientPromise) {
      const pendingClient = await pendingClientPromise;
      await pendingClient.$disconnect();
    }
  } catch (error: unknown) {
    withDbError('DB_DISCONNECT_FAILED', 'Failed to disconnect Prisma client.', {}, error);
  } finally {
    prismaClient = null;
    initializingClientPromise = null;
  }
};

/**
 * Test-only hooks for pure migration bootstrap helpers.
 */
export const __dbPrismaTesting = {
  applyPrismaAddColumnMigrationStatements,
  parsePrismaAddColumnMigrationStatements,
} as const;
