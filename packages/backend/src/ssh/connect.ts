import type { Prisma, PrismaClient } from '@prisma/client';
import { Client, type ConnectConfig } from 'ssh2';

import type { I18nInstance } from '../i18n-bridge.js';
import { buildSshCompressionAlgorithms } from './compression.js';
import { decryptSensitiveValue } from './crypto.js';
import {
  type PreparedSshProxyTransport,
  prepareSshProxyTransport,
  SshProxyConnectionError,
  type SshProxyMetadata,
} from './proxy.js';

export type SshServerWithKeychain = Prisma.SshServerGetPayload<{
  include: {
    keychain: true;
  };
}>;

export type OpenSshClientResult =
  | {
      type: 'ready';
      client: Client;
      loginPassword: string | null;
      lifecycleMonitor: SshClientLifecycleMonitor;
      proxyMetadata: SshProxyMetadata;
    }
  | {
      type: 'host-untrusted';
      fingerprint: string;
      message: string;
      proxyMetadata?: SshProxyMetadata;
    }
  | {
      type: 'failed';
      message: string;
      proxyMetadata?: SshProxyMetadata;
    };

/**
 * Guards the handoff window between connection establishment and consumer lifecycle listeners.
 */
export type SshClientLifecycleMonitor = {
  /** @returns First client error observed during the handoff window. */
  readError(): Error | null;
  /** @returns Whether the SSH client closed during the handoff window. */
  isClosed(): boolean;
  /** Removes monitor listeners after the consumer has installed its own listeners. */
  release(): void;
  /** Keeps the monitor as a teardown guard until the SSH client closes. */
  releaseAfterClose(): void;
};

/**
 * Records client error/close events until a consumer claims lifecycle ownership.
 *
 * @param client New SSH client whose connection lifecycle is about to begin.
 * @returns Monitor that prevents unhandled EventEmitter errors during async handoff work.
 */
const createSshClientLifecycleMonitor = (client: Client): SshClientLifecycleMonitor => {
  let firstError: Error | null = null;
  let closed = false;
  let releaseRequestedAfterClose = false;
  let released = false;

  function handleError(error: Error): void {
    firstError ??= error;
  }

  function releaseMonitor(): void {
    if (released) {
      return;
    }

    released = true;
    client.off('error', handleError);
    client.off('close', handleClose);
  }

  function handleClose(): void {
    closed = true;
    if (releaseRequestedAfterClose) {
      releaseMonitor();
    }
  }

  client.on('error', handleError);
  client.on('close', handleClose);

  return {
    readError: () => firstError,
    isClosed: () => closed,
    release: releaseMonitor,
    releaseAfterClose: () => {
      releaseRequestedAfterClose = true;
      if (closed) {
        releaseMonitor();
      }
    },
  };
};

/**
 * Normalizes an AbortSignal reason into a stable Error instance.
 *
 * @param signal Signal that cancelled an SSH connection attempt.
 * @returns Cancellation error suitable for connection result messages.
 */
const readSshConnectionAbortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('SSH connection cancelled.');
};

/**
 * Stops awaiting proxy preparation when a caller-owned deadline expires.
 *
 * Proxy candidate internals remain bounded by their existing connection timeout.
 * If a preconnected socket arrives after cancellation, it is destroyed immediately
 * so a timed-out bootstrap attempt cannot leave a usable transport behind.
 *
 * @param operation In-flight proxy preparation.
 * @param signal Optional caller cancellation signal.
 * @returns Prepared proxy transport when it completes before cancellation.
 */
const awaitProxyTransportWithAbort = async (
  operation: Promise<PreparedSshProxyTransport>,
  signal?: AbortSignal,
): Promise<PreparedSshProxyTransport> => {
  if (!signal) {
    return await operation;
  }

  if (signal.aborted) {
    throw readSshConnectionAbortError(signal);
  }

  return await new Promise<PreparedSshProxyTransport>((resolve, reject) => {
    let settled = false;

    const handleAbort = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(readSshConnectionAbortError(signal));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (transport) => {
        signal.removeEventListener('abort', handleAbort);
        if (signal.aborted || settled) {
          transport.socket?.destroy();
          if (!settled) {
            settled = true;
            reject(readSshConnectionAbortError(signal));
          }
          return;
        }

        settled = true;
        resolve(transport);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      },
    );
  });
};

/**
 * Opens one authenticated ssh2 client for shell or non-shell SSH consumers.
 *
 * @param server SSH server record with resolved keychain material.
 * @param options Connection policy and localization dependencies.
 * @returns Ready ssh2 client or a normalized failure branch.
 */
