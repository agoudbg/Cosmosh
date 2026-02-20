import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app, safeStorage } from 'electron';

type DatabaseSecurityConfig = {
  encryptedDbMasterKey?: string;
  masterPasswordHash?: string;
  masterPasswordSalt?: string;
};

const DATABASE_FILE_NAME = 'cosmosh.db';
const DEV_MASTER_KEY = 'cosmosh_dev_key';
const CONFIG_FILE_NAME = 'security.config.json';

const getProjectRootFromAppPath = (): string => {
  return path.resolve(app.getAppPath(), '../../..');
};

const getSecurityConfigPath = (): string => {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
};

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
  } catch {
    return {};
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

const deriveMasterPasswordHash = (password: string, salt: string): string => {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
};

const deriveDatabaseKeyFromMasterPassword = (password: string, salt: string): string => {
  return scryptSync(password, salt, 32).toString('hex');
};

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

export const getDatabasePath = (): string => {
  const isDev = !app.isPackaged;

  if (isDev) {
    return path.join(getProjectRootFromAppPath(), '.dev_data', DATABASE_FILE_NAME);
  }

  return path.join(app.getPath('userData'), DATABASE_FILE_NAME);
};

export const toPrismaSqliteUrl = (databasePath: string): string => {
  const normalizedPath = databasePath.split(path.sep).join('/');
  return `file:${encodeURI(normalizedPath)}`;
};

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
