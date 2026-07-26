/**
 * `cosmosh-mcp` — the stdio bridge CLI shipped inside Cosmosh.
 *
 * External agents (Claude Code / Desktop, Cursor, …) spawn this executable and
 * speak MCP over stdio. The bridge locates the running Cosmosh backend via the
 * discovery file, verifies it is reachable and authorized, then transparently
 * proxies the session to the backend `/mcp` endpoint.
 *
 * All diagnostics are written to **stderr**; stdout carries only the JSON-RPC
 * stream. Any failure prints a single actionable line and exits non-zero so the
 * host agent surfaces a useful message instead of a silent hang.
 */

import { BridgeDiscoveryError, type DiscoveryFile, loadDiscovery } from './discovery.js';
import { probeBackend, type ProbeResult, runBridge } from './proxy.js';

/** Bridge protocol/tooling version, surfaced by `--version`. */
const BRIDGE_VERSION = '0.1.0';

const HELP_TEXT = `cosmosh-mcp — Cosmosh MCP stdio bridge

Usage:
  cosmosh-mcp [--discovery <path>]

Options:
  --discovery <path>   Path to the Cosmosh MCP discovery file (bridge.json).
                       Defaults to $COSMOSH_MCP_DISCOVERY, then the platform
                       userData location for a packaged install.
  -h, --help           Show this help.
  -v, --version        Print the bridge version.

The bridge reads {port, token} from the discovery file and proxies a local
stdio MCP session to the running Cosmosh app's /mcp endpoint. Cosmosh must be
running with Settings -> MCP enabled.`;

/** Prefix for every user-facing diagnostic line. */
const LOG_PREFIX = 'Cosmosh MCP:';

/**
 * Writes a single diagnostic line to stderr.
 *
 * @param message Message body.
 */
const logError = (message: string): void => {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
};

/**
 * Maps a discovery failure to an actionable, single-line message.
 *
 * @param error Discovery error.
 * @returns Human-readable guidance.
 */
const describeDiscoveryError = (error: BridgeDiscoveryError): string => {
  switch (error.code) {
    case 'not-found':
      return `Cosmosh is not running, or MCP is disabled. Start Cosmosh, enable Settings -> MCP, then retry. (looked for ${error.discoveryPath})`;
    case 'unreadable':
      return `Cannot read the discovery file at ${error.discoveryPath}. ${error.message}`;
    case 'unsupported-version':
      return error.message;
    case 'invalid':
    default:
      return `The discovery file at ${error.discoveryPath} is invalid. ${error.message}`;
  }
};

/**
 * Maps a non-OK probe result to an actionable, single-line message.
 *
 * @param result Probe result (never `ok`).
 * @returns Human-readable guidance.
 */
const describeProbeFailure = (result: Exclude<ProbeResult, { status: 'ok' }>): string => {
  switch (result.status) {
    case 'disabled':
      return 'Cosmosh is running but MCP is disabled. Enable Settings -> MCP, then retry.';
    case 'unauthorized':
      return 'The pairing token is no longer valid. Open Settings -> MCP in Cosmosh to rotate the token and update your client config.';
    case 'unreachable':
    default:
      return `Cannot reach the Cosmosh backend. Is Cosmosh running? (${result.detail})`;
  }
};

/**
 * Resolves the discovery file, probing once and re-reading on a transient miss.
 *
 * A network-unreachable probe can mean the app restarted onto a new port after
 * the discovery file was first read, so the file is re-read once and re-probed.
 *
 * @returns The connectable discovery record.
 * @throws {BridgeDiscoveryError} When discovery cannot be loaded.
 * @throws {Error} When the backend is disabled, unauthorized, or unreachable.
 */
const resolveConnectableDiscovery = async (): Promise<DiscoveryFile> => {
  let { file } = await loadDiscovery();
  let probe = await probeBackend(file);

  if (probe.status === 'unreachable') {
    // The app may have restarted onto a new port; re-read discovery once.
    try {
      ({ file } = await loadDiscovery());
    } catch {
      // Keep the original probe failure if the re-read now fails outright.
      throw new Error(describeProbeFailure(probe));
    }
    probe = await probeBackend(file);
  }

  if (probe.status !== 'ok') {
    throw new Error(describeProbeFailure(probe));
  }

  return file;
};

/**
 * CLI entrypoint.
 *
 * @returns Process exit code.
 */
const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);

  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`${BRIDGE_VERSION}\n`);
    return 0;
  }

  let file: DiscoveryFile;
  try {
    file = await resolveConnectableDiscovery();
  } catch (error: unknown) {
    if (error instanceof BridgeDiscoveryError) {
      logError(describeDiscoveryError(error));
    } else {
      logError(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }

  try {
    await runBridge(file);
  } catch (error: unknown) {
    logError(`Bridge session ended with an error. ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    logError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
