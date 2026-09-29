import { StringDecoder } from 'node:string_decoder';

import type { ShellEditorRequest, ShellEditorSnapshot, ShellNativeCompletionResult } from '@cosmosh/api-contract';
import type { Client, ClientChannel } from 'ssh2';

import { normalizeNativeCompletionResult } from '../terminal/completion/native-completion.js';
import { EDITOR_MESSAGE_MAX_BYTES, isEditorRecord, normalizeEditorSnapshot } from '../terminal/editor-protocol.js';

/** Request result distinguishes rejection from a lost acknowledgement after an application decision. */
export type ShellEditorResult =
  | { status: 'ok'; snapshot: ShellEditorSnapshot }
  | { status: 'applied' }
  /** Original Fish reader no longer returns the exact text; saving to its history file is unconfirmed. */
  | { status: 'history-removed-from-reader' }
  | { status: 'native-completions'; completion: ShellNativeCompletionResult }
  | { status: 'stale' | 'unavailable' | 'unsupported' | 'unknown' };

/** One transport operation's cancellation, permission and exact context checks. */
export type ShellEditorExecOptions = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  trigger: () => void;
};

/**
 * Runs one request-scoped remote worker. Only a fixed helper path enters the command string;
 * request text stays in stdin and the bounded response stays in memory.
 * @param client Owning SSH connection. @param binaryPath Previously verified installed binary.
 * @param request Complete private request. @param options Live permission/context checks and trigger.
 * @returns Validated editor result; failures never contain server output or user input.
 */
export const executeShellEditorRequest = (
  client: Client,
  binaryPath: string,
  request: ShellEditorRequest,
  options: ShellEditorExecOptions,
): Promise<ShellEditorResult> =>
  new Promise((resolve) => {
    const mutating = request.operation === 'apply' || request.operation === 'history-delete';
    let channel: ClientChannel | null = null;
    let channelClosed = false;
    let settled = false;
    let ready = false;
    let authorized = false;
    let pending = '';
    let totalBytes = 0;
    const decoder = new StringDecoder('utf8');
    /**
     * Sends EOF and allows the remote worker to remove its endpoint before closing SSH.
     * @param stream Request-owned channel. @param complete Cleanup completion callback.
     * @returns Nothing; a broken server cannot retain the channel indefinitely.
     */
    const release = (stream: ClientChannel, complete: () => void): void => {
      let released = false;
      /** @returns Nothing; resolves cleanup once even if close and timeout race. */
      const done = (): void => {
        if (released) return;
        released = true;
        clearTimeout(cleanupTimer);
        stream.removeListener('close', done);
        complete();
      };
      const cleanupTimer = setTimeout(() => {
        try {
          stream.destroy();
        } catch {
          /* Transport loss cannot prevent bounded local cleanup. */
        }
        done();
      }, 1750);
      cleanupTimer.unref();
      stream.once('close', done);
      try {
        stream.end();
      } catch {
        try {
          stream.destroy();
        } catch {
          /* Transport loss cannot prevent bounded local cleanup. */
        }
        done();
      }
    };
    /** @param result Final private result. @returns Nothing; all owned resources are released. */
    const finish = (result: ShellEditorResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (channel && !channelClosed) release(channel, () => resolve(result));
      else resolve(result);
    };
    /** @returns Nothing; a committed but unacknowledged edit must remain explicitly unknown. */
    const abort = (): void => finish({ status: authorized ? 'unknown' : 'unavailable' });
    const timer = setTimeout(abort, 3000);
    options.signal.addEventListener('abort', abort, { once: true });
    if (
      options.signal.aborted ||
      !options.isCurrent() ||
      !binaryPath.startsWith('/') ||
      binaryPath.includes('\u0000') ||
      Buffer.byteLength(binaryPath, 'utf8') > 4096
    ) {
      abort();
      return;
    }
    const command = "'" + binaryPath.replaceAll("'", "'\\''") + "' editor-request";
    try {
      client.exec(command, (error, stream) => {
        if (settled) {
          if (stream) release(stream, () => {});
          return;
        }
        if (error) {
          abort();
          return;
        }
        channel = stream;
        stream.on('error', abort);
        stream.on('close', () => {
          channelClosed = true;
          abort();
        });
        // stderr is never retained: helper failures have fixed result codes on the private stdout protocol.
        stream.stderr.resume();
        stream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > EDITOR_MESSAGE_MAX_BYTES * 2 || settled) {
            abort();
            return;
          }
          pending += decoder.write(chunk);
          let separator = pending.indexOf('\n');
          while (separator >= 0 && !settled) {
            const line = pending.slice(0, separator);
            pending = pending.slice(separator + 1);
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              abort();
              return;
            }
            if (!isEditorRecord(message) || message.type !== 'editor' || message.requestId !== request.requestId) {
              abort();
              return;
            }
            if (message.phase === 'ready' && !ready) {
              if (!options.isCurrent()) {
                abort();
                return;
              }
              ready = true;
              try {
                options.trigger();
                if (settled || options.signal.aborted || !options.isCurrent()) {
                  abort();
                  return;
                }
                if (request.notification) {
                  stream.write(JSON.stringify({ requestId: request.requestId, activate: true }) + '\n');
                }
              } catch {
                abort();
                return;
              }
            } else if (message.phase === 'prepared' && ready && !authorized && mutating) {
              const snapshot = normalizeEditorSnapshot(message.snapshot, request);
              if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(request.expected) || !options.isCurrent()) {
                finish({ status: 'stale' });
                return;
              }
              authorized = true;
              try {
                stream.write(JSON.stringify({ requestId: request.requestId, apply: true }) + '\n');
              } catch {
                abort();
                return;
              }
            } else if (message.phase === 'done') {
              if (
                message.status === 'native-completions' &&
                request.operation === 'native-completion' &&
                ready &&
                options.isCurrent() &&
                !('snapshot' in message) &&
                !('applied' in message)
              ) {
                const completion = normalizeNativeCompletionResult(message.completion);
                finish(completion ? { status: 'native-completions', completion } : { status: 'unavailable' });
              } else if (
                message.status === 'ok' &&
                request.operation !== 'native-completion' &&
                ready &&
                !mutating &&
                options.isCurrent()
              ) {
                const snapshot = normalizeEditorSnapshot(message.snapshot, request);
                finish(snapshot ? { status: 'ok', snapshot } : { status: 'unavailable' });
              } else if (
                message.status === 'history-removed-from-reader' &&
                request.operation === 'history-delete' &&
                authorized &&
                message.applied === true
              ) {
                finish({ status: 'history-removed-from-reader' });
              } else if (
                message.status === 'applied' &&
                request.operation === 'apply' &&
                authorized &&
                message.applied === true
              ) {
                finish({ status: 'applied' });
              } else if (authorized) {
                finish({ status: 'unknown' });
              } else {
                finish({
                  status:
                    message.status === 'stale'
                      ? 'stale'
                      : message.status === 'unsupported'
                        ? 'unsupported'
                        : 'unavailable',
                });
              }
            } else {
              abort();
              return;
            }
            separator = pending.indexOf('\n');
          }
          if (Buffer.byteLength(pending, 'utf8') > EDITOR_MESSAGE_MAX_BYTES) abort();
        });
        try {
          stream.write(JSON.stringify(request) + '\n');
        } catch {
          abort();
        }
      });
    } catch {
      abort();
    }
  });
