import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createI18n, type I18nInstance, type Locale } from '@cosmosh/i18n';
import { type IPty, spawn as spawnPty } from 'node-pty';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const TELEMETRY_INTERVAL_MS = 5_000;
const HISTORY_REFRESH_DEBOUNCE_MS = 120;
const HISTORY_REFRESH_THROTTLE_MS = 450;
const HISTORY_MAX_ENTRIES = 200;

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

type ClientInboundMessage =
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'close';
    }
  | {
      type: 'ping';
    }
  | {
      type: 'history-delete';
      command: string;
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
    };

type LocalLiveSession = {
  sessionId: string;
  profileId: string;
  websocketToken: string;
  pty: IPty;
  pendingOutput: string[];
  attachTimeout: NodeJS.Timeout;
  telemetryInterval: NodeJS.Timeout | null;
  historySyncTimeout: NodeJS.Timeout | null;
  historySyncInFlight: boolean;
  historySyncPending: boolean;
  lastHistorySyncStartedAtMs: number;
  recentCommands: string[];
  t: I18nInstance['t'];
  socket: WebSocket | null;
  disposed: boolean;
};

/**
 * Clamps PTY size values to safe terminal bounds.
 */
const toShellSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
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

/**
 * Normalizes WebSocket payload into typed client message contract.
 */
const normalizeMessage = (payload: RawData): ClientInboundMessage | null => {
  try {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (parsed.type === 'input' && typeof parsed.data === 'string') {
      return { type: 'input', data: parsed.data };
    }

    if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
      return {
        type: 'resize',
        cols: parsed.cols,
        rows: parsed.rows,
      };
    }

    if (parsed.type === 'close') {
      return { type: 'close' };
    }

    if (parsed.type === 'ping') {
      return { type: 'ping' };
    }

    if (parsed.type === 'history-delete' && typeof parsed.command === 'string') {
      return {
        type: 'history-delete',
        command: parsed.command,
      };
    }

    return null;
  } catch {
    return null;
  }
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
 */
export class LocalTerminalSessionService {
  private readonly sessions = new Map<string, LocalLiveSession>();

  private readonly websocketServer: WebSocketServer;

  private readonly websocketBaseUrl: string;

  constructor(options: { host: string; port: number }) {
    this.websocketServer = new WebSocketServer({
      host: options.host,
      port: options.port,
    });

    this.websocketBaseUrl = `ws://${options.host}:${options.port}`;

    this.websocketServer.on('connection', (socket, request) => {
      const requestTranslator = createI18n({
        locale: String(request.headers['accept-language'] ?? 'en'),
        scope: 'backend',
        fallbackLocale: 'en',
      }).t;
      const requestUrl = new URL(request.url ?? '', this.websocketBaseUrl);
      const pathPrefix = '/ws/local-terminal/';

      if (!requestUrl.pathname.startsWith(pathPrefix)) {
        socket.close(1008, requestTranslator('ws.invalidWebsocketPath'));
        return;
      }

      const sessionId = decodeURIComponent(requestUrl.pathname.slice(pathPrefix.length));
      const token = requestUrl.searchParams.get('token') ?? '';
      const session = this.sessions.get(sessionId);

      if (!session || session.disposed || token !== session.websocketToken) {
        socket.close(
          1008,
          session ? session.t('ws.sessionInvalidOrExpired') : requestTranslator('ws.sessionInvalidOrExpired'),
        );
        return;
      }

      if (session.socket && session.socket.readyState === session.socket.OPEN) {
        session.socket.close(1012, session.t('ws.sessionReconnectedFromNewClient'));
      }

      session.socket = socket;
      clearTimeout(session.attachTimeout);
      this.sendServerMessage(session, { type: 'ready' });
      this.flushPendingOutput(session);

      socket.on('message', (payload) => {
        this.handleClientMessage(session, payload);
      });

      socket.on('close', () => {
        if (session.disposed) {
          return;
        }

        this.disposeSession(session.sessionId, 'ws.websocketDisconnected');
      });

      socket.on('error', () => {
        if (session.disposed) {
          return;
        }

        this.disposeSession(session.sessionId, 'ws.websocketTransportError');
      });
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

    const cols = toShellSize(input.cols, 120, 20, 400);
    const rows = toShellSize(input.rows, 32, 10, 200);
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

    this.sessions.set(sessionId, session);
    this.startSessionTelemetry(sessionId);

    return {
      type: 'success',
      sessionId,
      profileId: targetProfile.id,
      websocketUrl: `${this.websocketBaseUrl}/ws/local-terminal/${encodeURIComponent(sessionId)}`,
      websocketToken,
    };
  }

  public closeSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) {
      return false;
    }

    this.disposeSession(sessionId, 'ws.sessionClosedByApiRequest');
    return true;
  }

