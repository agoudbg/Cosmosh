import { hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app, safeStorage } from 'electron';

/**
 * Persisted security config stored in userData.
 * Only encrypted material or verification metadata is stored here.
 */
type DatabaseSecurityConfig = {
  encryptedDbMasterKey?: string;
  emergencyFallbackDbMasterKey?: string;
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
      emergencyFallbackDbMasterKey: parsed.emergencyFallbackDbMasterKey,
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
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(configPath, 0o600);
};

/**
 * Checks whether the current database file already exists on disk.
 *
 * @returns `true` when packaged runtime database file is present.
 */
const doesDatabaseFileExist = async (): Promise<boolean> => {
  try {
    await fs.access(getDatabasePath());
    return true;
  } catch {
    return false;
  }
};

/**
 * Returns true when emergency fallback key exists in persisted config.
 *
 * @param config Persisted security config.
 * @returns `true` when emergency fallback key is provisioned.
 */
const hasEmergencyFallbackKey = (config: DatabaseSecurityConfig): boolean => {
  return (
    typeof config.emergencyFallbackDbMasterKey === 'string' && config.emergencyFallbackDbMasterKey.trim().length > 0
  );
};

/**
 * Persists a plaintext emergency fallback database key for availability-first recovery.
 *
 * @param config Existing persisted security config.
 * @param plainTextKey Database key to store for emergency fallback.
 * @returns `true` when persistence succeeds.
 */
const persistEmergencyFallbackDatabaseKey = async (
  config: DatabaseSecurityConfig,
  plainTextKey: string,
): Promise<boolean> => {
  try {
    await writeSecurityConfig({
      ...config,
      emergencyFallbackDbMasterKey: plainTextKey,
    });
    return true;
  } catch (error) {
    console.warn('[db:key] Failed to persist emergency fallback database key.', error);
    return false;
  }
};

/**
 * Returns a config copy without plaintext emergency key material.
 *
 * @param config Existing persisted security config.
 * @returns Sanitized security config.
 */
const withoutEmergencyFallbackDatabaseKey = (config: DatabaseSecurityConfig): DatabaseSecurityConfig => {
  return {
    encryptedDbMasterKey: config.encryptedDbMasterKey,
    masterPasswordHash: config.masterPasswordHash,
    masterPasswordSalt: config.masterPasswordSalt,
  };
};

/**
 * Removes plaintext emergency fallback material after secure key resolution succeeds.
 *
 * @param config Existing persisted security config.
 * @returns Promise that resolves after best-effort cleanup.
 */
const cleanupEmergencyFallbackDatabaseKey = async (config: DatabaseSecurityConfig): Promise<void> => {
  if (!hasEmergencyFallbackKey(config)) {
    return;
  }

  try {
    await writeSecurityConfig(withoutEmergencyFallbackDatabaseKey(config));
  } catch (error) {
    console.warn('[db:key] Failed to remove emergency fallback database key after safeStorage recovery.', error);
  }
};

/**
 * Persists a newly generated key through the strongest currently available resolver.
 *
 * @param config Existing persisted security config.
 * @param plainTextKey Plaintext database key to persist.
 * @returns `true` when one appropriate persistence path succeeds.
 */
const persistGeneratedDatabaseKey = async (config: DatabaseSecurityConfig, plainTextKey: string): Promise<boolean> => {
  if (safeStorage.isEncryptionAvailable()) {
    return await persistEncryptedDatabaseKeyWithSafeStorage(config, plainTextKey);
  }

  return await persistEmergencyFallbackDatabaseKey(config, plainTextKey);
};

/**
 * Returns true when fallback metadata is fully provisioned in persisted config.
 *
 * @param config Persisted database security config.
 * @returns `true` when fallback hash and salt both exist.
 */
const hasFallbackMetadata = (config: DatabaseSecurityConfig): boolean => {
  return (
    typeof config.masterPasswordHash === 'string' &&
    config.masterPasswordHash.trim().length > 0 &&
    typeof config.masterPasswordSalt === 'string' &&
    config.masterPasswordSalt.trim().length > 0
  );
};

/**
 * Returns true when runtime env can execute fallback verification.
 *
 * @param config Persisted database security config.
 * @returns `true` when metadata and env password are both present.
 */
