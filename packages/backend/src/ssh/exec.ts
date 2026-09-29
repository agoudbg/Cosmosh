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
    /** Optional private-source cleanup budget; ordinary telemetry keeps its existing immediate cancellation. */
    cleanupTimeoutMs?: number;
    /** Stops future use of this optional source when SSH cannot confirm bounded channel cleanup. */
    onCleanupTimeout?: () => void;
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
    let execPending = false;
    let cleanupComplete: (() => void) | null = null;

    /** @param stream Owned optional worker. @returns Nothing; cancellation never writes a terminal command. */
    const closeWorker = (stream: ClientChannel): void => {
      if (options?.stdin !== undefined) {
        try {
          stream.signal('TERM');
        } catch {
          /* The private worker also has its own deadline if SSH already closed. */
        }
      }
      try {
        stream.close();
      } catch {
        // Bounded cleanup below contains a broken or already closed transport.
      }
    };

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

      if (closeChannel && options?.cleanupTimeoutMs && (channel || execPending)) {
        /** @returns Nothing; releases the waiter once after close, a failed open, or bounded containment. */
        const complete = (): void => {
          if (cleanupComplete !== complete) return;
          cleanupComplete = null;
          clearTimeout(cleanupTimer);
          channel?.removeListener('close', complete);
          resolve(result);
        };
        const cleanupTimer = setTimeout(
          () => {
            // A later source must not overlap an unconfirmed remote worker. The source owner stays unavailable.
            options.onCleanupTimeout?.();
            try {
              channel?.destroy();
            } catch {
              /* Local cleanup still completes when a transport has already failed. */
            }
            complete();
          },
          Math.max(1, Math.min(5000, options.cleanupTimeoutMs)),
        );
        cleanupComplete = complete;
        if (channel) {
          channel.once('close', complete);
          closeWorker(channel);
        }
        return;
      }
      if (closeChannel && channel) closeWorker(channel);

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
      execPending = true;
      client.exec(command, (error, openedChannel) => {
        execPending = false;
        if (settled) {
          if (openedChannel) {
            channel = openedChannel;
            // A late channel has no normal result listeners; transport errors must stay inside cancellation cleanup.
            channel.on('error', () => {});
            if (cleanupComplete) channel.once('close', cleanupComplete);
            closeWorker(channel);
          } else {
            cleanupComplete?.();
          }
          return;
        }

        if (error) {
          finish(null);
          return;
        }

        channel = openedChannel;
        channel.on('data', (chunk: Buffer | string) => {
          if (settled) return;
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
      execPending = false;
      finish(null);
    }
  });
};
