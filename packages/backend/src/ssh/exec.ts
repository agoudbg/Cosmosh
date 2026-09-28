import { StringDecoder } from 'node:string_decoder';

import type { Client, ClientChannel } from 'ssh2';

export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 15_000;
export const DEFAULT_SSH_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Executes a bounded background SSH command.
 *
 * The helper contains callback stalls, synchronous ssh2 errors, channel errors,
 * and excessive stdout so periodic telemetry/history jobs cannot accumulate
 * unbounded resources.
 *
 * @param client Connected ssh2 client.
 * @param command Remote command string.
 * @param options Optional timeout, stdout byte limits, cancellation signal and private stdin payload.
 * @returns UTF-8 stdout on success, otherwise null.
 */
export const executeBoundedSshCommand = async (
  client: Client,
  command: string,
  options?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    stdin?: string;
  },
): Promise<string | null> => {
  const timeoutMs = Math.max(1, options?.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, options?.maxOutputBytes ?? DEFAULT_SSH_EXEC_MAX_OUTPUT_BYTES);
  const signal = options?.signal;

  if (signal?.aborted) {
    return null;
  }

  return await new Promise<string | null>((resolve) => {
    let channel: ClientChannel | null = null;
    let output = '';
    const decoder = new StringDecoder('utf8');
    let outputBytes = 0;
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const finish = (result: string | null, closeChannel = false): void => {
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
        if (options?.stdin !== undefined) {
          try {
            channel.signal('TERM');
          } catch {
            /* The private worker also has its own deadline if SSH already closed. */
          }
        }
        try {
          channel.close();
        } catch {
          // Ignore channel close races after the result is already determined.
        }
      }

      resolve(result);
    };

    const handleAbort = (): void => {
      finish(null, true);
    };

    timeoutId = setTimeout(() => {
      finish(null, true);
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
          finish(null);
          return;
        }

        channel = openedChannel;
        channel.on('data', (chunk: Buffer | string) => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          outputBytes += bytes.length;
          if (outputBytes > maxOutputBytes) {
            finish(null, true);
            return;
          }

          output += decoder.write(bytes);
        });
        channel.once('error', () => {
          finish(null, true);
        });
        channel.once('close', () => {
          finish(output + decoder.end());
        });
        try {
          if (options?.stdin !== undefined) channel.end(options.stdin, 'utf8');
        } catch {
          // ssh2 callbacks are asynchronous; outer client.exec containment cannot catch a failed stdin write.
          finish(null, true);
        }
      });
    } catch {
      finish(null);
    }
  });
};
