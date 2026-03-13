import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app, safeStorage } from 'electron';

/**
 * Persisted security config stored in userData.
 * Only encrypted material or verification metadata is stored here.
 */
type DatabaseSecurityConfig = {
  encryptedDbMasterKey?: string;
  masterPasswordHash?: string;
  masterPasswordSalt?: string;
};

export type DatabaseSecurityInfo = {
  runtimeMode: 'development' | 'production';
  resolverMode: 'development-fixed-key' | 'safe-storage' | 'master-password-fallback';
  safeStorageAvailable: boolean;
  databasePath: string;
  securityConfigPath: string;
  hasEncryptedDbMasterKey: boolean;
  hasMasterPasswordHash: boolean;
  hasMasterPasswordSalt: boolean;
  hasMasterPasswordEnv: boolean;
  fallbackReady: boolean;
};

const DATABASE_FILE_NAME = 'cosmosh.db';
const DEV_MASTER_KEY = 'cosmosh_dev_key';
const CONFIG_FILE_NAME = 'security.config.json';

/**
 * Resolves workspace root in development to keep local DB artifacts outside packaged runtime.
 */
const getProjectRootFromAppPath = (): string => {
  return path.resolve(app.getAppPath(), '../../..');
};

const getSecurityConfigPath = (): string => {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
};

/**
 * Narrows unknown errors to Node errno-compatible errors.
 *
 * @param error Unknown thrown value.
 * @returns `true` when an errno code is available.
 */
const isErrnoError = (error: unknown): error is NodeJS.ErrnoException => {
  return typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string';
};

/**
 * Reads persisted security configuration from userData.
 * Missing config is treated as first-run state; malformed config is treated as fatal.
 */
const readSecurityConfig = async (): Promise<DatabaseSecurityConfig> => {
  const configPath = getSecurityConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(content) as DatabaseSecurityConfig;
    return {
      encryptedDbMasterKey: parsed.encryptedDbMasterKey,
      masterPasswordHash: parsed.masterPasswordHash,
      masterPasswordSalt: parsed.masterPasswordSalt,
    };
  } catch (error) {
    if (isErrnoError(error) && error.code === 'ENOENT') {
      return {};
    }

    throw new Error(
      `[db:key] Failed to read security config at ${configPath}. Refusing to rotate database key automatically.`,
      { cause: error },
    );
  }
};

const writeSecurityConfig = async (config: DatabaseSecurityConfig): Promise<void> => {
  const configPath = getSecurityConfigPath();
  const configDir = path.dirname(configPath);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
};

const normalizeHashHex = (hash: string): Buffer => {
  return Buffer.from(hash.trim().toLowerCase(), 'hex');
};

/**
 * Derives a deterministic password verification hash.
 * Uses scrypt to ensure sufficient computational cost for offline attacks.
 */
const deriveMasterPasswordHash = (password: string, salt: string): string => {
  return scryptSync(password, salt, 32).toString('hex');
};

const deriveDatabaseKeyFromMasterPassword = (password: string, salt: string): string => {
  return scryptSync(password, salt, 32).toString('hex');
};

/**
 * Fallback path when OS secure storage is unavailable.
 * Production requires an externally provided master password and stored verifier metadata.
 */
const resolveDatabaseKeyFromMasterPasswordFallback = async (
  config: DatabaseSecurityConfig,
  isDev: boolean,
): Promise<string> => {
  if (isDev) {
    return DEV_MASTER_KEY;
  }

  const masterPasswordHash = config.masterPasswordHash;
  if (!masterPasswordHash) {
    throw new Error(
      '[db:key] secure storage unavailable and no master_password_hash found in config. Renderer IPC for "Set Master Password" is required. Temporary fallback: set COSMOSH_DB_MASTER_PASSWORD and pre-provision master password hash config.',
    );
  }

  const masterPassword = process.env.COSMOSH_DB_MASTER_PASSWORD;
  const masterPasswordSalt = config.masterPasswordSalt;
  if (!masterPassword || !masterPasswordSalt) {
    throw new Error(
      '[db:key] secure storage unavailable. Missing COSMOSH_DB_MASTER_PASSWORD or masterPasswordSalt in config. Please set master password flow or provide fallback env configuration.',
    );
  }

  const expectedHash = normalizeHashHex(masterPasswordHash);
  const actualHash = normalizeHashHex(deriveMasterPasswordHash(masterPassword, masterPasswordSalt));

  if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
    throw new Error('[db:key] master password verification failed in fallback mode.');
  }

  return deriveDatabaseKeyFromMasterPassword(masterPassword, masterPasswordSalt);
};

