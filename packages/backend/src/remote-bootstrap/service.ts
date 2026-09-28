import { Buffer } from 'node:buffer';

import {
  REMOTE_SHELL_CAPABILITIES,
  REMOTE_SHELL_PROTOCOL_VERSION,
  type RemoteBootstrapPhase,
  type RemoteBootstrapState,
  type RemoteBootstrapStatus,
  type RemoteShellCapability,
} from '@cosmosh/api-contract';

import type { AuditEventService } from '../audit/service.js';

export {
  REMOTE_SHELL_PROTOCOL_VERSION,
  type RemoteBootstrapPhase,
  type RemoteBootstrapState,
  type RemoteBootstrapStatus,
};

/** Runtime identity returned only after bootstrap installation has been validated. */
export type RemoteBootstrapRuntimeContract = {
  shell: RemoteBootstrapProbe['shell'];
  helperVersion: string;
  protocolVersion: number;
  capabilities: RemoteShellCapability[];
  /** Validated absolute path of the installed request-scoped helper. */
  binaryPath?: string;
};

/** Result used by SSH session creation to enable or disable helper event consumption. */
export type RemoteBootstrapResult =
  | {
      state: 'ready';
      source: 'current' | 'installed';
      contract: RemoteBootstrapRuntimeContract;
    }
  | {
      state: 'disabled';
      code: string;
      message: string;
    };

type RemoteBootstrapProbe = {
  os: 'linux';
  arch: 'amd64' | 'arm64';
  shell: 'ash' | 'bash' | 'fish' | 'sh' | 'zsh';
};

type RemoteBootstrapAsset = {
  os: string;
  arch: string;
  url: string;
  sha256: string;
};

type RemoteBootstrapManifest = {
  version: string;
  assets: RemoteBootstrapAsset[];
};

type RemoteBootstrapInstalledStatus = {
  installed: boolean;
  version: string;
  protocolVersion: number;
  capabilities: RemoteShellCapability[];
  helperCurrent: boolean;
  profileCurrent: boolean;
  binarySha256: string;
  binaryPath: string | null;
};

type RemoteBootstrapServiceOptions = {
  auditEventService: AuditEventService;
  manifestUrl?: string;
  fetchManifest?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  manifestCacheTtlMs?: number;
  now?: () => number;
};

type RemoteBootstrapManifestLoadOutcome =
  | { state: 'ready'; manifest: RemoteBootstrapManifest }
  | { state: 'failed'; code: 'MANIFEST_FETCH_FAILED' | 'MANIFEST_INVALID'; message: string };

/** Session identity and live sink shared by status delivery and audit persistence. */
type RemoteBootstrapStatusContext = {
  serverId: string;
  sessionId: string;
  requestId?: string;
  sendStatus: (status: RemoteBootstrapStatus) => void;
};

type RunForSessionOptions = RemoteBootstrapStatusContext & {
  executeCommand: (command: string) => Promise<string | null>;
  signal?: AbortSignal;
};

const REMOTE_BOOTSTRAP_COMMAND_TIMEOUT_MS = 60_000;
const REMOTE_BOOTSTRAP_OUTPUT_MAX_BYTES = 256 * 1024;
const REMOTE_BOOTSTRAP_MANIFEST_TIMEOUT_MS = 10_000;
const REMOTE_BOOTSTRAP_MANIFEST_CACHE_TTL_MS = 5 * 60_000;
const REMOTE_BOOTSTRAP_SUPPORTED_SHELLS = new Set(['ash', 'bash', 'fish', 'sh', 'zsh']);
const REMOTE_BOOTSTRAP_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_BOOTSTRAP_VERSION_PATTERN = /^[A-Za-z0-9._+-]+$/;
const REMOTE_BOOTSTRAP_MAX_CAPABILITIES = 32;
const REMOTE_BOOTSTRAP_CAPABILITY_SET = new Set<RemoteShellCapability>(REMOTE_SHELL_CAPABILITIES);

