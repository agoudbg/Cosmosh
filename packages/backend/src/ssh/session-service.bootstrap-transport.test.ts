import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DEFAULT_SETTINGS_VALUES, type ShellContext } from '@cosmosh/api-contract';
import type { Client, ClientChannel } from 'ssh2';

import type { I18nInstance } from '../i18n-bridge.js';
import type { RemoteBootstrapResult, RemoteBootstrapStatus } from '../remote-bootstrap/service.js';
import type { OpenSshClientResult, SshClientLifecycleMonitor, SshServerWithKeychain } from './connect.js';
import { SshSessionService } from './session-service.js';

type OpenShellHarness = {
  openShell(
    server: SshServerWithKeychain,
    options: {
      cols: number;
      rows: number;
      term: string;
      connectTimeoutSec: number;
      strictHostKey: boolean;
      enableSshCompression: boolean;
      systemProxyRules?: string;
      trustedFingerprintSet: Set<string>;
      t: I18nInstance['t'];
      beforeShellOpen: (signal: AbortSignal) => Promise<RemoteBootstrapResult>;
      onOutput: (data: string) => void;
    },
  ): Promise<
    | {
        type: 'ready';
        client: Client;
        stream: ClientChannel;
        loginPassword: string | null;
        streamLifecycleMonitor: {
          isClosed(): boolean;
          release(): void;
        };
        remoteBootstrapResult: RemoteBootstrapResult;
      }
    | { type: 'host-untrusted' | 'failed' }
  >;
};

type BootstrapEnsureHarness = {
  ensureRemoteEnhancementsBeforeShell(options: {
    openClient: (signal: AbortSignal) => Promise<OpenSshClientResult>;
    serverId: string;
    sessionId: string;
    requestId?: string;
    serverEnabled: boolean;
    signal?: AbortSignal;
    sendStatus: (status: RemoteBootstrapStatus) => void;
    ensureTimeoutMs?: number;
  }): Promise<RemoteBootstrapResult>;
};

type FakeExecMode = 'client-error' | 'echo' | 'hang';

type LifecycleMonitorCalls = {
  release: number;
  releaseAfterClose: number;
};

/**
 * Creates an idle lifecycle monitor for fake clients that stay connected.
 *
 * @param error Optional error captured before consumer listeners were attached.
 * @param closed Whether the client closed before consumer listeners were attached.
 * @param calls Optional counters for lifecycle ownership assertions.
 * @returns Lifecycle monitor with deterministic handoff state.
 */
const createLifecycleMonitor = (
  error: Error | null = null,
  closed = false,
  calls?: LifecycleMonitorCalls,
): SshClientLifecycleMonitor => ({
  readError: () => error,
  isClosed: () => closed,
  release: (): void => {
    if (calls) {
      calls.release += 1;
    }
  },
  releaseAfterClose: (): void => {
    if (calls) {
      calls.releaseAfterClose += 1;
    }
  },
});

/**
 * Creates the minimum channel surface used by shell output and bounded exec tests.
 *
 * @param operations Ordered transport operation log.
 * @returns Event-capable fake ssh2 channel.
 */
const createFakeChannel = (operations: string[]): ClientChannel => {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close(): void;
  };
  channel.stderr = new EventEmitter();
  channel.close = (): void => {
    operations.push('channel:close');
  };
  return channel as unknown as ClientChannel;
};

/**
 * Creates a primary transport whose login message disappears if exec is ever called first.
 *
 * @param operations Ordered primary-transport operation log.
 * @param flow Cross-transport flow log.
 * @param motd Debian login message emitted by the first shell channel.
 * @param closeAfterShellCallback Whether the stream closes in the shell callback stack.
 * @returns Fake authenticated primary client.
 */