const canUseFallbackInCurrentRuntime = (config: DatabaseSecurityConfig): boolean => {
  const hasMasterPasswordEnv =
    typeof process.env.COSMOSH_DB_MASTER_PASSWORD === 'string' &&
    process.env.COSMOSH_DB_MASTER_PASSWORD.trim().length > 0;

  return hasFallbackMetadata(config) && hasMasterPasswordEnv;
};

/**
 * Encrypts and persists a plaintext database key through `safeStorage`.
 *
 * @param config Existing persisted security config.
 * @param plainTextKey Plaintext database key to protect.
 * @returns `true` on successful encryption + persistence.
 */
const persistEncryptedDatabaseKeyWithSafeStorage = async (
  config: DatabaseSecurityConfig,
  plainTextKey: string,
): Promise<boolean> => {
  try {
    const encryptedMasterKey = safeStorage.encryptString(plainTextKey).toString('base64');
    await writeSecurityConfig({
      ...withoutEmergencyFallbackDatabaseKey(config),
      encryptedDbMasterKey: encryptedMasterKey,
    });
    return true;
  } catch (error) {
    console.warn('[db:key] Failed to encrypt/persist database key through safeStorage.', error);
    return false;
  }
};

const normalizeHashHex = (hash: string): Buffer => {
  return Buffer.from(hash.trim().toLowerCase(), 'hex');
};

const MASTER_PASSWORD_VERIFIER_CONTEXT = 'cosmosh/master-password/verifier/v1';
const MASTER_PASSWORD_DB_KEY_CONTEXT = 'cosmosh/master-password/database-key/v1';

/**
 * Derives the master-password root secret with scrypt for offline-attack cost,
 * then expands it through HKDF under a caller-supplied domain-separation context.
 * The persisted verification hash and the database key MUST come from different
 * contexts so that the stored hash never equals the encryption key.
 */
const deriveFromMasterPassword = (password: string, salt: string, context: string): string => {
  const rootSecret = scryptSync(password, salt, 32);
  return Buffer.from(hkdfSync('sha256', rootSecret, salt, context, 32)).toString('hex');
};

const deriveMasterPasswordHash = (password: string, salt: string): string => {
  return deriveFromMasterPassword(password, salt, MASTER_PASSWORD_VERIFIER_CONTEXT);
};

