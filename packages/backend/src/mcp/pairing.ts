/**
 * MCP pairing token lifecycle and discovery file management.
 *
 * The stdio bridge authenticates to the local `/mcp` endpoint with a Bearer
 * pairing token. Because the backend port changes on every launch, the token is
 * stored encrypted (AES-256-GCM, same envelope as SSH credentials) and the
 * plaintext is written into a discovery file the bridge reads. Only one token
 * row is active at a time; rotation revokes the previous row.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { decryptSensitiveValue, encryptSensitiveValue } from '../ssh/crypto.js';
import { MCP_DISCOVERY_FILE_NAME, MCP_DISCOVERY_FILE_VERSION } from './constants.js';

type GetDbClient = () => PrismaClient;

/**
 * Resolved active pairing token with its plaintext value.
 */
export type McpActivePairingToken = {
  id: string;
  plaintext: string;
  createdAt: Date;
};

/**
 * Shape written to `<userData>/mcp/bridge.json` for the stdio bridge.
 */
export type McpDiscoveryFileContent = {
  version: number;
  port: number;
  token: string;
  pid: number;
  appVersion: string;
  startedAt: string;
};

const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Manages the encrypted pairing token and the on-disk discovery file.
 */
export class McpPairingService {
  private readonly getDbClient: GetDbClient;

  private readonly credentialEncryptionKey: Buffer;

  private readonly discoveryDirPath: string;

  private readonly appVersion: string;

  private cachedToken: McpActivePairingToken | null = null;

  private lastUsedFlushedAtMs = 0;

  public constructor(options: {
    getDbClient: GetDbClient;
    credentialEncryptionKey: Buffer;
    discoveryDirPath: string;
    appVersion: string;
  }) {
    this.getDbClient = options.getDbClient;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.discoveryDirPath = options.discoveryDirPath;
    this.appVersion = options.appVersion;
  }

  /**
   * Absolute discovery file path advertised in status responses.
   *
   * @returns Discovery file path.
   */
  public getDiscoveryFilePath(): string {
    return path.join(this.discoveryDirPath, MCP_DISCOVERY_FILE_NAME);
  }

  /**
   * Loads the current active token, decrypting and caching it.
   *
   * @returns Active token, or null when none exists.
   */
  public async loadActiveToken(): Promise<McpActivePairingToken | null> {
    if (this.cachedToken) {
      return this.cachedToken;
    }

    const row = await this.getDbClient().mcpPairingToken.findFirst({
      where: {
        revokedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!row) {
      return null;
    }

    let plaintext: string;
    try {
      plaintext = decryptSensitiveValue(row.tokenEncrypted, this.credentialEncryptionKey);
    } catch {
      // A token that cannot be decrypted (e.g. key rotation) is treated as absent.
      return null;
    }

    this.cachedToken = {
      id: row.id,
      plaintext,
      createdAt: row.createdAt,
    };
    return this.cachedToken;
  }

  /**
   * Returns the active token, generating one when none exists yet.
   *
   * @returns Active pairing token.
   */
  public async ensureToken(): Promise<McpActivePairingToken> {
    const existing = await this.loadActiveToken();
    if (existing) {
      return existing;
    }

    return await this.rotateToken();
  }

  /**
   * Whether an active pairing token currently exists.
   *
   * @returns True when a token is configured.
   */
  public async hasToken(): Promise<boolean> {
    return (await this.loadActiveToken()) !== null;
  }

  /**
   * Revokes any active token and issues a new one.
   *
   * @returns Newly issued pairing token.
   */
  public async rotateToken(): Promise<McpActivePairingToken> {
    const db = this.getDbClient();
    const plaintext = generatePairingTokenValue();
    const tokenEncrypted = encryptSensitiveValue(plaintext, this.credentialEncryptionKey);

    const created = await db.$transaction(async (tx) => {
      await tx.mcpPairingToken.updateMany({
        where: {
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      return await tx.mcpPairingToken.create({
        data: {
          tokenEncrypted,
        },
      });
    });

    this.cachedToken = {
      id: created.id,
      plaintext,
      createdAt: created.createdAt,
    };
    this.lastUsedFlushedAtMs = 0;
    return this.cachedToken;
  }

  /**
   * Revokes every active token and clears the in-memory cache.
   */
  public async revokeToken(): Promise<void> {
    await this.getDbClient().mcpPairingToken.updateMany({
      where: {
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    this.cachedToken = null;
  }

  /**
   * Validates a Bearer token against the active token in constant time.
   *
   * @param providedToken Token presented by the bridge.
   * @returns True when the token matches the active pairing token.
   */
  public async validateBearer(providedToken: string | undefined): Promise<boolean> {
    if (!providedToken) {
      return false;
    }

    const active = await this.loadActiveToken();
    if (!active) {
      return false;
    }

    const providedBuffer = Buffer.from(providedToken);
    const expectedBuffer = Buffer.from(active.plaintext);
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
      return false;
    }

    void this.touchLastUsed(active.id);
    return true;
  }

  /**
   * Writes the discovery file with 0700 dir / 0600 file permissions.
   *
   * @param port Backend HTTP port hosting the `/mcp` endpoint.
   */
  public async writeDiscoveryFile(port: number): Promise<void> {
    const token = await this.ensureToken();
    const content: McpDiscoveryFileContent = {
      version: MCP_DISCOVERY_FILE_VERSION,
      port,
      token: token.plaintext,
      pid: process.pid,
      appVersion: this.appVersion,
      startedAt: new Date().toISOString(),
    };

    await mkdir(this.discoveryDirPath, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.discoveryDirPath, 0o700);
    } catch {
      // Best-effort on platforms where POSIX modes are not enforced (win32 relies on user ACLs).
    }

    const filePath = this.getDiscoveryFilePath();
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Best-effort; see note above.
    }
  }

  /**
   * Removes the discovery file if present.
   */
  public async removeDiscoveryFile(): Promise<void> {
    await rm(this.getDiscoveryFilePath(), { force: true });
  }

  /**
   * Throttled persistence of the token's last-used timestamp.
   *
   * @param tokenId Active token id.
   */
  private async touchLastUsed(tokenId: string): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastUsedFlushedAtMs < LAST_USED_THROTTLE_MS) {
      return;
    }

    this.lastUsedFlushedAtMs = nowMs;
    try {
      await this.getDbClient().mcpPairingToken.update({
        where: {
          id: tokenId,
        },
        data: {
          lastUsedAt: new Date(nowMs),
        },
      });
    } catch (error: unknown) {
      console.error('[mcp][pairing] Failed to persist token last-used timestamp.', error);
    }
  }
}

/**
 * Generates a URL-safe, high-entropy pairing token value.
 *
 * @returns 43-character base64url token (256 bits of entropy).
 */
const generatePairingTokenValue = (): string => {
  // 32 bytes -> 256 bits; base64url without padding is filesystem/header safe.
  return randomBytes(32).toString('base64url');
};