  public async stop(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      this.disposeSession(sessionId, 'ws.backendShutdown');
    }

    await new Promise<void>((resolve, reject) => {
      this.websocketServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private sendServerMessage(session: LocalLiveSession, payload: ServerOutboundMessage): void {
    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      if (payload.type === 'output') {
        session.pendingOutput.push(payload.data);
      }
      return;
    }

    session.socket.send(JSON.stringify(payload));
  }

  private flushPendingOutput(session: LocalLiveSession): void {
    while (session.pendingOutput.length > 0) {
      const data = session.pendingOutput.shift();
      if (!data) {
        continue;
      }

      this.sendServerMessage(session, {
        type: 'output',
        data,
      });
    }
  }

  private handleClientMessage(session: LocalLiveSession, rawPayload: RawData): void {
    const message = normalizeMessage(rawPayload);

    if (!message) {
      this.sendServerMessage(session, {
        type: 'error',
        message: session.t('ws.invalidWebsocketMessageFormat'),
      });
      return;
    }

    if (message.type === 'input') {
      if (/\r|\n/.test(message.data)) {
        this.scheduleHistorySync(session.sessionId);
      }
      session.pty.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = toShellSize(message.cols, 120, 20, 400);
      const rows = toShellSize(message.rows, 32, 10, 200);
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

    this.disposeSession(session.sessionId, 'ws.clientRequestedClose');
  }

  private disposeSession(
    sessionId: string,
    reasonKey: string,
    reasonParams?: Record<string, string | number | boolean>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    const reason = session.t(reasonKey, reasonParams);

    session.disposed = true;
    this.sessions.delete(sessionId);
    clearTimeout(session.attachTimeout);

    if (session.telemetryInterval) {
      clearInterval(session.telemetryInterval);
      session.telemetryInterval = null;
    }

    if (session.historySyncTimeout) {
      clearTimeout(session.historySyncTimeout);
      session.historySyncTimeout = null;
    }

    this.sendServerMessage(session, {
      type: 'exit',
      reason,
    });

    try {
      session.pty.kill();
    } catch {
      // Ignore PTY close race errors.
    }

    if (session.socket && session.socket.readyState === session.socket.OPEN) {
      session.socket.close(1000, reason);
    }

    session.socket = null;
  }

  private startSessionTelemetry(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.telemetryInterval = setInterval(() => {
      this.sendTelemetry(sessionId);
    }, TELEMETRY_INTERVAL_MS);

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
    const throttleRemaining = Math.max(0, HISTORY_REFRESH_THROTTLE_MS - (now - session.lastHistorySyncStartedAtMs));
    const baseDelayMs = options?.immediate ? 0 : HISTORY_REFRESH_DEBOUNCE_MS;
    const delayMs = Math.max(baseDelayMs, throttleRemaining);

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
    const lines = output.split(/\r?\n/);
    const parsedCommands: string[] = [];

    for (const line of lines) {
      const command = this.parseHistoryLine(line);
      if (!command) {
        continue;
      }

      parsedCommands.push(command);
    }

    const deduplicated: string[] = [];
    const seen = new Set<string>();

    for (let index = parsedCommands.length - 1; index >= 0; index -= 1) {
      const command = parsedCommands[index];
      if (seen.has(command)) {
        continue;
      }

      seen.add(command);
      deduplicated.push(command);

      if (deduplicated.length >= HISTORY_MAX_ENTRIES) {
        break;
      }
    }

    return deduplicated.reverse();
  }

  private parseHistoryLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    if (/^#[0-9]{9,}$/.test(trimmed)) {
      return null;
    }

    if (trimmed.startsWith('- cmd: ')) {
      const fishCommand = trimmed.slice(7).replace(/\\n/g, '\n').trim();
      return fishCommand.length > 0 ? fishCommand : null;
    }

    const zshExtendedMatch = /^:\s*\d+:\d+;(.*)$/.exec(trimmed);
    if (zshExtendedMatch) {
      const zshCommand = zshExtendedMatch[1]?.trim() ?? '';
      return zshCommand.length > 0 ? zshCommand : null;
    }

    const numberedHistoryMatch = /^\s*\d+\*?\s+(.*)$/.exec(trimmed);
    if (numberedHistoryMatch) {
      const command = numberedHistoryMatch[1]?.trim() ?? '';
      return command.length > 0 ? command : null;
    }

    if (/^(when|paths?|exit|cwd):\s*/i.test(trimmed)) {
      return null;
    }

    return trimmed;
  }

  private async deleteLocalHistoryEntry(session: LocalLiveSession, command: string): Promise<void> {
    const candidateFiles = this.resolveLocalHistoryFiles(session.profileId);
    await Promise.all(candidateFiles.map(async (filePath) => this.deleteFromHistoryFile(filePath, command)));

    session.recentCommands = session.recentCommands.filter((entry) => entry !== command);
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