const deriveDatabaseKeyFromMasterPassword = (password: string, salt: string): string => {
  return deriveFromMasterPassword(password, salt, MASTER_PASSWORD_DB_KEY_CONTEXT);
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
 * Executes fallback resolver and tries migrating recovered key back to safeStorage.
 *
 * @param config Persisted security config.
 * @param isDev Whether app is currently in development mode.
 * @param reason Human-readable reason for entering fallback path.
 * @returns Resolved plaintext database key.
 */
const resolveWithFallbackAndTrySafeStorageMigration = async (
  config: DatabaseSecurityConfig,
  isDev: boolean,
  reason: string,
): Promise<string> => {
  console.warn(`[db:key] ${reason} Falling back to master password mode.`);

  const emergencyFallbackDbMasterKey = config.emergencyFallbackDbMasterKey?.trim();
  if (emergencyFallbackDbMasterKey) {
    console.log('[db:key] Using persisted emergency fallback database key.');
    if (!isDev && safeStorage.isEncryptionAvailable()) {
      const migrated = await persistEncryptedDatabaseKeyWithSafeStorage(config, emergencyFallbackDbMasterKey);
      if (migrated) {
        console.log('[db:key] Successfully migrated emergency fallback database key into safeStorage.');
      } else {
        throw new Error('[db:key] safeStorage is available but emergency fallback key migration failed.');
      }
    }

    return emergencyFallbackDbMasterKey;
  }

  try {
    const fallbackKey = await resolveDatabaseKeyFromMasterPasswordFallback(config, isDev);

    if (!isDev && safeStorage.isEncryptionAvailable()) {
      const migrated = await persistEncryptedDatabaseKeyWithSafeStorage(config, fallbackKey);
      if (migrated) {
        console.log('[db:key] Successfully migrated fallback-derived database key into safeStorage.');
      } else {
        throw new Error('[db:key] safeStorage is available but fallback-derived key migration failed.');
      }
    } else {
      await persistEmergencyFallbackDatabaseKey(config, fallbackKey);
    }

    return fallbackKey;
  } catch (fallbackError) {
    const fallbackReason = fallbackError instanceof Error ? fallbackError.message : 'unknown fallback error';

    if (!isDev) {
      const hasDatabaseFile = await doesDatabaseFileExist();
      if (!hasDatabaseFile) {
        console.warn(
          '[db:key] No existing database file detected. Auto-provisioning emergency fallback database key for first-run recovery.',
        );

        const autoProvisionedKey = randomBytes(32).toString('hex');
        const persisted = await persistGeneratedDatabaseKey(config, autoProvisionedKey);
        if (persisted) {
          return autoProvisionedKey;
        }

        throw new Error(
          `[db:key] ${reason} Fallback resolver failed (${fallbackReason}). Auto-provisioned emergency key could not be persisted.`,
        );
      }
    }

    throw new Error(`[db:key] ${reason} Fallback resolver also failed: ${fallbackReason}.`, { cause: fallbackError });
  }
};

/**
 * Resolves database key from persisted config using safeStorage-first policy,
 * while guaranteeing fallback coverage for all safeStorage-read/write failures.
 *
 * @param config Persisted security config.
 * @param isDev Whether app is currently in development mode.
 * @returns Resolved plaintext database key.
 */
const resolveDatabaseKeyFromConfig = async (config: DatabaseSecurityConfig, isDev: boolean): Promise<string> => {
  if (!safeStorage.isEncryptionAvailable()) {
    return resolveWithFallbackAndTrySafeStorageMigration(config, isDev, 'Electron safeStorage is unavailable.');
  }

  if (!config.encryptedDbMasterKey && hasEmergencyFallbackKey(config)) {
    const emergencyKey = config.emergencyFallbackDbMasterKey?.trim();
    if (emergencyKey) {
      console.log('[db:key] Restoring encryptedDbMasterKey from emergency fallback key after safeStorage recovery.');
      const persisted = await persistEncryptedDatabaseKeyWithSafeStorage(config, emergencyKey);
      if (persisted) {
        return emergencyKey;
      }

      throw new Error('[db:key] safeStorage is available but emergency fallback key restoration failed.');
    }
  }

  if (config.encryptedDbMasterKey) {
    try {
      console.log('[db:key] Loading encrypted database master key from secure storage config.');
      const decrypted = safeStorage.decryptString(Buffer.from(config.encryptedDbMasterKey, 'base64'));
      await cleanupEmergencyFallbackDatabaseKey(config);
      return decrypted;
    } catch (error) {
      return resolveWithFallbackAndTrySafeStorageMigration(
        config,
        isDev,
        `Failed to decrypt encryptedDbMasterKey from safeStorage (${error instanceof Error ? error.message : 'unknown error'}).`,
      );
    }
  }

  if (canUseFallbackInCurrentRuntime(config)) {
    console.log('[db:key] safeStorage available without encryptedDbMasterKey. Attempting fallback migration first.');
    return resolveWithFallbackAndTrySafeStorageMigration(config, isDev, 'No encryptedDbMasterKey found in config.');
  }

  if (hasFallbackMetadata(config)) {
    throw new Error(
      '[db:key] safeStorage is available and fallback metadata exists, but COSMOSH_DB_MASTER_PASSWORD is missing. Refusing to generate a new key to avoid database lockout.',
    );
  }

  console.log('[db:key] Generating new database master key and storing encrypted payload in secure storage config.');
  const generatedMasterKey = randomBytes(32).toString('hex');

  const persisted = await persistGeneratedDatabaseKey(config, generatedMasterKey);
  if (persisted) {
    return generatedMasterKey;
  }

  return resolveWithFallbackAndTrySafeStorageMigration(
    config,
    isDev,
    'safeStorage encryption/persistence failed while creating a new database key.',
  );
};

/**
 * Returns the SQLite file path used by backend runtime.
 * Development and packaged modes intentionally use different storage roots.
 */
export const getDatabasePath = (): string => {
  const isDev = !app.isPackaged;

  if (isDev) {
    const profileDatabasePath = process.env.COSMOSH_DB_PATH?.trim();
    if (profileDatabasePath) {
      return profileDatabasePath;
    }

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
  return resolveDatabaseKeyFromConfig(config, isDev);
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
  return resolveDatabaseKeyFromConfig(config, isDev);
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