const PROBE_COMMAND =
  ' sh -lc \'os=$(uname -s 2>/dev/null | tr "[:upper:]" "[:lower:]"); arch=$(uname -m 2>/dev/null); shell_name=$(basename "${SHELL:-sh}"); case "$arch" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) arch=unsupported;; esac; case "$shell_name" in zsh|fish|bash|ash|sh) shell="$shell_name";; *) shell=unsupported;; esac; printf "{\\"os\\":\\"%s\\",\\"arch\\":\\"%s\\",\\"shell\\":\\"%s\\"}\\n" "$os" "$arch" "$shell"\'';

/**
 * Orchestrates remote bootstrap probe, wrapper injection, and status parsing.
 */
export class RemoteBootstrapService {
  private readonly auditEventService: AuditEventService;

  private readonly manifestUrl: string | undefined;

  private readonly fetchManifest: (url: string, signal?: AbortSignal) => Promise<unknown>;

  private readonly manifestCacheTtlMs: number;

  private readonly now: () => number;

  private manifestCache: { expiresAt: number; manifest: RemoteBootstrapManifest } | null = null;

  private manifestLoadPromise: Promise<RemoteBootstrapManifestLoadOutcome> | null = null;

  public constructor(options: RemoteBootstrapServiceOptions) {
    this.auditEventService = options.auditEventService;
    this.manifestUrl = options.manifestUrl;
    this.fetchManifest = options.fetchManifest ?? defaultFetchManifest;
    this.manifestCacheTtlMs = Math.max(0, options.manifestCacheTtlMs ?? REMOTE_BOOTSTRAP_MANIFEST_CACHE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Delivers one bootstrap status to both the live session and persistent audit trail.
   *
   * Session-owned terminal failures use this method so their audit metadata remains
   * identical to statuses emitted during bootstrap orchestration.
   *
   * @param context Session identity and renderer status sink.
   * @param status Bootstrap status to deliver and audit.
   * @returns Nothing.
   */
  public reportStatus(context: RemoteBootstrapStatusContext, status: RemoteBootstrapStatus): void {
    context.sendStatus(status);
    this.logStatus(context, status);
  }

  /**
   * Runs bootstrap for one live SSH session without touching the interactive shell stream.
   *
   * @param options Session-scoped command executor and status callback.
   * @returns Validated runtime contract, or a disabled result that leaves ordinary SSH available.
   */
  public async runForSession(options: RunForSessionOptions): Promise<RemoteBootstrapResult> {
    throwIfSignalAborted(options.signal);

    let lastFailure: RemoteBootstrapStatus | null = null;
    const emit = (status: RemoteBootstrapStatus): void => {
      if (options.signal?.aborted) {
        return;
      }

      if (status.state === 'failed') {
        lastFailure = status;
      }
      this.reportStatus(options, status);
    };

    const manifest = await this.loadManifest(emit, options.signal);
    throwIfSignalAborted(options.signal);
    if (!manifest) {
      return disabledFromStatus(lastFailure);
    }

    emit({ type: 'bootstrap-status', phase: 'probe', state: 'started', message: 'probing remote host' });
    const probe = await this.probeRemote(options.executeCommand, options.signal);
    throwIfSignalAborted(options.signal);
    if (!probe) {
      emit(this.failed('probe', 'PROBE_FAILED', 'remote platform or shell is unsupported'));
      return disabledFromStatus(lastFailure);
    }

    const asset = selectAsset(manifest, probe);
    if (!asset) {
      emit(this.failed('manifest', 'ASSET_NOT_FOUND', 'no matching linux bootstrap asset was found', manifest.version));
      return disabledFromStatus(lastFailure);
    }

    const installedStatus = await this.readInstalledStatus(options.executeCommand, probe.shell, options.signal);
    throwIfSignalAborted(options.signal);
    if (isCurrentInstalledStatus(installedStatus, manifest.version, asset.sha256)) {
      emit({
        type: 'bootstrap-status',
        phase: 'install',
        state: 'skipped',
        version: manifest.version,
        message: 'bootstrap already current',
      });
      return readyResult('current', probe.shell, installedStatus);
    }

    let output: string | null;
    try {
      output = await options.executeCommand(buildInstallCommand(probe, manifest, asset));
    } catch (error: unknown) {
      throwIfSignalAborted(options.signal);
      emit(this.failed('install', 'INSTALL_COMMAND_FAILED', errorMessage(error), manifest.version));
      return disabledFromStatus(lastFailure);
    }
    throwIfSignalAborted(options.signal);

    if (!this.forwardStatuses(output, emit, manifest.version)) {
      return disabledFromStatus(lastFailure);
    }

    const verifiedStatus = await this.readInstalledStatus(options.executeCommand, probe.shell, options.signal);
    throwIfSignalAborted(options.signal);
    if (!isCurrentInstalledStatus(verifiedStatus, manifest.version, asset.sha256)) {
      emit(
        this.failed(
          'verify',
          'INSTALLATION_NOT_CURRENT',
          'installed bootstrap runtime failed validation',
          manifest.version,
        ),
      );
      return disabledFromStatus(lastFailure);
    }

    return readyResult('installed', probe.shell, verifiedStatus);
  }

  private async probeRemote(
    executeCommand: RunForSessionOptions['executeCommand'],
    signal?: AbortSignal,
  ): Promise<RemoteBootstrapProbe | null> {
    let output: string | null;
    try {
      output = await executeCommand(PROBE_COMMAND);
    } catch {
      throwIfSignalAborted(signal);
      return null;
    }
    throwIfSignalAborted(signal);
    if (!output) {
      return null;
    }

    return parseProbe(output);
  }

  /**
   * Reads the installed bootstrap's self-validated helper and profile state.
   *
   * @param executeCommand Bounded SSH side-channel executor.
   * @param shell Probed login shell used to resolve the installed helper.
   * @param signal Session bootstrap cancellation signal.
   * @returns Parsed status, or null for missing, legacy, or invalid installations.
   */
  private async readInstalledStatus(
    executeCommand: RunForSessionOptions['executeCommand'],
    shell: RemoteBootstrapProbe['shell'],
    signal?: AbortSignal,
  ): Promise<RemoteBootstrapInstalledStatus | null> {
    try {
      const output = await executeCommand(buildInstalledStatusCommand(shell));
      throwIfSignalAborted(signal);
      return parseInstalledStatus(output);
    } catch {
      throwIfSignalAborted(signal);
      return null;
    }
  }

  private async loadManifest(
    emit: (status: RemoteBootstrapStatus) => void,
    signal?: AbortSignal,
  ): Promise<RemoteBootstrapManifest | null> {
    throwIfSignalAborted(signal);
    if (!this.manifestUrl) {
      emit(this.failed('manifest', 'MANIFEST_URL_NOT_CONFIGURED', 'remote bootstrap manifest URL is not configured'));
      return null;
    }

    emit({ type: 'bootstrap-status', phase: 'manifest', state: 'started', message: 'loading bootstrap manifest' });
    const outcome = await awaitWithAbortSignal(this.loadSharedManifest(), signal);
    throwIfSignalAborted(signal);
    if (outcome.state === 'failed') {
      emit(this.failed('manifest', outcome.code, outcome.message));
      return null;
    }

    const manifest = outcome.manifest;
    emit({ type: 'bootstrap-status', phase: 'manifest', state: 'ok', version: manifest.version });
    return manifest;
  }

  /**
   * Loads one validated manifest through a success-only TTL cache and shared in-flight request.
   *
   * The underlying request intentionally has its own bounded timeout instead of inheriting one
   * session's signal. A cancelled session stops waiting without cancelling other sessions that
   * are awaiting the same deployment metadata.
   *
   * @returns Shared validated manifest outcome.
   */
  private loadSharedManifest(): Promise<RemoteBootstrapManifestLoadOutcome> {
    const now = this.now();
    if (this.manifestCache && this.manifestCache.expiresAt > now) {
      return Promise.resolve({ state: 'ready', manifest: this.manifestCache.manifest });
    }

    if (this.manifestLoadPromise) {
      return this.manifestLoadPromise;
    }

    const manifestUrl = this.manifestUrl;
    if (!manifestUrl) {
      return Promise.resolve({
        state: 'failed',
        code: 'MANIFEST_FETCH_FAILED',
        message: 'remote bootstrap manifest URL is not configured',
      });
    }

    const pendingLoad = (async (): Promise<RemoteBootstrapManifestLoadOutcome> => {
      let loaded: unknown;
      try {
        loaded = await this.fetchManifest(manifestUrl);
      } catch (error: unknown) {
        return {
          state: 'failed',
          code: 'MANIFEST_FETCH_FAILED',
          message: error instanceof Error ? error.message : 'manifest request failed',
        };
      }

      const manifest = parseManifest(loaded);
      if (!manifest) {
        return {
          state: 'failed',
          code: 'MANIFEST_INVALID',
          message: 'remote bootstrap manifest is invalid',
        };
      }

      if (this.manifestCacheTtlMs > 0) {
        this.manifestCache = {
          expiresAt: this.now() + this.manifestCacheTtlMs,
          manifest,
        };
      }
      return { state: 'ready', manifest };
    })();

    this.manifestLoadPromise = pendingLoad;
    const clearPendingLoad = (): void => {
      if (this.manifestLoadPromise === pendingLoad) {
        this.manifestLoadPromise = null;
      }
    };
    void pendingLoad.then(clearPendingLoad, clearPendingLoad);
    return pendingLoad;
  }

  private forwardStatuses(
    output: string | null,
    emit: (status: RemoteBootstrapStatus) => void,
    version: string,
  ): boolean {
    const statuses = parseStatusLines(output);
    if (statuses.length === 0) {
      emit(this.failed('install', 'NO_STATUS_OUTPUT', 'bootstrap wrapper did not emit status output', version));
      return false;
    }

    statuses.forEach(emit);
    return (
      !statuses.some((status) => status.state === 'failed') &&
      statuses.some((status) => status.state === 'ok' || status.state === 'skipped')
    );
  }

  private failed(phase: RemoteBootstrapPhase, code: string, message: string, version?: string): RemoteBootstrapStatus {
    return {
      type: 'bootstrap-status',
      phase,
      state: 'failed',
      version,
      code,
      message,
    };
  }

  private logStatus(options: RemoteBootstrapStatusContext, status: RemoteBootstrapStatus): void {
    if (status.state !== 'failed' && status.state !== 'ok' && status.state !== 'skipped') {
      return;
    }

    void this.auditEventService.logEvent({
      category: 'ssh-session',
      action: 'remote-bootstrap',
      outcome: status.state === 'failed' ? 'failure' : 'success',
      severity: status.state === 'failed' ? 'warning' : 'info',
      entityType: 'ssh-server',
      entityId: options.serverId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      metadata: status,
    });
  }
}

/** Bounded SSH exec limits for remote bootstrap side-channel commands. */
export const REMOTE_BOOTSTRAP_EXEC_OPTIONS = {
  timeoutMs: REMOTE_BOOTSTRAP_COMMAND_TIMEOUT_MS,
  maxOutputBytes: REMOTE_BOOTSTRAP_OUTPUT_MAX_BYTES,
} as const;

const defaultFetchManifest = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REMOTE_BOOTSTRAP_MANIFEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REMOTE_BOOTSTRAP_MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Remote bootstrap manifest request failed: ${response.status}`);
  }

  return await response.json();
};

/**
 * Propagates a caller-provided cancellation reason at async boundaries.
 *
 * @param signal Optional cancellation signal for one session bootstrap attempt.
 * @returns Nothing.
 */
const throwIfSignalAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw new Error('Remote bootstrap was cancelled.');
};

/**
 * Stops one session from waiting on shared manifest I/O without cancelling other waiters.
 *
 * @param operation Shared bounded manifest operation.
 * @param signal Optional session cancellation signal.
 * @returns Operation result when it resolves before session cancellation.
 */
const awaitWithAbortSignal = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return await operation;
  }
  throwIfSignalAborted(signal);

  return await new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      signal.removeEventListener('abort', handleAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Remote bootstrap was cancelled.'));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
};

const parseProbe = (output: string): RemoteBootstrapProbe | null => {
  const parsed = parseLastJsonObject(output);
  if (!parsed) {
    return null;
  }

  if (parsed.os !== 'linux' || (parsed.arch !== 'amd64' && parsed.arch !== 'arm64')) {
    return null;
  }

  if (typeof parsed.shell !== 'string' || !REMOTE_BOOTSTRAP_SUPPORTED_SHELLS.has(parsed.shell)) {
    return null;
  }

  return parsed as RemoteBootstrapProbe;
};

const parseManifest = (value: unknown): RemoteBootstrapManifest | null => {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    !REMOTE_BOOTSTRAP_VERSION_PATTERN.test(value.version) ||
    !Array.isArray(value.assets)
  ) {
    return null;
  }

  const assets: RemoteBootstrapAsset[] = [];
  for (const asset of value.assets) {
    if (!isValidAsset(asset)) {
      return null;
    }

    assets.push(asset);
  }

  if (assets.length === 0) {
    return null;
  }

  return {
    version: value.version,
    assets,
  };
};

const isValidAsset = (value: unknown): value is RemoteBootstrapAsset => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.os === 'string' &&
    typeof value.arch === 'string' &&
    typeof value.url === 'string' &&
    typeof value.sha256 === 'string' &&
    isHttpsUrl(value.url) &&
    REMOTE_BOOTSTRAP_SHA256_PATTERN.test(value.sha256)
  );
};

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const selectAsset = (manifest: RemoteBootstrapManifest, probe: RemoteBootstrapProbe): RemoteBootstrapAsset | null => {
  return manifest.assets.find((asset) => asset.os === probe.os && asset.arch === probe.arch) ?? null;
};

/**
 * Builds a side-channel command that invokes the installed binary only when present.
 *
 * @param shell Probed login shell.
 * @returns POSIX command that emits one status JSON object or no output.
 */
const buildInstalledStatusCommand = (shell: RemoteBootstrapProbe['shell']): string => {
  const script = `data_root=\${XDG_DATA_HOME:-"$HOME/.local/share"}
bin="$data_root/cosmosh/bootstrap/bin/cosmosh-bootstrap"
if [ -x "$bin" ]; then "$bin" status --shell ${quotePosixShell(shell)}; fi`;
  return ` sh -lc ${quotePosixShell(script)}`;
};

/**
 * Parses the installed binary's strict runtime contract.
 *
 * @param output Raw bounded SSH command output.
 * @returns Validated status, or null for legacy and malformed output.
 */
const parseInstalledStatus = (output: string | null): RemoteBootstrapInstalledStatus | null => {
  if (!output) {
    return null;
  }

  const parsed = parseLastJsonObject(output);
  if (
    !parsed ||
    typeof parsed.installed !== 'boolean' ||
    typeof parsed.version !== 'string' ||
    !REMOTE_BOOTSTRAP_VERSION_PATTERN.test(parsed.version) ||
    typeof parsed.protocolVersion !== 'number' ||
    !Number.isInteger(parsed.protocolVersion) ||
    typeof parsed.helperCurrent !== 'boolean' ||
    typeof parsed.profileCurrent !== 'boolean' ||
    typeof parsed.binarySha256 !== 'string' ||
    !REMOTE_BOOTSTRAP_SHA256_PATTERN.test(parsed.binarySha256) ||
    !Array.isArray(parsed.capabilities) ||
    parsed.capabilities.length === 0 ||
    parsed.capabilities.length > REMOTE_BOOTSTRAP_MAX_CAPABILITIES
  ) {
    return null;
  }

  const capabilities: RemoteShellCapability[] = [];
  for (const capability of parsed.capabilities) {
    if (
      typeof capability !== 'string' ||
      !REMOTE_BOOTSTRAP_CAPABILITY_SET.has(capability as RemoteShellCapability) ||
      capabilities.includes(capability as RemoteShellCapability)
    ) {
      return null;
    }
    capabilities.push(capability as RemoteShellCapability);
  }

  return {
    installed: parsed.installed,
    version: parsed.version,
    protocolVersion: parsed.protocolVersion,
    capabilities,
    helperCurrent: parsed.helperCurrent,
    profileCurrent: parsed.profileCurrent,
    binarySha256: parsed.binarySha256,
    binaryPath:
      typeof parsed.binaryPath === 'string' &&
      parsed.binaryPath.startsWith('/') &&
      !parsed.binaryPath.includes('\u0000') &&
      Buffer.byteLength(parsed.binaryPath, 'utf8') <= 4096
        ? parsed.binaryPath
        : null,
  };
};

/**
 * Checks whether an installed status can be trusted for the selected manifest.
 *
 * @param status Parsed installed runtime status.
 * @param expectedVersion Selected manifest version.
 * @param expectedSHA256 Selected manifest asset digest.
 * @returns True only for a fully current and supported runtime.
 */
const isCurrentInstalledStatus = (
  status: RemoteBootstrapInstalledStatus | null,
  expectedVersion: string,
  expectedSHA256: string,
): status is RemoteBootstrapInstalledStatus => {
  return (
    status !== null &&
    status.installed &&
    status.version === expectedVersion &&
    status.binarySha256 === expectedSHA256 &&
    status.protocolVersion === REMOTE_SHELL_PROTOCOL_VERSION &&
    status.helperCurrent &&
    status.profileCurrent
  );
};

/**
 * Creates the runtime contract returned to SSH session orchestration.
 *
 * @param source Whether the fast path or installation path produced the contract.
 * @param shell Probed login shell.
 * @param status Validated installed runtime status.
 * @returns Ready bootstrap result.
 */
const readyResult = (
  source: 'current' | 'installed',
  shell: RemoteBootstrapProbe['shell'],
  status: RemoteBootstrapInstalledStatus,
): RemoteBootstrapResult => {
  return {
    state: 'ready',
    source,
    contract: {
      shell,
      helperVersion: status.version,
      protocolVersion: status.protocolVersion,
      capabilities: [...status.capabilities],
      ...(status.binaryPath ? { binaryPath: status.binaryPath } : {}),
    },
  };
};

/**
 * Converts the most recent bootstrap failure into a fail-closed runtime result.
 *
 * @param status Most recently emitted failure status.
 * @returns Disabled result suitable for ordinary SSH fallback.
 */
const disabledFromStatus = (status: RemoteBootstrapStatus | null): RemoteBootstrapResult => {
  return {
    state: 'disabled',
    code: status?.code ?? 'BOOTSTRAP_UNAVAILABLE',
    message: status?.message ?? 'remote enhancements are unavailable',
  };
};

/**
 * Normalizes an unknown thrown value into an operator-facing error string.
 *
 * @param error Unknown command failure.
 * @returns Stable error message.
 */
const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'remote bootstrap command failed';
};

const buildInstallCommand = (
  probe: RemoteBootstrapProbe,
  manifest: RemoteBootstrapManifest,
  asset: RemoteBootstrapAsset,
): string => {
  const wrapper = buildWrapperScript(probe, manifest, asset);
  const wrapperPayload = Buffer.from(wrapper, 'utf8').toString('base64');
  const interpreter = probe.shell === 'fish' || probe.shell === 'bash' ? probe.shell : 'sh';
  const base64MissingStatus = escapedJsonStatus(manifest.version, 'BASE64_NOT_FOUND', 'base64 is required');
  const mktempMissingStatus = escapedJsonStatus(manifest.version, 'MKTEMP_NOT_FOUND', 'mktemp is required');
  const mktempFailedStatus = escapedJsonStatus(manifest.version, 'MKTEMP_FAILED', 'mktemp failed');
  const shellMissingStatus = escapedJsonStatus(manifest.version, 'SHELL_NOT_FOUND', 'target shell is unavailable');
  const launcher = buildLauncherScript({
    base64MissingStatus,
    interpreter,
    mktempFailedStatus,
    mktempMissingStatus,
    shellMissingStatus,
    wrapperPayload,
  });
  return ` sh -lc ${quotePosixShell(launcher)}`;
};

/**
 * Builds the POSIX launcher that decodes and executes the shell-specific bootstrap wrapper.
 *
 * @param config Precomputed launcher payload and status strings.
 * @returns Shell source passed as one literal argument to `sh -lc`.
 */
const buildLauncherScript = (config: {
  base64MissingStatus: string;
  interpreter: string;
  mktempFailedStatus: string;
  mktempMissingStatus: string;
  shellMissingStatus: string;
  wrapperPayload: string;
}): string => {
  return `if ! command -v base64 >/dev/null 2>&1; then printf "${config.base64MissingStatus}"; exit 1; fi
if ! command -v mktemp >/dev/null 2>&1; then printf "${config.mktempMissingStatus}"; exit 1; fi
if ! command -v ${config.interpreter} >/dev/null 2>&1; then printf "${config.shellMissingStatus}"; exit 1; fi
umask 077
tmp="$(mktemp "\${TMPDIR:-/tmp}/cosmosh-wrapper.XXXXXX")" || { printf "${config.mktempFailedStatus}"; exit 1; }
trap 'rm -f "$tmp"' EXIT HUP INT TERM
printf %s "${config.wrapperPayload}" | base64 -d > "$tmp" && ${config.interpreter} "$tmp"
rc=$?
exit $rc`;
};

const escapedJsonStatus = (version: string, code: string, message: string): string => {
  const payload = JSON.stringify({
    type: 'bootstrap-status',
    phase: 'install',
    state: 'failed',
    version,
    code,
    message,
  });
  return `${payload.replace(/"/g, '\\$&')}\\n`;
};

const buildWrapperScript = (
  probe: RemoteBootstrapProbe,
  manifest: RemoteBootstrapManifest,
  asset: RemoteBootstrapAsset,
): string => {
  const config = {
    shell: probe.shell,
    version: manifest.version,
    url: asset.url,
    sha256: asset.sha256,
  };

  return probe.shell === 'fish' ? buildFishWrapper(config) : buildPosixWrapper(config);
};

const buildPosixWrapper = (config: { shell: string; version: string; url: string; sha256: string }): string => {
  const shell = quotePosixShell(config.shell);
  const version = quotePosixShell(config.version);
  const url = quotePosixShell(config.url);
  const sha256 = quotePosixShell(config.sha256);

  return `set -eu
cosmosh_shell=${shell}
cosmosh_version=${version}
cosmosh_asset_url=${url}
cosmosh_sha256=${sha256}
cosmosh_fail() { printf '{"type":"bootstrap-status","phase":"%s","state":"failed","version":"%s","code":"%s","message":"%s"}\\n' "$1" "$cosmosh_version" "$2" "$3"; exit 1; }
if ! command -v mktemp >/dev/null 2>&1; then cosmosh_fail download MKTEMP_NOT_FOUND "mktemp is required"; fi
umask 077
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/cosmosh-bootstrap.XXXXXX")" || cosmosh_fail download MKTEMP_FAILED "mktemp failed"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/cosmosh-bootstrap"
printf '{"type":"bootstrap-status","phase":"download","state":"started","version":"%s"}\\n' "$cosmosh_version"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$cosmosh_asset_url" -o "$bin" || cosmosh_fail download DOWNLOAD_FAILED "curl download failed"; elif command -v wget >/dev/null 2>&1; then wget -q -O "$bin" "$cosmosh_asset_url" || cosmosh_fail download DOWNLOAD_FAILED "wget download failed"; else cosmosh_fail download DOWNLOADER_NOT_FOUND "curl or wget is required"; fi
printf '{"type":"bootstrap-status","phase":"verify","state":"started","version":"%s"}\\n' "$cosmosh_version"
if command -v sha256sum >/dev/null 2>&1; then printf '%s  %s\\n' "$cosmosh_sha256" "$bin" | sha256sum -c - >/dev/null || cosmosh_fail verify CHECKSUM_MISMATCH "sha256sum verification failed"; elif command -v shasum >/dev/null 2>&1; then printf '%s  %s\\n' "$cosmosh_sha256" "$bin" | shasum -a 256 -c - >/dev/null || cosmosh_fail verify CHECKSUM_MISMATCH "shasum verification failed"; else cosmosh_fail verify HASH_TOOL_NOT_FOUND "sha256sum or shasum is required"; fi
chmod 700 "$bin"
printf '{"type":"bootstrap-status","phase":"install","state":"started","version":"%s"}\\n' "$cosmosh_version"
"$bin" install --shell "$cosmosh_shell" --version "$cosmosh_version"
`;
};

const buildFishWrapper = (config: { shell: string; version: string; url: string; sha256: string }): string => {
  const shell = quoteFishShell(config.shell);
  const version = quoteFishShell(config.version);
  const url = quoteFishShell(config.url);
  const sha256 = quoteFishShell(config.sha256);

  return `function cosmosh_fail
  printf '{"type":"bootstrap-status","phase":"%s","state":"failed","version":"%s","code":"%s","message":"%s"}\\n' $argv[1] "$cosmosh_version" $argv[2] $argv[3]
  exit 1
end
set cosmosh_shell ${shell}
set cosmosh_version ${version}
set cosmosh_asset_url ${url}
set cosmosh_sha256 ${sha256}
if not command -q mktemp
  cosmosh_fail download MKTEMP_NOT_FOUND "mktemp is required"
end
set tmpdir "$TMPDIR"
if test -z "$tmpdir"
  set tmpdir /tmp
end
umask 077
set tmp (mktemp -d "$tmpdir/cosmosh-bootstrap.XXXXXX"); or cosmosh_fail download MKTEMP_FAILED "mktemp failed"
function cosmosh_cleanup --on-event fish_exit
  rm -rf "$tmp"
end
set bin "$tmp/cosmosh-bootstrap"
printf '{"type":"bootstrap-status","phase":"download","state":"started","version":"%s"}\\n' "$cosmosh_version"
if command -q curl
  curl -fsSL "$cosmosh_asset_url" -o "$bin"; or cosmosh_fail download DOWNLOAD_FAILED "curl download failed"
else if command -q wget
  wget -q -O "$bin" "$cosmosh_asset_url"; or cosmosh_fail download DOWNLOAD_FAILED "wget download failed"
else
  cosmosh_fail download DOWNLOADER_NOT_FOUND "curl or wget is required"
end
printf '{"type":"bootstrap-status","phase":"verify","state":"started","version":"%s"}\\n' "$cosmosh_version"
if command -q sha256sum
  printf '%s  %s\\n' "$cosmosh_sha256" "$bin" | sha256sum -c - >/dev/null; or cosmosh_fail verify CHECKSUM_MISMATCH "sha256sum verification failed"
else if command -q shasum
  printf '%s  %s\\n' "$cosmosh_sha256" "$bin" | shasum -a 256 -c - >/dev/null; or cosmosh_fail verify CHECKSUM_MISMATCH "shasum verification failed"
else
  cosmosh_fail verify HASH_TOOL_NOT_FOUND "sha256sum or shasum is required"
end
chmod 700 "$bin"
printf '{"type":"bootstrap-status","phase":"install","state":"started","version":"%s"}\\n' "$cosmosh_version"
"$bin" install --shell "$cosmosh_shell" --version "$cosmosh_version"
`;
};

/**
 * Converts arbitrary data into a POSIX single-quoted shell literal.
 *
 * @param value Data to embed in shell source.
 * @returns Literal that evaluates back to the original value without command evaluation.
 */
const quotePosixShell = (value: string): string => {
  return `'${value.replace(/'/g, "'\\''")}'`;
};

/**
 * Converts arbitrary data into a fish single-quoted shell literal.
 *
 * @param value Data to embed in fish source.
 * @returns Literal that evaluates back to the original value without command evaluation.
 */
const quoteFishShell = (value: string): string => {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

const parseStatusLines = (output: string | null): RemoteBootstrapStatus[] => {
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => parseStatusLine(line))
    .filter((status): status is RemoteBootstrapStatus => status !== null);
};

const parseStatusLine = (line: string): RemoteBootstrapStatus | null => {
  const parsed = parseJsonObject(line);
  if (!parsed || parsed.type !== 'bootstrap-status') {
    return null;
  }

  if (!isPhase(parsed.phase) || !isState(parsed.state)) {
    return null;
  }

  return {
    type: 'bootstrap-status',
    phase: parsed.phase,
    state: parsed.state,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    code: typeof parsed.code === 'string' ? parsed.code : undefined,
    message: typeof parsed.message === 'string' ? parsed.message : undefined,
  };
};

const parseLastJsonObject = (output: string): Record<string, unknown> | null => {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonObject(lines[index] ?? '');
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isPhase = (value: unknown): value is RemoteBootstrapPhase => {
  return value === 'probe' || value === 'manifest' || value === 'download' || value === 'install' || value === 'verify';
};

const isState = (value: unknown): value is RemoteBootstrapState => {
  return value === 'started' || value === 'ok' || value === 'skipped' || value === 'failed';
};
