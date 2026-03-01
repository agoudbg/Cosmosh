import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createI18n, type Locale } from '@cosmosh/i18n';
import { type IPty, spawn as spawnPty } from 'node-pty';
import { type RawData } from 'ws';

import { BaseTerminalSessionService, type TerminalManagedSessionBase } from '../terminal/base-session-service.js';
import { localizeTerminalCompletionItems, resolveTerminalCompletions } from '../terminal/completion/engine.js';
import {
  clampTerminalSize,
  computeHistorySyncDelayMs,
  mergeTerminalRecentCommands,
  normalizeTerminalClientMessage,
  parseTerminalHistoryOutput,
  TERMINAL_HISTORY_MAX_ENTRIES,
  TERMINAL_TELEMETRY_INTERVAL_MS,
  updateInteractiveCompletionState,
} from '../terminal/shared.js';

const execFileAsync = promisify(execFile);
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

type ServerOutboundMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'exit';
      reason: string;
    }
  | {
      type: 'pong';
    }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
      recentCommands: string[];
    }
  | {
      type: 'completion-response';
      requestId: string;
      replacePrefixLength: number;
      items: Array<{
        id: string;
        label: string;
        insertText: string;
        detail: string | null;
        source: 'history' | 'inshellisense';
        kind: 'command' | 'subcommand' | 'option' | 'history';
        score: number;
      }>;
    };

type LocalLiveSession = TerminalManagedSessionBase & {
  profileId: string;
  pty: IPty;
  telemetryInterval: NodeJS.Timeout | null;
  historySyncTimeout: NodeJS.Timeout | null;
  historySyncInFlight: boolean;
  historySyncPending: boolean;
  lastHistorySyncStartedAtMs: number;
  recentCommands: string[];
  completionLineBuffer: string;
  completionRecentCommands: string[];
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

  const profiles: LocalTerminalProfile[] = [];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync('where', [candidate.command]);
      const firstMatch = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (!firstMatch) {
        continue;
      }

      profiles.push({
        ...candidate,
        executablePath: firstMatch,
      });
    } catch {
      // Skip unavailable terminal profile.
    }
  }

  return profiles;
};