const createPrimaryClient = (
  operations: string[],
  flow: string[],
  motd: string,
  closeAfterShellCallback = false,
): Client => {
  const emitter = new EventEmitter();
  const client = emitter as unknown as Client;
  let loginMessageAvailable = true;

  Object.assign(emitter, {
    exec: (): void => {
      operations.push('exec');
      flow.push('primary:exec');
      loginMessageAvailable = false;
    },
    shell: (
      _window: unknown,
      _options: unknown,
      callback: (error: Error | undefined, stream: ClientChannel) => void,
    ): void => {
      operations.push('shell');
      flow.push('primary:shell');
      const stream = createFakeChannel(operations);
      callback(undefined, stream);
      if (closeAfterShellCallback) {
        stream.emit('close');
      }
      queueMicrotask(() => {
        if (loginMessageAvailable) {
          stream.emit('data', Buffer.from(motd, 'utf8'));
        }
      });
    },
    end: (): Client => client,
    destroy: (): Client => client,
  });

  return client;
};

/**
 * Creates a dedicated bootstrap transport with deterministic exec output or a hanging channel.
 *
 * @param operations Ordered bootstrap-transport operation log.
 * @param mode Whether exec echoes its command or waits for cancellation.
 * @returns Fake authenticated bootstrap client.
 */
const createBootstrapClient = (operations: string[], mode: FakeExecMode): Client => {
  const emitter = new EventEmitter();
  const client = emitter as unknown as Client;

  Object.assign(emitter, {
    exec: (command: string, callback: (error: Error | undefined, channel: ClientChannel) => void): void => {
      operations.push(`exec:${command}`);
      const channel = createFakeChannel(operations);
      callback(undefined, channel);
      if (mode === 'echo') {
        queueMicrotask(() => {
          channel.emit('data', Buffer.from(`${command}\n`, 'utf8'));
          channel.emit('close');
        });
      } else if (mode === 'client-error') {
        queueMicrotask(() => {
          emitter.emit('error', new Error('bootstrap transport failed'));
        });
      }
    },
    shell: (): void => {
      throw new Error('bootstrap transport must never open an interactive shell');
    },
    end: (): Client => {
      operations.push('end');
      return client;
    },
    destroy: (): Client => {
      operations.push('destroy');
      return client;
    },
  });

  return client;
};

/**
 * Builds the minimal service context used by the private pre-shell ensure seam.
 *
 * @param runForSession Remote bootstrap behavior under test.
 * @returns Prototype-call context with default settings enabled.
 */
const createEnsureContext = (
  runForSession: (options: {
    executeCommand: (command: string) => Promise<string | null>;
    signal?: AbortSignal;
  }) => Promise<RemoteBootstrapResult>,
): object => ({
  getDbClient: () => ({
    $queryRaw: async () => [],
  }),
  remoteBootstrapService: {
    runForSession,
    reportStatus: (): void => undefined,
  },
});

const translate = ((key: string): string => key) as I18nInstance['t'];

