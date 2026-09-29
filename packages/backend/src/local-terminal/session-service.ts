import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TerminalServerMessage } from '@cosmosh/api-contract';
import { type IPty, spawn as spawnPty } from 'node-pty';
import { type RawData } from 'ws';

import { createI18n, type Locale } from '../i18n-bridge.js';
import { BaseTerminalSessionService, type TerminalManagedSessionBase } from '../terminal/base-session-service.js';
import { unavailableCompletionUpdate } from '../terminal/completion/snapshot-completion.js';
import {
  clampTerminalSize,
  normalizeTerminalClientMessage,
  TERMINAL_TELEMETRY_INTERVAL_MS,
} from '../terminal/shared.js';

const execFileAsync = promisify(execFile);
const WINDOWS_PROFILE_DISCOVERY_TIMEOUT_MS = 1200;
const LOCAL_PROFILE_CACHE_TTL_MS = 60_000;

let windowsProfilesCache: { expiresAt: number; profiles: LocalTerminalProfile[] } | null = null;
let unixProfilesCache: { expiresAt: number; profiles: LocalTerminalProfile[] } | null = null;

/**
 * Describes an available local shell profile that can be launched as PTY session.
 */
export type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  args: string[];
};

type CreateLocalTerminalSessionInput = {
  locale: Locale;
  profileId: string;
  cols: number;
  rows: number;
  term: string;
  cwd?: string;
};

type CreateLocalTerminalSessionResult =
  | {
      type: 'success';
      sessionId: string;
      profileId: string;
      websocketUrl: string;
      websocketToken: string;
    }
  | {
      type: 'not-found';
    }
  | {
      type: 'failed';
      message: string;
    };

type ServerOutboundMessage = TerminalServerMessage;

type LocalLiveSession = TerminalManagedSessionBase & {
  profileId: string;
  pty: IPty;
  telemetryInterval: NodeJS.Timeout | null;
  historySyncTimeout: NodeJS.Timeout | null;
};

/**
 * Resolves launch cwd for local terminal sessions.
 * Accepts either directory or file path and falls back to user home when invalid.
 */
const resolveSessionWorkingDirectory = async (cwdCandidate?: string): Promise<string> => {
  const requestedPath = cwdCandidate?.trim() || '';

  if (!requestedPath) {
    return os.homedir();
  }

  const normalizedPath = path.resolve(requestedPath);

  try {
    const stats = await stat(normalizedPath);
    if (stats.isDirectory()) {
      return normalizedPath;
    }

    if (stats.isFile()) {
      return path.dirname(normalizedPath);
    }
  } catch {
    // Ignore invalid cwd and fallback to home directory.
  }

  return os.homedir();
};

const resolveWindowsProfiles = async (): Promise<LocalTerminalProfile[]> => {
  const candidates: Array<{ id: string; name: string; command: string; args: string[] }> = [
    { id: 'cmd', name: 'CMD', command: 'cmd.exe', args: ['/Q'] },
    { id: 'pwsh', name: 'PowerShell', command: 'pwsh.exe', args: ['-NoLogo'] },
    { id: 'windows-powershell', name: 'Windows PowerShell', command: 'powershell.exe', args: ['-NoLogo'] },
    { id: 'wsl', name: 'WSL', command: 'wsl.exe', args: [] },
  ];

  const now = Date.now();
  if (windowsProfilesCache && windowsProfilesCache.expiresAt > now) {
    return windowsProfilesCache.profiles;
  }

  const profileProbes = candidates.map(async (candidate): Promise<LocalTerminalProfile | null> => {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('where lookup timeout'));
        }, WINDOWS_PROFILE_DISCOVERY_TIMEOUT_MS);

        void execFileAsync('where', [candidate.command])
          .then((result) => {
            clearTimeout(timeoutId);
            resolve(result.stdout);
          })
          .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      });

      const firstMatch = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (!firstMatch) {
        return null;
      }

      return {
        ...candidate,
        executablePath: firstMatch,
      };
    } catch {
      return null;
    }
  });

  const profiles = (await Promise.all(profileProbes)).filter((profile): profile is LocalTerminalProfile => {
    return profile !== null;
  });

  windowsProfilesCache = {
    expiresAt: now + LOCAL_PROFILE_CACHE_TTL_MS,
    profiles,
  };

  return profiles;
};