export const openSshClient = async (
  server: SshServerWithKeychain,
  options: {
    connectTimeoutSec: number;
    db: PrismaClient;
    enableSshCompression?: boolean;
    signal?: AbortSignal;
    systemProxyRules?: string;
    strictHostKey: boolean;
    trustedFingerprintSet: ReadonlySet<string>;
    credentialEncryptionKey: Buffer;
    t: I18nInstance['t'];
  },
): Promise<OpenSshClientResult> => {
  if (options.signal?.aborted) {
    return {
      type: 'failed',
      message: readSshConnectionAbortError(options.signal).message,
    };
  }

  const client = new Client();
  let presentedFingerprint = '';

  const connectConfig: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: options.connectTimeoutSec * 1000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    algorithms: {
      compress: buildSshCompressionAlgorithms(options.enableSshCompression ?? server.enableSshCompression),
    },
    hostHash: 'sha256',
    hostVerifier: (hashedKey: string) => {
      presentedFingerprint = hashedKey;
      return !options.strictHostKey || options.trustedFingerprintSet.has(hashedKey);
    },
  };

  let loginPassword: string | null = null;

  try {
    if (server.keychain.authType === 'password' || server.keychain.authType === 'both') {
      if (!server.keychain.passwordEncrypted) {
        return {
          type: 'failed',
          message: options.t('errors.ssh.passwordNotConfigured'),
        };
      }

      connectConfig.password = decryptSensitiveValue(
        server.keychain.passwordEncrypted,
        options.credentialEncryptionKey,
      );
      loginPassword = typeof connectConfig.password === 'string' ? connectConfig.password : null;
    }

    if (server.keychain.authType === 'key' || server.keychain.authType === 'both') {
      if (!server.keychain.privateKeyEncrypted) {
        return {
          type: 'failed',
          message: options.t('errors.ssh.privateKeyNotConfigured'),
        };
      }

      connectConfig.privateKey = decryptSensitiveValue(
        server.keychain.privateKeyEncrypted,
        options.credentialEncryptionKey,
      );

      if (server.keychain.privateKeyPassphraseEncrypted) {
        connectConfig.passphrase = decryptSensitiveValue(
          server.keychain.privateKeyPassphraseEncrypted,
          options.credentialEncryptionKey,
        );
      }
    }
  } catch {
    return {
      type: 'failed',
      message: options.t('errors.ssh.decryptCredentialsFailed'),
    };
  }

  let proxyTransport;
  try {
    proxyTransport = await awaitProxyTransportWithAbort(
      prepareSshProxyTransport(options.db, server, options.systemProxyRules, options.connectTimeoutSec * 1000),
      options.signal,
    );
  } catch (error: unknown) {
    return {
      type: 'failed',
      message: error instanceof Error ? error.message : 'Proxy connection failed.',
      proxyMetadata: error instanceof SshProxyConnectionError ? error.metadata : undefined,
    };
  }

  connectConfig.readyTimeout = proxyTransport.readyTimeoutMs;
  if (proxyTransport.socket) {
    connectConfig.sock = proxyTransport.socket;
  }

  const lifecycleMonitor = createSshClientLifecycleMonitor(client);

  return await new Promise<OpenSshClientResult>((resolve) => {
    let settled = false;

    const settle = (result: OpenSshClientResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      options.signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };

    const handleAbort = (): void => {
      if (settled) {
        return;
      }

      client.off('error', handleError);
      lifecycleMonitor.releaseAfterClose();
      settle({
        type: 'failed',
        message: options.signal ? readSshConnectionAbortError(options.signal).message : 'SSH connection cancelled.',
        proxyMetadata: proxyTransport.metadata,
      });
      client.destroy();
      proxyTransport.socket?.destroy();
    };

    const handleError = (error: Error): void => {
      if (settled) {
        return;
      }

      client.off('error', handleError);
      lifecycleMonitor.releaseAfterClose();
      client.end();

      if (options.strictHostKey && presentedFingerprint && !options.trustedFingerprintSet.has(presentedFingerprint)) {
        settle({
          type: 'host-untrusted',
          fingerprint: presentedFingerprint,
          message: error.message,
          proxyMetadata: proxyTransport.metadata,
        });
        return;
      }

      settle({
        type: 'failed',
        message: error.message,
        proxyMetadata: proxyTransport.metadata,
      });
    };

    client.once('ready', () => {
      if (settled) {
        return;
      }

      client.off('error', handleError);
      settle({
        type: 'ready',
        client,
        loginPassword,
        lifecycleMonitor,
        proxyMetadata: proxyTransport.metadata,
      });
    });

    client.once('error', handleError);
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }

    try {
      client.connect(connectConfig);
    } catch (error: unknown) {
      handleError(error instanceof Error ? error : new Error('SSH connection failed.'));
    }
  });
};