/**
 * Returns the SQLite file path used by backend runtime.
 * Development and packaged modes intentionally use different storage roots.
 */
export const getDatabasePath = (): string => {
  const isDev = !app.isPackaged;

  if (isDev) {
    return path.join(getProjectRootFromAppPath(), '.dev_data', DATABASE_FILE_NAME);
  }

  return path.join(app.getPath('userData'), DATABASE_FILE_NAME);
};

/**
 * Converts an absolute filesystem path to Prisma-compatible SQLite URL.
 */
export const toPrismaSqliteUrl = (databasePath: string): string => {
  const normalizedPath = databasePath.split(path.sep).join('/');
  return `file:${normalizedPath}`;
};

/**
 * Resolves database encryption key with secure-storage-first strategy.
 * In production, a random key is generated once and persisted as encrypted payload.
 */
export const getDatabaseEncryptionKey = async (): Promise<string> => {
  const isDev = !app.isPackaged;

  if (isDev) {
    return DEV_MASTER_KEY;
  }

  const config = await readSecurityConfig();

  if (safeStorage.isEncryptionAvailable()) {
    if (config.encryptedDbMasterKey) {
      console.log('[db:key] Loading encrypted database master key from secure storage config.');
      const decrypted = safeStorage.decryptString(Buffer.from(config.encryptedDbMasterKey, 'base64'));
      return decrypted;
    }

    console.log('[db:key] Generating new database master key and storing encrypted payload in secure storage config.');
    const generatedMasterKey = randomBytes(32).toString('hex');
    const encryptedMasterKey = safeStorage.encryptString(generatedMasterKey).toString('base64');

    await writeSecurityConfig({
      ...config,
      encryptedDbMasterKey: encryptedMasterKey,
    });

    return generatedMasterKey;
  }

  console.warn('[db:key] Electron safeStorage is unavailable. Falling back to master password mode.');
  return resolveDatabaseKeyFromMasterPasswordFallback(config, isDev);
};

/**
 * Exports plaintext key for controlled operational workflows.
 * This should only be used in trusted code paths.
 */
export const exportPlainTextKey = async (): Promise<string> => {
  const isDev = !app.isPackaged;
  if (isDev) {
    return DEV_MASTER_KEY;
  }

  const config = await readSecurityConfig();

  if (config.encryptedDbMasterKey && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(config.encryptedDbMasterKey, 'base64'));
  }

  return resolveDatabaseKeyFromMasterPasswordFallback(config, isDev);
};

/**
 * Returns non-sensitive database security diagnostics for renderer observability.
 */
export const getDatabaseSecurityInfo = async (): Promise<DatabaseSecurityInfo> => {
  const isDev = !app.isPackaged;
  const config = await readSecurityConfig();
  const safeStorageAvailable = safeStorage.isEncryptionAvailable();
  const hasMasterPasswordEnv =
    typeof process.env.COSMOSH_DB_MASTER_PASSWORD === 'string' &&
    process.env.COSMOSH_DB_MASTER_PASSWORD.trim().length > 0;

  const resolverMode: DatabaseSecurityInfo['resolverMode'] = isDev
    ? 'development-fixed-key'
    : safeStorageAvailable
      ? 'safe-storage'
      : 'master-password-fallback';

  const hasEncryptedDbMasterKey =
    typeof config.encryptedDbMasterKey === 'string' && config.encryptedDbMasterKey.trim().length > 0;
  const hasMasterPasswordHash =
    typeof config.masterPasswordHash === 'string' && config.masterPasswordHash.trim().length > 0;
  const hasMasterPasswordSalt =
    typeof config.masterPasswordSalt === 'string' && config.masterPasswordSalt.trim().length > 0;

  return {
    runtimeMode: isDev ? 'development' : 'production',
    resolverMode,
    safeStorageAvailable,
    databasePath: getDatabasePath(),
    securityConfigPath: getSecurityConfigPath(),
    hasEncryptedDbMasterKey,
    hasMasterPasswordHash,
    hasMasterPasswordSalt,
    hasMasterPasswordEnv,
    fallbackReady: hasMasterPasswordHash && hasMasterPasswordSalt && hasMasterPasswordEnv,
  };
};
