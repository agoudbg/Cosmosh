/**
 * Discovery-file resolution and parsing for the Cosmosh MCP stdio bridge.
 *
 * The bridge learns how to reach the running Cosmosh backend by reading a small
 * JSON discovery file the app writes while MCP is enabled. Because the backend
 * port and pairing token change on every launch, this file is the single source
 * of truth for `{port, token}`; it is re-read on every bridge start (and once
 * more on a connection retry) rather than cached across runs.
 *
 * Lookup order (highest priority first):
 *   1. `--discovery <path>` / `--discovery=<path>` CLI argument
 *   2. `COSMOSH_MCP_DISCOVERY` environment variable
 *   3. Platform-default userData location for a packaged install
 *
 * This module is intentionally free of any MCP-SDK or network dependency so it
 * can be unit-tested in isolation.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Discovery file name written under `<userData>/mcp/`. Mirrors the backend. */
export const DISCOVERY_FILE_NAME = 'bridge.json';

/** Discovery schema version this bridge understands. */
export const SUPPORTED_DISCOVERY_VERSION = 1;

/** Electron `productName`; userData resolves to `<appData>/<APP_NAME>`. */
const APP_NAME = 'Cosmosh';

/**
 * Parsed and validated discovery-file contents.
 *
 * Only `version`, `port`, and `token` are required to connect; the remaining
 * fields are advisory metadata written by the backend.
 */
export type DiscoveryFile = {
  version: number;
  port: number;
  token: string;
  pid?: number;
  appVersion?: string;
  startedAt?: string;
};

/** Machine-readable reason a discovery load failed. */
export type DiscoveryErrorCode = 'not-found' | 'unreadable' | 'invalid' | 'unsupported-version';

/**
 * Error raised when the discovery file cannot be located, read, or parsed.
 */
export class BridgeDiscoveryError extends Error {
  public readonly code: DiscoveryErrorCode;

  public readonly discoveryPath: string;

  public constructor(code: DiscoveryErrorCode, discoveryPath: string, message: string) {
    super(message);
    this.name = 'BridgeDiscoveryError';
    this.code = code;
    this.discoveryPath = discoveryPath;
  }
}

/**
 * Inputs for resolving the discovery-file path. Injectable for testability.
 */
export type DiscoveryPathOptions = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
};

/**
 * Extracts a `--discovery` path from CLI arguments.
 *
 * Accepts both `--discovery <path>` and `--discovery=<path>` forms.
 *
 * @param argv Argument vector (excluding the node executable and script path).
 * @returns The provided path, or undefined when the flag is absent.
 */
const readDiscoveryArg = (argv: readonly string[]): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--discovery') {
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        return value;
      }
      return undefined;
    }
    if (arg.startsWith('--discovery=')) {
      const value = arg.slice('--discovery='.length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
};

/**
 * Computes the platform-default discovery path for a packaged install.
 *
 * Matches Electron's `app.getPath('userData')` (`<appData>/Cosmosh`) plus the
 * backend's `mcp/` subdirectory. Development installs use a workspace-relative
 * data directory, so dev users must pass `--discovery`/`COSMOSH_MCP_DISCOVERY`.
 *
 * @param options Platform, environment, and home directory.
 * @returns Absolute default discovery-file path.
 */
export const defaultDiscoveryPath = (options: Omit<DiscoveryPathOptions, 'argv'>): string => {
  const { env, platform, homedir } = options;

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, APP_NAME, 'mcp', DISCOVERY_FILE_NAME);
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', APP_NAME, 'mcp', DISCOVERY_FILE_NAME);
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir, '.config');
  return path.join(configHome, APP_NAME, 'mcp', DISCOVERY_FILE_NAME);
};

/**
 * Resolves the discovery-file path from the lookup order.
 *
 * @param options CLI args, environment, platform, and home directory.
 * @returns Absolute discovery-file path.
 */
export const resolveDiscoveryPath = (options: DiscoveryPathOptions): string => {
  const fromArg = readDiscoveryArg(options.argv);
  if (fromArg) {
    return path.resolve(fromArg);
  }

  const fromEnv = options.env.COSMOSH_MCP_DISCOVERY?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return defaultDiscoveryPath(options);
};

/**
 * Parses and validates raw discovery-file JSON.
 *
 * @param raw Discovery-file contents.
 * @param discoveryPath Path used for error reporting.
 * @returns Validated discovery record.
 * @throws {BridgeDiscoveryError} On malformed JSON, missing fields, or an
 *   unsupported schema version.
 */
export const parseDiscoveryFile = (raw: string, discoveryPath: string): DiscoveryFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeDiscoveryError('invalid', discoveryPath, 'Discovery file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new BridgeDiscoveryError('invalid', discoveryPath, 'Discovery file must contain a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const { version, port, token } = record;

  if (typeof version !== 'number') {
    throw new BridgeDiscoveryError('invalid', discoveryPath, 'Discovery file is missing a numeric "version".');
  }

  if (version !== SUPPORTED_DISCOVERY_VERSION) {
    throw new BridgeDiscoveryError(
      'unsupported-version',
      discoveryPath,
      `Discovery file version ${version} is not supported (expected ${SUPPORTED_DISCOVERY_VERSION}). Update Cosmosh or the bridge.`,
    );
  }

  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new BridgeDiscoveryError('invalid', discoveryPath, 'Discovery file has an invalid "port".');
  }

  if (typeof token !== 'string' || token.length === 0) {
    throw new BridgeDiscoveryError('invalid', discoveryPath, 'Discovery file has an invalid "token".');
  }

  return {
    version,
    port,
    token,
    pid: typeof record.pid === 'number' ? record.pid : undefined,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : undefined,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
  };
};

/**
 * Reads and validates the discovery file at the given path.
 *
 * @param discoveryPath Absolute discovery-file path.
 * @returns Validated discovery record.
 * @throws {BridgeDiscoveryError} When the file is absent, unreadable, or invalid.
 */
export const readDiscoveryFile = async (discoveryPath: string): Promise<DiscoveryFile> => {
  let raw: string;
  try {
    raw = await readFile(discoveryPath, 'utf8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new BridgeDiscoveryError(
        'not-found',
        discoveryPath,
        'Discovery file not found. Cosmosh is not running, or MCP is disabled.',
      );
    }
    throw new BridgeDiscoveryError(
      'unreadable',
      discoveryPath,
      `Discovery file could not be read (${code ?? 'unknown error'}).`,
    );
  }

  return parseDiscoveryFile(raw, discoveryPath);
};

/**
 * Resolves and loads the discovery file in one step.
 *
 * @param options Optional overrides; defaults come from the live process.
 * @returns The resolved path and its validated contents.
 * @throws {BridgeDiscoveryError} When the file cannot be loaded.
 */
export const loadDiscovery = async (
  options?: Partial<DiscoveryPathOptions>,
): Promise<{ discoveryPath: string; file: DiscoveryFile }> => {
  const resolved = resolveDiscoveryPath({
    argv: options?.argv ?? process.argv.slice(2),
    env: options?.env ?? process.env,
    platform: options?.platform ?? process.platform,
    homedir: options?.homedir ?? os.homedir(),
  });

  const file = await readDiscoveryFile(resolved);
  return { discoveryPath: resolved, file };
};
