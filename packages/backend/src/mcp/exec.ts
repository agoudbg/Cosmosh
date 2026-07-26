/**
 * Bounded SSH command execution for the MCP `run_command` tool.
 *
 * The shared {@link executeBoundedSshCommand} helper only captures stdout, which
 * is insufficient for an agent that needs stderr and exit status to reason about
 * a command. This variant captures stdout, stderr, exit code/signal, truncation,
 * and duration while preserving the same containment discipline (timeout,
 * combined output cap, synchronous/asynchronous error handling).
 */

import type { Client, ClientChannel } from 'ssh2';

import { MCP_DEFAULT_COMMAND_TIMEOUT_MS, MCP_DEFAULT_MAX_OUTPUT_BYTES } from './constants.js';

/**
 * Structured result of one bounded MCP command execution.
 */
export type McpCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: string | null;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

/**
 * Executes one remote command with bounded output, timeout, and cancellation.
 *
 * @param client Connected ssh2 client.
 * @param command Remote command string.
 * @param options Optional timeout, combined output byte cap, and cancellation signal.
 * @returns Structured command result.
 */
export const executeMcpSshCommand = async (
  client: Client,
  command: string,
  options?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  },
): Promise<McpCommandResult> => {
  const timeoutMs = Math.max(1, options?.timeoutMs ?? MCP_DEFAULT_COMMAND_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, options?.maxOutputBytes ?? MCP_DEFAULT_MAX_OUTPUT_BYTES);
  const signal = options?.signal;
  const startedAtMs = Date.now();

  const buildResult = (override: Partial<McpCommandResult>, stdout: string, stderr: string): McpCommandResult => {
    return {
      stdout,
      stderr,
      exitCode: null,
      exitSignal: null,
      truncated: false,
      timedOut: false,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...override,
    };
  };

  if (signal?.aborted) {
    return buildResult({ timedOut: true }, '', '');
  }

  return await new Promise<McpCommandResult>((resolve) => {
    let channel: ClientChannel | null = null;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let truncated = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const finish = (override: Partial<McpCommandResult>, closeChannel = false): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      signal?.removeEventListener('abort', handleAbort);

      if (closeChannel && channel) {
        try {
          channel.close();
        } catch {
          // Ignore channel close races after the result is already determined.
        }
      }

      resolve(buildResult({ truncated, ...override }, stdout, stderr));
    };

    const appendBounded = (target: 'stdout' | 'stderr', data: string): void => {
      if (truncated) {
        return;
      }

      const dataBytes = Buffer.byteLength(data, 'utf8');
      if (outputBytes + dataBytes > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - outputBytes);
        const slice = remaining > 0 ? sliceUtf8Bytes(data, remaining) : '';
        if (target === 'stdout') {
          stdout += slice;
        } else {
          stderr += slice;
        }
        outputBytes = maxOutputBytes;
        truncated = true;
        return;
      }

      outputBytes += dataBytes;
      if (target === 'stdout') {
        stdout += data;
      } else {
        stderr += data;
      }
    };

    const handleAbort = (): void => {
      finish({ timedOut: true }, true);
    };

    timeoutId = setTimeout(() => {
      finish({ timedOut: true }, true);
    }, timeoutMs);
    signal?.addEventListener('abort', handleAbort, { once: true });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    try {
      client.exec(command, (error, openedChannel) => {
        if (settled) {
          try {
            openedChannel?.close();
          } catch {
            // Ignore a late callback after timeout containment.
          }
          return;
        }

        if (error) {
          finish({ stderr: error.message });
          return;
        }

        channel = openedChannel;
        channel.on('data', (chunk: Buffer | string) => {
          appendBounded('stdout', typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          if (truncated) {
            finish({}, true);
          }
        });
        channel.stderr.on('data', (chunk: Buffer | string) => {
          appendBounded('stderr', typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          if (truncated) {
            finish({}, true);
          }
        });
        channel.once('exit', (code: number | null, signalName?: string | null) => {
          exitCode = typeof code === 'number' ? code : null;
          exitSignal = signalName ?? null;
        });
        channel.once('error', (channelError: Error) => {
          finish({ stderr: stderr.length > 0 ? stderr : channelError.message }, true);
        });
        channel.once('close', () => {
          finish({ exitCode, exitSignal });
        });
      });
    } catch (error: unknown) {
      finish({ stderr: error instanceof Error ? error.message : 'SSH command execution failed.' });
    }
  });
};

/**
 * Slices a UTF-8 string to at most `maxBytes` bytes without splitting a code point.
 *
 * @param value Source string.
 * @param maxBytes Maximum byte budget for the returned slice.
 * @returns Truncated string within the byte budget.
 */
const sliceUtf8Bytes = (value: string, maxBytes: number): string => {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  // Avoid slicing in the middle of a multi-byte sequence (continuation bytes are 0b10xxxxxx).
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  return buffer.subarray(0, end).toString('utf8');
};