const resolveUnixProfiles = async (): Promise<LocalTerminalProfile[]> => {
  const now = Date.now();
  if (unixProfilesCache && unixProfilesCache.expiresAt > now) {
    return unixProfilesCache.profiles;
  }

  let content: string;

  try {
    content = await readFile('/etc/shells', 'utf8');
  } catch {
    return [];
  }

  const profiles: LocalTerminalProfile[] = [];
  const usedIds = new Set<string>();
  const lines = content.split(/\r?\n/).map((line) => line.trim());

  for (const line of lines) {
    if (!line || line.startsWith('#') || !line.startsWith('/')) {
      continue;
    }

    if (line.includes('nologin') || line.includes('false')) {
      continue;
    }

    try {
      await access(line);
    } catch {
      continue;
    }

    const baseName = path.basename(line);
    let profileId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    if (!profileId) {
      profileId = `shell-${profiles.length + 1}`;
    }

    if (usedIds.has(profileId)) {
      profileId = `${profileId}-${profiles.length + 1}`;
    }

    usedIds.add(profileId);
    profiles.push({
      id: profileId,
      name: baseName,
      command: line,
      executablePath: line,
      args: ['-i'],
    });
  }

  unixProfilesCache = {
    expiresAt: now + LOCAL_PROFILE_CACHE_TTL_MS,
    profiles,
  };

  return profiles;
};

/**
 * Local terminal session orchestrator:
 * - resolves available terminal profiles
 * - manages PTY lifecycle
 * - bridges WS <-> PTY streams
 *
 * Layering note:
 * - BaseTerminalSessionService handles generic socket lifecycle.
 * - This class owns host-local responsibilities (profile discovery, cwd resolution, history file edits).
 */
export class LocalTerminalSessionService extends BaseTerminalSessionService<LocalLiveSession, ServerOutboundMessage> {
  constructor(options: { host: string; port: number }) {
    super({
      host: options.host,
      port: options.port,
      pathPrefix: '/ws/local-terminal/',
    });
  }

  public async listProfiles(): Promise<LocalTerminalProfile[]> {
    if (process.platform === 'win32') {
      return await resolveWindowsProfiles();
    }

    return await resolveUnixProfiles();
  }

  public async createSession(input: CreateLocalTerminalSessionInput): Promise<CreateLocalTerminalSessionResult> {
    const i18n = createI18n({ locale: input.locale, fallbackLocale: 'en' });
    const profiles = await this.listProfiles();
    const targetProfile = profiles.find((profile) => profile.id === input.profileId);

    if (!targetProfile) {
      return { type: 'not-found' };
    }

    const cols = clampTerminalSize(input.cols, 120, 20, 400);
    const rows = clampTerminalSize(input.rows, 32, 10, 200);
    const workingDirectory = await resolveSessionWorkingDirectory(input.cwd);

    let pty: IPty;

    try {
      pty = spawnPty(targetProfile.command, targetProfile.args, {
        name: input.term?.trim() || 'xterm-256color',
        cwd: workingDirectory,
        env: {
          ...process.env,
          TERM: input.term?.trim() || 'xterm-256color',
        },
        cols,
        rows,
      });
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: error instanceof Error ? error.message : i18n.t('errors.localTerminal.processStartFailed'),
      };
    }

