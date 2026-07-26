/**
 * Writes the `cosmosh-mcp` stdio-bridge launcher scripts into `<userData>/bin/`.
 *
 * External MCP clients (Claude Code / Desktop, Cursor, …) launch the bridge by
 * absolute path. Rather than have every client repeat the
 * `ELECTRON_RUN_AS_NODE=1 "<app exe>" "<bundled cjs>"` incantation, the app
 * writes a small platform-appropriate wrapper the user can point their client at:
 *
 *   - Windows: `cosmosh-mcp.cmd`
 *   - macOS / Linux: `cosmosh-mcp` (chmod 0755)
 *
 * The wrapper runs the bundled bridge under the Electron binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`), pinning the discovery-file path so the bridge finds
 * the running app regardless of the client's environment. The resolved launcher
 * path is surfaced to the renderer (and used to build client-config snippets).
 *
 * Launchers are only meaningful for a packaged install; in development there is
 * no bundled bridge, so {@link ensureMcpBridgeLauncher} is a no-op that returns
 * null and the MCP panel falls back to raw-command guidance.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Launcher base name (no extension); Windows appends `.cmd`. */
const MCP_BRIDGE_LAUNCHER_BASENAME = 'cosmosh-mcp';

/** Bundled bridge entry, relative to `process.resourcesPath`. */
const PACKAGED_BRIDGE_ENTRY_RELATIVE = path.join('helpers', 'mcp-bridge', 'cosmosh-mcp.cjs');

/**
 * Inputs needed to resolve and write the launcher.
 */
export type McpBridgeLauncherContext = {
  /** Whether the app is running from a packaged build. */
  isPackaged: boolean;
  /** Platform to target (injectable for testing). */
  platform: NodeJS.Platform;
  /** Absolute path to the Electron executable (`app.getPath('exe')`). */
  executablePath: string;
  /** Packaged resources root (`process.resourcesPath`). */
  resourcesPath: string;
  /** User data directory (`app.getPath('userData')`). */
  userDataPath: string;
};

/**
 * Absolute path to the launcher script for the target platform.
 *
 * @param context Launcher context.
 * @returns Launcher path under `<userData>/bin/`.
 */
export const resolveMcpBridgeLauncherPath = (
  context: Pick<McpBridgeLauncherContext, 'platform' | 'userDataPath'>,
): string => {
  const fileName = context.platform === 'win32' ? `${MCP_BRIDGE_LAUNCHER_BASENAME}.cmd` : MCP_BRIDGE_LAUNCHER_BASENAME;
  return path.join(context.userDataPath, 'bin', fileName);
};

/**
 * Absolute path to the discovery file the bridge should read.
 *
 * Mirrors the backend's `<userData>/mcp/bridge.json` resolution.
 *
 * @param userDataPath User data directory.
 * @returns Discovery-file path.
 */
export const resolveMcpDiscoveryPath = (userDataPath: string): string => {
  return path.join(userDataPath, 'mcp', 'bridge.json');
};

/**
 * Quotes a value for safe interpolation inside a POSIX single-quoted string.
 *
 * @param value Raw value.
 * @returns Single-quoted, escaped value.
 */
const quoteForPosixShell = (value: string): string => {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
};

/**
 * Builds the Windows `.cmd` launcher body.
 *
 * @param executablePath Electron executable path.
 * @param bridgeEntryPath Bundled bridge entry path.
 * @param discoveryPath Discovery-file path.
 * @returns Script contents.
 */
const buildWindowsLauncher = (executablePath: string, bridgeEntryPath: string, discoveryPath: string): string => {
  return [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${executablePath}" "${bridgeEntryPath}" --discovery "${discoveryPath}" %*`,
    '',
  ].join('\r\n');
};

/**
 * Builds the POSIX launcher body.
 *
 * @param executablePath Electron executable path.
 * @param bridgeEntryPath Bundled bridge entry path.
 * @param discoveryPath Discovery-file path.
 * @returns Script contents.
 */
const buildPosixLauncher = (executablePath: string, bridgeEntryPath: string, discoveryPath: string): string => {
  return [
    '#!/bin/sh',
    'set -eu',
    `ELECTRON_RUN_AS_NODE=1 exec ${quoteForPosixShell(executablePath)} ${quoteForPosixShell(bridgeEntryPath)} --discovery ${quoteForPosixShell(discoveryPath)} "$@"`,
    '',
  ].join('\n');
};

/**
 * Writes the platform launcher script for the packaged bridge.
 *
 * @param context Launcher context.
 * @returns Absolute launcher path on success, or null when not applicable
 *   (development builds) or when writing failed.
 */
export const ensureMcpBridgeLauncher = async (context: McpBridgeLauncherContext): Promise<string | null> => {
  if (!context.isPackaged) {
    // No bundled bridge exists in development; the MCP panel guides raw-command setup instead.
    return null;
  }

  const launcherPath = resolveMcpBridgeLauncherPath(context);
  const bridgeEntryPath = path.join(context.resourcesPath, PACKAGED_BRIDGE_ENTRY_RELATIVE);
  const discoveryPath = resolveMcpDiscoveryPath(context.userDataPath);

  const contents =
    context.platform === 'win32'
      ? buildWindowsLauncher(context.executablePath, bridgeEntryPath, discoveryPath)
      : buildPosixLauncher(context.executablePath, bridgeEntryPath, discoveryPath);

  try {
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(launcherPath, contents, {
      encoding: 'utf8',
      mode: context.platform === 'win32' ? undefined : 0o755,
    });
    if (context.platform !== 'win32') {
      await fs.chmod(launcherPath, 0o755);
    }
  } catch (error) {
    console.warn('Failed to write cosmosh-mcp bridge launcher script.', error);
    return null;
  }

  return launcherPath;
};