for (const scenario of ['settings-failure', 'disabled-during-connect'] as const) {
  test('createSession preserves ordinary SSH when ' + scenario, async (t) => {
    const operations: string[] = [];
    const contract = {
      shell: 'bash' as const,
      helperVersion: 'fixture-v3',
      protocolVersion: 3,
      capabilities: ['cwd', 'prompt-ready'] as ['cwd', 'prompt-ready'],
    };
    const handshake =
      '\x1b]777;cosmosh;' +
      Buffer.from(
        JSON.stringify({
          ...contract,
          shellInstanceId: 'fixture-original',
          event: 'integration-ready',
          timestamp: 1,
        }),
      ).toString('base64') +
      '\x07';
    const client = createPrimaryClient(operations, [], handshake + 'LOGIN_MESSAGE\r\n');
    type Session = {
      attachTimeout: NodeJS.Timeout;
      shellContext: ShellContext;
      remoteEnhancementsRuntimeState: string;
      remoteEnhancementsRuntimeCode: string;
    };
    const sessions = new Map<string, Session>();
    t.after(() => {
      for (const session of sessions.values()) clearTimeout(session.attachTimeout);
    });
    const db = {
      sshServer: {
        findUnique: async () => ({
          id: 'server',
          host: 'fixture',
          port: 22,
          strictHostKey: true,
          enableSshCompression: false,
          remoteEnhancementsEnabled: true,
        }),
      },
      sshKnownHost: { findMany: async () => [] },
      sshLoginAudit: { create: async () => ({ id: 'audit' }) },
      $queryRaw: async () => {
        if (scenario === 'settings-failure') throw new Error('fixture settings unavailable');
        return [{ payloadJson: '{}', revision: 1 }];
      },
    };
    const service = Object.assign(
      Object.create(SshSessionService.prototype) as Pick<
        SshSessionService,
        'createSession' | 'applyEnhancementSettings'
      >,
      {
        sessions,
        enhancementSettingsSnapshot: null,
        websocketBaseUrl: 'ws://fixture',
        getDbClient: () => db,
        auditEventService: { logEvent: async () => undefined },
        // Periodic scheduling is unrelated to this connection transaction.
        startSessionTelemetry: () => undefined,
        scheduleHistorySync: () => undefined,
        openAuthenticatedClient: async (): Promise<OpenSshClientResult> => ({
          type: 'ready',
          client,
          loginPassword: null,
          lifecycleMonitor: createLifecycleMonitor(),
          proxyMetadata: { mode: 'off', protocol: 'direct' },
        }),
        remoteBootstrapService: {
          reportStatus: () => undefined,
          runForSession: async (): Promise<RemoteBootstrapResult> => {
            service.applyEnhancementSettings({
              revision: 2,
              values: { ...DEFAULT_SETTINGS_VALUES, remoteEnhancementsEnabled: false },
            });
            return { state: 'ready', source: 'current', contract };
          },
        },
      },
    );
    const result = await service.createSession({
      serverId: 'server',
      locale: 'en',
      cols: 80,
      rows: 24,
      term: 'xterm-256color',
      connectTimeoutSec: 5,
    });
    assert.equal(result.type, 'success');
    assert.deepEqual(operations, ['shell'], 'optional setup failure cannot touch the primary exec channel');
    const session = [...sessions.values()][0]!;
    assert.equal(session.remoteEnhancementsRuntimeState, 'disabled');
    assert.equal(
      session.remoteEnhancementsRuntimeCode,
      scenario === 'settings-failure' ? 'SETTINGS_READ_FAILED' : 'PERMISSION_DISABLED',
    );
    assert.equal(session.shellContext.status, 'unavailable');
    assert.equal(session.shellContext.shellInstanceId, null, 'buffered handshake cannot activate the disabled runtime');
    assert.ok(Object.values(session.shellContext.permissions).every((allowed) => allowed === false));
  });
}