    const sessionId = randomUUID();
    const websocketToken = randomBytes(24).toString('hex');
    const pendingOutput: string[] = [];

    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'ws.websocketConnectionTimeout');
    }, 30_000);

    const session: LocalLiveSession = {
      sessionId,
      profileId: targetProfile.id,
      websocketToken,
      pty,
      pendingOutput,
      pendingOutputBytes: 0,
      pendingOutputDropCount: 0,
      attachTimeout,
      telemetryInterval: null,
      historySyncTimeout: null,
      t: i18n.t,
      socket: null,
      disposed: false,
    };

    pty.onData((data) => {
      this.sendServerMessage(session, { type: 'output', data });
    });

    pty.onExit(({ exitCode, signal }) => {
      if (Number.isFinite(exitCode)) {
        this.disposeSession(sessionId, 'ws.localTerminalExitedWithCode', { code: exitCode });
        return;
      }

      this.disposeSession(sessionId, 'ws.localTerminalExitedWithSignal', { signal: String(signal) });
    });

    this.registerSession(session);
    this.startSessionTelemetry(sessionId);

    return {
      type: 'success',
      sessionId,
      profileId: targetProfile.id,
      websocketUrl: `${this.websocketBaseUrl}/ws/local-terminal/${encodeURIComponent(sessionId)}`,
      websocketToken,
    };
  }

  protected onSessionAttached(session: LocalLiveSession): void {
    // Reattached clients must receive ready signal first, then buffered PTY output.
    this.sendServerMessage(session, { type: 'ready' });
    this.flushPendingOutput(session, (data) => ({
      type: 'output',
      data,
    }));
  }

  protected handleClientMessage(session: LocalLiveSession, rawPayload: RawData): void {
    const message = normalizeTerminalClientMessage(rawPayload);

    if (!message) {
      this.sendServerMessage(session, {
        type: 'error',
        message: session.t('ws.invalidWebsocketMessageFormat'),
      });
      return;
    }

    if (message.type === 'input') {
      // Local PTYs have the same password/program boundary as SSH. Raw input is
      // transport data, never a substitute for the Shell's own command history.
      session.pty.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = clampTerminalSize(message.cols, 120, 20, 400);
      const rows = clampTerminalSize(message.rows, 32, 10, 200);
      session.pty.resize(cols, rows);
      return;
    }

    if (message.type === 'ping') {
      this.sendServerMessage(session, { type: 'pong' });
      return;
    }

    if (message.type === 'credential-fill') {
      this.sendServerMessage(session, {
        type: 'credential-fill-result',
        token: message.token,
        status: 'rejected',
        reason: 'unavailable',
      });
      return;
    }

    if (message.type === 'completion-query') {
      this.sendOptionalServerMessage(session, unavailableCompletionUpdate(message.requestId, 0));
      return;
    }
    if (message.type === 'completion-accept') {
      this.sendOptionalServerMessage(session, {
        type: 'completion-accept-result',
        requestId: message.requestId,
        status: 'unavailable',
      });
      return;
    }
    if (message.type === 'completion-cancel' || message.type === 'directory-cancel') return;
    if (message.type === 'directory-query') {
      this.sendOptionalServerMessage(session, {
        type: 'directory-result',
        requestId: message.requestId,
        status: 'unavailable',
        contextRevision: 0,
        directory: null,
      });
      return;
    }

    if (message.type === 'shell-history-remove') {
      this.sendOptionalServerMessage(session, {
        type: 'error',
        message: session.t('ws.invalidWebsocketMessageFormat'),
      });
      return;
    }

    this.disposeSession(session.sessionId, 'ws.clientRequestedClose');
  }

  protected disposeSession(
    sessionId: string,
    reasonKey: string,
    reasonParams?: Record<string, string | number | boolean>,
  ): void {
    this.disposeSessionWithCommonLifecycle(sessionId, reasonKey, reasonParams, {
      createExitMessage: (reason) => ({
        type: 'exit',
        reason,
      }),
      disposeTransport: (session) => {
        // Emit exit to frontend before killing PTY so UI receives terminal reason reliably.
        try {
          session.pty.kill();
        } catch {
          // Ignore PTY close race errors.
        }
      },
    });
  }

  private startSessionTelemetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.telemetryInterval = setInterval(() => {
      this.sendTelemetry(sessionId);
    }, TERMINAL_TELEMETRY_INTERVAL_MS);

    this.sendTelemetry(sessionId);
  }

  private sendTelemetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    this.sendServerMessage(session, {
      type: 'telemetry',
      cpuUsagePercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      networkRxBytesPerSec: null,
      networkTxBytesPerSec: null,
      recentCommands: [],
    });
  }
}
