/**
 * Transport-level proxy between a local agent (stdio) and the Cosmosh backend.
 *
 * The bridge deliberately operates at the JSON-RPC *transport* layer rather than
 * re-declaring an `McpServer`: every message the agent writes on stdio is
 * forwarded verbatim to the backend `/mcp` Streamable-HTTP endpoint, and every
 * message the backend emits is forwarded back to stdio. This keeps the bridge
 * oblivious to the tool surface — `initialize`, `tools/list`, `tools/call`,
 * notifications, and future methods all pass through unchanged.
 *
 * Before wiring the passthrough, {@link probeBackend} performs a cheap reachability
 * check so the CLI can print an actionable error (app not running / MCP disabled /
 * token invalid) and exit non-zero instead of hanging.
 */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { DiscoveryFile } from './discovery.js';

/** Minimal transport surface the passthrough relies on (both SDK transports satisfy it). */
type MessageTransport = {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
};

/** Outcome of a backend reachability probe. */
export type ProbeResult =
  { status: 'ok' } | { status: 'disabled' } | { status: 'unauthorized' } | { status: 'unreachable'; detail: string };

/** Default probe timeout; the local backend answers a GET immediately. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Builds the loopback `/mcp` endpoint URL for a discovered port.
 *
 * @param port Backend HTTP port from the discovery file.
 * @returns Endpoint URL.
 */
export const buildMcpUrl = (port: number): URL => new URL(`http://127.0.0.1:${port}/mcp`);

/**
 * Normalizes an unknown thrown value into an `Error`.
 *
 * @param value Thrown value.
 * @returns Error instance.
 */
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/**
 * Options for {@link probeBackend}; injectable for testability.
 */
export type ProbeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Checks that the backend `/mcp` endpoint is reachable, enabled, and authorized.
 *
 * Sends an unauthenticated-session `GET` (which the server answers immediately
 * without opening an SSE stream) purely to read the HTTP status: `503` means MCP
 * is disabled, `401` means the pairing token is stale, a network error means the
 * app is not running, and any other status means the endpoint is live.
 *
 * @param file Discovery record with the port and token.
 * @param options Optional fetch/timeout overrides.
 * @returns Probe outcome.
 */
export const probeBackend = async (file: DiscoveryFile, options?: ProbeOptions): Promise<ProbeResult> => {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options?.timeoutMs ?? PROBE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(buildMcpUrl(file.port), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${file.token}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    // Drain the body so the socket does not linger in a keep-alive pool.
    try {
      await response.body?.cancel();
    } catch {
      // Best effort — the process is short-lived on the error paths anyway.
    }

    if (response.status === 503) {
      return { status: 'disabled' };
    }
    if (response.status === 401) {
      return { status: 'unauthorized' };
    }
    return { status: 'ok' };
  } catch (error: unknown) {
    return { status: 'unreachable', detail: asError(error).message };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Options for {@link runBridge}; injectable for testability.
 */
export type RunBridgeOptions = {
  httpTransport?: MessageTransport;
  stdioTransport?: MessageTransport;
};

/**
 * Runs the stdio ↔ Streamable-HTTP passthrough until either side closes.
 *
 * Resolves cleanly when the agent closes stdin (or the backend closes the HTTP
 * session); rejects when a transport reports an error or a forwarded `send`
 * fails. In every case both transports are closed before settling.
 *
 * @param file Discovery record with the port and token.
 * @param options Optional transport overrides for testing.
 * @returns A promise that settles when the bridge stops.
 */
export const runBridge = async (file: DiscoveryFile, options?: RunBridgeOptions): Promise<void> => {
  const httpTransport: MessageTransport =
    options?.httpTransport ??
    new StreamableHTTPClientTransport(buildMcpUrl(file.port), {
      requestInit: {
        headers: {
          authorization: `Bearer ${file.token}`,
        },
      },
    });

  const stdioTransport: MessageTransport = options?.stdioTransport ?? new StdioServerTransport();

  return await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      void Promise.resolve(stdioTransport.close()).catch(() => {});
      void Promise.resolve(httpTransport.close()).catch(() => {});
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    stdioTransport.onmessage = (message) => {
      httpTransport.send(message).catch((error: unknown) => {
        finish(asError(error));
      });
    };
    httpTransport.onmessage = (message) => {
      stdioTransport.send(message).catch((error: unknown) => {
        finish(asError(error));
      });
    };

    // A close on either side ends the bridge; the agent respawns it if needed.
    stdioTransport.onclose = () => {
      finish();
    };
    httpTransport.onclose = () => {
      finish();
    };

    stdioTransport.onerror = (error) => {
      finish(asError(error));
    };
    httpTransport.onerror = (error) => {
      finish(asError(error));
    };

    Promise.all([httpTransport.start(), stdioTransport.start()]).catch((error: unknown) => {
      finish(asError(error));
    });
  });
};