test('SshSessionService keeps the primary transport exec-free so Debian MOTD reaches the first shell', async () => {
  const primaryOperations: string[] = [];
  const flow: string[] = [];
  const output: string[] = [];
  const motd = 'Debian GNU/Linux comes with ABSOLUTELY NO WARRANTY\r\n';
  const primaryClient = createPrimaryClient(primaryOperations, flow, motd);
  const serviceContext = {
    openAuthenticatedClient: async (): Promise<OpenSshClientResult> => ({
      type: 'ready',
      client: primaryClient,
      loginPassword: null,
      lifecycleMonitor: createLifecycleMonitor(),
      proxyMetadata: { mode: 'off', protocol: 'direct' },
    }),
  };
  const serviceHarness = SshSessionService.prototype as unknown as OpenShellHarness;

  const result = await serviceHarness.openShell.call(serviceContext, {} as SshServerWithKeychain, {
    cols: 120,
    rows: 32,
    term: 'xterm-256color',
    connectTimeoutSec: 15,
    strictHostKey: true,
    enableSshCompression: false,
    trustedFingerprintSet: new Set<string>(),
    t: translate,
    beforeShellOpen: async (signal) => {
      assert.equal(signal.aborted, false);
      flow.push('bootstrap:exec');
      flow.push('bootstrap:end');
      return { state: 'disabled', code: 'TEST_COMPLETE', message: 'test bootstrap complete' };
    },
    onOutput: (data) => output.push(data),
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(result.type, 'ready');
  assert.deepEqual(primaryOperations, ['shell']);
  assert.deepEqual(flow, ['bootstrap:exec', 'bootstrap:end', 'primary:shell']);
  assert.equal(output.join(''), motd);
});

test('SshSessionService captures a shell stream close before session handoff resumes', async () => {
  const primaryClient = createPrimaryClient([], [], 'unused', true);
  const serviceContext = {
    openAuthenticatedClient: async (): Promise<OpenSshClientResult> => ({
      type: 'ready',
      client: primaryClient,
      loginPassword: null,
      lifecycleMonitor: createLifecycleMonitor(),
      proxyMetadata: { mode: 'off', protocol: 'direct' },
    }),
  };
  const serviceHarness = SshSessionService.prototype as unknown as OpenShellHarness;

  const result = await serviceHarness.openShell.call(serviceContext, {} as SshServerWithKeychain, {
    cols: 120,
    rows: 32,
    term: 'xterm-256color',
    connectTimeoutSec: 15,
    strictHostKey: true,
    enableSshCompression: false,
    trustedFingerprintSet: new Set<string>(),
    t: translate,
    beforeShellOpen: async () => ({ state: 'disabled', code: 'TEST', message: 'complete' }),
    onOutput: (): void => undefined,
  });

  assert.equal(result.type, 'ready');
  if (result.type === 'ready') {
    assert.equal(result.streamLifecycleMonitor.isClosed(), true);
    result.streamLifecycleMonitor.release();
  }
});

test('SshSessionService fails safely when the primary client errors during lifecycle handoff', async () => {
  const primaryOperations: string[] = [];
  const flow: string[] = [];
  const primaryClient = createPrimaryClient(primaryOperations, flow, 'unused');
  const handoffError = new Error('primary transport failed during handoff');
  const lifecycleCalls: LifecycleMonitorCalls = { release: 0, releaseAfterClose: 0 };
  const serviceContext = {
    openAuthenticatedClient: async (): Promise<OpenSshClientResult> => ({
      type: 'ready',
      client: primaryClient,
      loginPassword: null,
      lifecycleMonitor: createLifecycleMonitor(handoffError, false, lifecycleCalls),
      proxyMetadata: { mode: 'off', protocol: 'direct' },
    }),
  };
  const serviceHarness = SshSessionService.prototype as unknown as OpenShellHarness;

  const result = await serviceHarness.openShell.call(serviceContext, {} as SshServerWithKeychain, {
    cols: 120,
    rows: 32,
    term: 'xterm-256color',
    connectTimeoutSec: 15,
    strictHostKey: true,
    enableSshCompression: false,
    trustedFingerprintSet: new Set<string>(),
    t: translate,
    beforeShellOpen: async () => ({ state: 'disabled', code: 'TEST', message: 'unused' }),
    onOutput: (): void => undefined,
  });

  assert.equal(result.type, 'failed');
  assert.deepEqual(primaryOperations, []);
  assert.deepEqual(lifecycleCalls, { release: 0, releaseAfterClose: 1 });
});

test('SshSessionService reuses one dedicated bootstrap client for all pre-shell exec commands', async () => {
  const operations: string[] = [];
  const bootstrapClient = createBootstrapClient(operations, 'echo');
  let openCount = 0;
  const serviceContext = createEnsureContext(async ({ executeCommand }) => {
    assert.equal(await executeCommand('probe'), 'probe\n');
    assert.equal(await executeCommand('status'), 'status\n');
    return { state: 'disabled', code: 'TEST_COMPLETE', message: 'test bootstrap complete' };
  });
  const serviceHarness = SshSessionService.prototype as unknown as BootstrapEnsureHarness;

  const result = await serviceHarness.ensureRemoteEnhancementsBeforeShell.call(serviceContext, {
    openClient: async (): Promise<OpenSshClientResult> => {
      openCount += 1;
      return {
        type: 'ready',
        client: bootstrapClient,
        loginPassword: 'must-not-escape',
        lifecycleMonitor: createLifecycleMonitor(),
        proxyMetadata: { mode: 'off', protocol: 'direct' },
      };
    },
    serverId: 'server-1',
    sessionId: 'session-1',
    serverEnabled: true,
    sendStatus: (): void => undefined,
    ensureTimeoutMs: 1_000,
  });

  assert.equal(result.state, 'disabled');
  assert.equal(openCount, 1);
  assert.deepEqual(operations, ['exec:probe', 'exec:status', 'end']);
});

test('SshSessionService contains dedicated bootstrap client errors and destroys that transport', async () => {
  const operations: string[] = [];
  const bootstrapClient = createBootstrapClient(operations, 'client-error');
  const serviceContext = createEnsureContext(async ({ executeCommand }) => {
    await executeCommand('probe');
    return { state: 'disabled', code: 'TEST_UNREACHABLE', message: 'unexpected completion' };
  });
  const serviceHarness = SshSessionService.prototype as unknown as BootstrapEnsureHarness;

  const result = await serviceHarness.ensureRemoteEnhancementsBeforeShell.call(serviceContext, {
    openClient: async (): Promise<OpenSshClientResult> => ({
      type: 'ready',
      client: bootstrapClient,
      loginPassword: null,
      lifecycleMonitor: createLifecycleMonitor(),
      proxyMetadata: { mode: 'off', protocol: 'direct' },
    }),
    serverId: 'server-1',
    sessionId: 'session-1',
    serverEnabled: true,
    sendStatus: (): void => undefined,
    ensureTimeoutMs: 1_000,
  });

  assert.equal(result.state, 'disabled');
  assert.equal(result.state === 'disabled' ? result.code : null, 'BOOTSTRAP_UNEXPECTED_FAILURE');
  assert.deepEqual(operations, ['exec:probe', 'channel:close', 'destroy']);
});

test('SshSessionService does not open a bootstrap transport until a remote command is required', async () => {
  let openCount = 0;
  const serviceContext = createEnsureContext(async () => ({
    state: 'disabled',
    code: 'MANIFEST_URL_NOT_CONFIGURED',
    message: 'manifest unavailable',
  }));
  const serviceHarness = SshSessionService.prototype as unknown as BootstrapEnsureHarness;

  await serviceHarness.ensureRemoteEnhancementsBeforeShell.call(serviceContext, {
    openClient: async (): Promise<OpenSshClientResult> => {
      openCount += 1;
      return { type: 'failed', message: 'unexpected connection attempt' };
    },
    serverId: 'server-1',
    sessionId: 'session-1',
    serverEnabled: true,
    sendStatus: (): void => undefined,
    ensureTimeoutMs: 1_000,
  });

  assert.equal(openCount, 0);
});

test('SshSessionService destroys the dedicated bootstrap transport when pre-shell setup times out', async () => {
  const operations: string[] = [];
  const bootstrapClient = createBootstrapClient(operations, 'hang');
  const serviceContext = createEnsureContext(async ({ executeCommand }) => {
    await executeCommand('hang');
    return { state: 'disabled', code: 'TEST_UNREACHABLE', message: 'unexpected completion' };
  });
  const serviceHarness = SshSessionService.prototype as unknown as BootstrapEnsureHarness;

  const result = await serviceHarness.ensureRemoteEnhancementsBeforeShell.call(serviceContext, {
    openClient: async (): Promise<OpenSshClientResult> => ({
      type: 'ready',
      client: bootstrapClient,
      loginPassword: null,
      lifecycleMonitor: createLifecycleMonitor(),
      proxyMetadata: { mode: 'off', protocol: 'direct' },
    }),
    serverId: 'server-1',
    sessionId: 'session-1',
    serverEnabled: true,
    sendStatus: (): void => undefined,
    ensureTimeoutMs: 5,
  });

  assert.equal(result.state, 'disabled');
  assert.equal(result.state === 'disabled' ? result.code : null, 'BOOTSTRAP_ENSURE_TIMEOUT');
  assert.deepEqual(operations, ['exec:hang', 'channel:close', 'destroy']);
});