const resolveUnixProfiles = async (): Promise<LocalTerminalProfile[]> => {
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
    const i18n = createI18n({ locale: input.locale, scope: 'backend', fallbackLocale: 'en' });
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
      attachTimeout,
      telemetryInterval: null,
      historySyncTimeout: null,
      historySyncInFlight: false,
      historySyncPending: false,
      lastHistorySyncStartedAtMs: 0,
      recentCommands: [],
      completionLineBuffer: '',
      completionRecentCommands: [],
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
      const interactiveState = {
        lineBuffer: session.completionLineBuffer,
        recentCommands: session.completionRecentCommands,
      };
      updateInteractiveCompletionState(interactiveState, message.data, {
        maxEntries: TERMINAL_HISTORY_MAX_ENTRIES,
      });
      session.completionLineBuffer = interactiveState.lineBuffer;
      session.completionRecentCommands = interactiveState.recentCommands;

      if (/\r|\n/.test(message.data)) {
        this.scheduleHistorySync(session.sessionId);
      }
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

    if (message.type === 'history-delete') {
      const command = message.command.trim();
      if (!command) {
        return;
      }

      void this.deleteLocalHistoryEntry(session, command);
      return;
    }

    if (message.type === 'completion-request') {
      const completionResult = resolveTerminalCompletions(
        {
          linePrefix: message.linePrefix,
          cursorIndex: message.cursorIndex,
          limit: message.limit,
          fuzzyMatch: message.fuzzyMatch,
          trigger: message.trigger,
        },
        {
          recentCommands: session.completionRecentCommands,
        },
      );

      this.sendServerMessage(session, {
        type: 'completion-response',
        requestId: message.requestId,
        replacePrefixLength: completionResult.replacePrefixLength,
        items: localizeTerminalCompletionItems(completionResult.items, (key) => session.t(key)),
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
    this.scheduleHistorySync(sessionId, { immediate: true });
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
      recentCommands: [...session.recentCommands],
    });
  }

  private scheduleHistorySync(sessionId: string, options?: { immediate?: boolean }): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    if (session.historySyncTimeout) {
      clearTimeout(session.historySyncTimeout);
      session.historySyncTimeout = null;
    }

    const now = Date.now();
    // Debounce avoids refresh per keystroke, while throttle avoids repeated filesystem scans.
    const delayMs = computeHistorySyncDelayMs(session.lastHistorySyncStartedAtMs, now, options);

    session.historySyncTimeout = setTimeout(() => {
      session.historySyncTimeout = null;
      void this.syncLocalHistory(sessionId);
    }, delayMs);
  }

  private async syncLocalHistory(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    if (session.historySyncInFlight) {
      session.historySyncPending = true;
      return;
    }

    session.historySyncInFlight = true;
    session.lastHistorySyncStartedAtMs = Date.now();

    try {
      session.recentCommands = await this.readLocalHistory(session);
      session.completionRecentCommands = mergeTerminalRecentCommands(
        session.recentCommands,
        session.completionRecentCommands,
      );
      this.sendTelemetry(sessionId);
    } finally {
      session.historySyncInFlight = false;

      if (session.historySyncPending) {
        session.historySyncPending = false;
        this.scheduleHistorySync(sessionId);
      }
    }
  }

  private async readLocalHistory(session: LocalLiveSession): Promise<string[]> {
    const candidateFiles = this.resolveLocalHistoryFiles(session.profileId);
    const chunks: string[] = [];

    for (const filePath of candidateFiles) {
      if (!filePath) {
        continue;
      }

      try {
        const content = await readFile(filePath, 'utf8');
        chunks.push(content);
      } catch {
        // Ignore missing or inaccessible history files.
      }
    }

    if (chunks.length === 0) {
      return [];
    }

    return this.parseHistoryOutput(chunks.join('\n'));
  }

  private resolveLocalHistoryFiles(profileId: string): string[] {
    const homeDirectory = os.homedir();
    const appData = process.env.APPDATA || '';
    const candidates = new Set<string>();

    candidates.add(path.join(homeDirectory, '.bash_history'));
    candidates.add(path.join(homeDirectory, '.zsh_history'));
    candidates.add(path.join(homeDirectory, '.ash_history'));
    candidates.add(path.join(homeDirectory, '.sh_history'));
    candidates.add(path.join(homeDirectory, '.mksh_history'));
    candidates.add(path.join(homeDirectory, '.ksh_history'));
    candidates.add(path.join(homeDirectory, '.local', 'share', 'fish', 'fish_history'));

    if (profileId === 'pwsh' || profileId === 'windows-powershell') {
      candidates.add(path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'));
    }

    return [...candidates];
  }

  private parseHistoryOutput(output: string): string[] {
    return parseTerminalHistoryOutput(output);
  }

  private async deleteLocalHistoryEntry(session: LocalLiveSession, command: string): Promise<void> {
    const candidateFiles = this.resolveLocalHistoryFiles(session.profileId);
    await Promise.all(candidateFiles.map(async (filePath) => this.deleteFromHistoryFile(filePath, command)));

    session.recentCommands = session.recentCommands.filter((entry) => entry !== command);
    session.completionRecentCommands = session.completionRecentCommands.filter((entry) => entry !== command);
    this.sendTelemetry(session.sessionId);
    this.scheduleHistorySync(session.sessionId, { immediate: true });
  }

  private async deleteFromHistoryFile(filePath: string, command: string): Promise<void> {
    if (!filePath) {
      return;
    }

    try {
      const original = await readFile(filePath, 'utf8');
      const lines = original.split(/\r?\n/);
      const keptLines = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }

        if (trimmed === command) {
          return false;
        }

        const zshExtendedMatch = /^:\s*\d+:\d+;(.*)$/.exec(trimmed);
        if (zshExtendedMatch) {
          return (zshExtendedMatch[1]?.trim() ?? '') !== command;
        }

        return true;
      });

      await writeFile(filePath, keptLines.join('\n'), 'utf8');
    } catch {
      // Ignore files that cannot be edited on current platform/profile.
    }
  }
}
