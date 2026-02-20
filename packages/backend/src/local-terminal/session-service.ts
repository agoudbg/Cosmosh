import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { type IPty, spawn as spawnPty } from 'node-pty';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

const execFileAsync = promisify(execFile);
const TELEMETRY_INTERVAL_MS = 5_000;

export type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  args: string[];
};

type CreateLocalTerminalSessionInput = {
  profileId: string;
  cols: number;
  rows: number;
  term: string;
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
  commandBuffer: string;
  recentCommands: string[];
  socket: WebSocket | null;
  disposed: boolean;
};

const toShellSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

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
      await execFileAsync('where', [candidate.command]);
      profiles.push(candidate);
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
      args: ['-i'],
    });
  }

  return profiles;
};

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
      const requestUrl = new URL(request.url ?? '', this.websocketBaseUrl);
      const pathPrefix = '/ws/local-terminal/';

      if (!requestUrl.pathname.startsWith(pathPrefix)) {
        socket.close(1008, 'Invalid websocket path.');
        return;
      }

      const sessionId = decodeURIComponent(requestUrl.pathname.slice(pathPrefix.length));
      const token = requestUrl.searchParams.get('token') ?? '';
      const session = this.sessions.get(sessionId);

      if (!session || session.disposed || token !== session.websocketToken) {
        socket.close(1008, 'Session is invalid or expired.');
        return;
      }

      if (session.socket && session.socket.readyState === session.socket.OPEN) {
        session.socket.close(1012, 'Session reconnected from a new client.');
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

        this.disposeSession(session.sessionId, 'WebSocket disconnected.');
      });

      socket.on('error', () => {
        if (session.disposed) {
          return;
        }

        this.disposeSession(session.sessionId, 'WebSocket transport error.');
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
    const profiles = await this.listProfiles();
    const targetProfile = profiles.find((profile) => profile.id === input.profileId);

    if (!targetProfile) {
      return { type: 'not-found' };
    }

    const cols = toShellSize(input.cols, 120, 20, 400);
    const rows = toShellSize(input.rows, 32, 10, 200);

    let pty: IPty;

    try {
      pty = spawnPty(targetProfile.command, targetProfile.args, {
        name: input.term?.trim() || 'xterm-256color',
        cwd: os.homedir(),
        env: {
          ...process.env,
          TERM: input.term?.trim() || 'xterm-256color',
        },
        cols,
        rows,
        windowsHide: true,
      });
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: error instanceof Error ? error.message : 'Failed to start local terminal process.',
      };
    }

    const sessionId = randomUUID();
    const websocketToken = randomBytes(24).toString('hex');
    const pendingOutput: string[] = [];

    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'WebSocket connection timeout.');
    }, 30_000);

    const session: LocalLiveSession = {
      sessionId,
      profileId: targetProfile.id,
      websocketToken,
      pty,
      pendingOutput,
      attachTimeout,
      telemetryInterval: null,
      commandBuffer: '',
      recentCommands: [],
      socket: null,
      disposed: false,
    };

    pty.onData((data) => {
      this.sendServerMessage(session, { type: 'output', data });
    });

    pty.onExit(({ exitCode, signal }) => {
      const reason = Number.isFinite(exitCode)
        ? `Local terminal exited with code ${exitCode}.`
        : `Local terminal exited (${String(signal)}).`;
      this.disposeSession(sessionId, reason);
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

    this.disposeSession(sessionId, 'Session closed by API request.');
    return true;
  }

  public async stop(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      this.disposeSession(sessionId, 'Backend shutdown.');
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
        message: 'Invalid websocket message format.',
      });
      return;
    }

    if (message.type === 'input') {
      this.captureCommandInput(session, message.data);
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

    this.disposeSession(session.sessionId, 'Client requested close.');
  }

  private disposeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    session.disposed = true;
    this.sessions.delete(sessionId);
    clearTimeout(session.attachTimeout);

    if (session.telemetryInterval) {
      clearInterval(session.telemetryInterval);
      session.telemetryInterval = null;
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

  private captureCommandInput(session: LocalLiveSession, inputData: string): void {
    for (const character of inputData) {
      if (character === '\r' || character === '\n') {
        const submitted = session.commandBuffer;
        session.commandBuffer = '';

        const command = submitted.trim();
        if (command.length > 0) {
          session.recentCommands.push(command);
        }
        continue;
      }

      if (character === '\u007f') {
        session.commandBuffer = session.commandBuffer.slice(0, -1);
        continue;
      }

      if (character === '\u0015') {
        session.commandBuffer = '';
        continue;
      }

      if (character >= ' ' && character !== '\u007f') {
        session.commandBuffer += character;

        if (session.commandBuffer.length > 512) {
          session.commandBuffer = session.commandBuffer.slice(-512);
        }
      }
    }
  }
}
