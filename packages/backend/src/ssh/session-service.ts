import { randomBytes, randomUUID } from 'node:crypto';

import { createI18n, type I18nInstance, type Locale } from '@cosmosh/i18n';
import type { PrismaClient, SshServer } from '@prisma/client';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { decryptSensitiveValue } from './crypto.js';

type GetDbClient = () => PrismaClient;

type CreateSshSessionInput = {
  locale: Locale;
  serverId: string;
  cols: number;
  rows: number;
  term: string;
  connectTimeoutSec: number;
};

type CreateSshSessionSuccess = {
  type: 'success';
  sessionId: string;
  serverId: string;
  websocketUrl: string;
  websocketToken: string;
};

type CreateSshSessionHostUntrusted = {
  type: 'host-untrusted';
  serverId: string;
  host: string;
  port: number;
  algorithm: 'sha256';
  fingerprint: string;
};

type CreateSshSessionFailure = {
  type: 'failed';
  message: string;
};

type CreateSshSessionResult =
  | CreateSshSessionSuccess
  | CreateSshSessionHostUntrusted
  | { type: 'not-found' }
  | CreateSshSessionFailure;

type TrustSshFingerprintInput = {
  serverId: string;
  fingerprintSha256: string;
  algorithm: string;
};

type TrustSshFingerprintResult = { type: 'success' } | { type: 'not-found' };

type OpenShellResult =
  | {
      type: 'ready';
      client: Client;
      stream: ClientChannel;
    }
  | {
      type: 'host-untrusted';
      fingerprint: string;
      message: string;
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
    }
  | {
      type: 'history';
      recentCommands: string[];
    };

type SshLiveSession = {
  sessionId: string;
  serverId: string;
  loginAuditId: string | null;
  websocketToken: string;
  client: Client;
  stream: ClientChannel;
  pendingOutput: string[];
  attachTimeout: NodeJS.Timeout;
  telemetryInterval: NodeJS.Timeout | null;
  lastNetworkSample: {
    rxBytesTotal: number;
    txBytesTotal: number;
    timestampMs: number;
  } | null;
  historySyncTimeout: NodeJS.Timeout | null;
  historySyncInFlight: boolean;
  historySyncPending: boolean;
  lastHistorySyncStartedAtMs: number;
  commandCount: number;
  recentCommands: string[];
  t: I18nInstance['t'];
  socket: WebSocket | null;
  disposed: boolean;
};

type ParsedRemoteTelemetry = {
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkRxBytesTotal: number;
  networkTxBytesTotal: number;
};

const TELEMETRY_INTERVAL_MS = 5_000;
const HISTORY_REFRESH_DEBOUNCE_MS = 120;
const HISTORY_REFRESH_THROTTLE_MS = 450;
const HISTORY_MAX_ENTRIES = 200;
// Leading whitespace intentionally avoids writing this command into shell history on most shells.
const TELEMETRY_COMMAND =
  ' sh -lc \'cpu=$(top -bn1 | awk -F"[, ]+" "/Cpu\\(s\\)|%Cpu\\(s\\)/ {for(i=1;i<=NF;i++){if($i==\\"id\\"){print 100-$(i-1); exit}}}"); if [ -z "$cpu" ]; then cpu=$(awk "/^cpu /{idle=$5;total=0;for(i=2;i<=NF;i++){total+=$i} if(total>0){print (total-idle)*100/total}else{print 0}}" /proc/stat); fi; mem=$(free -b | awk "/^Mem:/ {print \\$3 \\" \\" \\$2}"); net=$(awk "NR>2 {rx+=\\$2;tx+=\\$10} END {print rx \\" \\" tx}" /proc/net/dev); printf "%s\\n%s\\n%s\\n" "${cpu:-0}" "${mem:-0 0}" "${net:-0 0}"\'';
const REMOTE_HISTORY_FETCH_COMMAND =
  ' sh -lc \'set +e; if command -v history >/dev/null 2>&1; then history 2>/dev/null; fi; for file in "$HISTFILE" "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.ash_history" "$HOME/.sh_history" "$HOME/.mksh_history" "$HOME/.ksh_history" "$HOME/.local/share/fish/fish_history" "$HOME/.python_history" "$HOME/.sqlite_history" "$HOME/.mysql_history" "$HOME/.lesshst"; do if [ -n "$file" ] && [ -f "$file" ]; then cat "$file" 2>/dev/null; fi; done; if command -v pwsh >/dev/null 2>&1; then pwsh -NoLogo -NoProfile -Command "if (Get-Command Get-PSReadLineOption -ErrorAction SilentlyContinue) { $path=(Get-PSReadLineOption).HistorySavePath; if ($path -and (Test-Path $path)) { Get-Content -Path $path -ErrorAction SilentlyContinue } }" 2>/dev/null; fi; if command -v powershell >/dev/null 2>&1; then powershell -NoLogo -NoProfile -Command "if (Get-Command Get-PSReadLineOption -ErrorAction SilentlyContinue) { $path=(Get-PSReadLineOption).HistorySavePath; if ($path -and (Test-Path $path)) { Get-Content -Path $path -ErrorAction SilentlyContinue } }" 2>/dev/null; fi\'';

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
 * SSH session orchestrator:
 * - opens SSH shells
 * - bridges WS <-> SSH stream messages
 * - tracks telemetry and login audits
 */
export class SshSessionService {
  private readonly sessions = new Map<string, SshLiveSession>();

  private readonly websocketServer: WebSocketServer;

  private readonly websocketBaseUrl: string;

  private readonly getDbClient: GetDbClient;

  private readonly credentialEncryptionKey: Buffer;

  constructor(options: { host: string; port: number; getDbClient: GetDbClient; credentialEncryptionKey: Buffer }) {
    this.getDbClient = options.getDbClient;
    this.credentialEncryptionKey = options.credentialEncryptionKey;
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
      const pathPrefix = '/ws/ssh/';

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

  public getWebSocketBaseUrl(): string {
    return this.websocketBaseUrl;
  }

  public async createSession(input: CreateSshSessionInput): Promise<CreateSshSessionResult> {
    const i18n = createI18n({ locale: input.locale, scope: 'backend', fallbackLocale: 'en' });
    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: input.serverId,
      },
    });

    if (!server) {
      return { type: 'not-found' };
    }

    const trustedKeys = await db.sshKnownHost.findMany({
      where: {
        host: server.host,
        port: server.port,
        trusted: true,
        keyType: 'sha256',
      },
      select: {
        fingerprint: true,
      },
    });

    const trustedFingerprintSet = new Set(trustedKeys.map((item) => item.fingerprint));
    const pendingOutput: string[] = [];
    let liveSession: SshLiveSession | null = null;
    const shellResult = await this.openShell(server, {
      cols: input.cols,
      rows: input.rows,
      term: input.term,
      connectTimeoutSec: input.connectTimeoutSec,
      trustedFingerprintSet,
      t: i18n.t,
      onOutput: (data) => {
        if (liveSession) {
          this.sendServerMessage(liveSession, {
            type: 'output',
            data,
          });
          return;
        }

        pendingOutput.push(data);
      },
    });

    if (shellResult.type === 'host-untrusted') {
      await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message || 'Host fingerprint is not trusted.',
      });

      return {
        type: 'host-untrusted',
        serverId: server.id,
        host: server.host,
        port: server.port,
        algorithm: 'sha256',
        fingerprint: shellResult.fingerprint,
      };
    }

    if (shellResult.type === 'failed') {
      await this.createLoginAudit({
        serverId: server.id,
        result: 'failed',
        failureReason: shellResult.message,
      });

      return {
        type: 'failed',
        message: shellResult.message,
      };
    }

    const sessionId = randomUUID();
    const websocketToken = randomBytes(24).toString('hex');

    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'ws.websocketConnectionTimeout');
    }, 30_000);

    const loginAuditId = await this.createLoginAudit({
      serverId: server.id,
      result: 'success',
      sessionId,
      sessionStartedAt: new Date(),
    });

    liveSession = {
      sessionId,
      serverId: server.id,
      loginAuditId,
      websocketToken,
      client: shellResult.client,
      stream: shellResult.stream,
      pendingOutput,
      attachTimeout,
      telemetryInterval: null,
      lastNetworkSample: null,
      historySyncTimeout: null,
      historySyncInFlight: false,
      historySyncPending: false,
      lastHistorySyncStartedAtMs: 0,
      commandCount: 0,
      recentCommands: [],
      t: i18n.t,
      socket: null,
      disposed: false,
    };

    shellResult.stream.on('close', () => {
      this.disposeSession(sessionId, 'ws.sshStreamClosed');
    });

    shellResult.client.on('close', () => {
      this.disposeSession(sessionId, 'ws.sshConnectionClosed');
    });

    shellResult.client.on('error', (error: Error) => {
      this.sendServerMessage(liveSession, {
        type: 'error',
        message: error.message,
      });
      this.disposeSession(sessionId, 'ws.sshConnectionError');
    });

    this.sessions.set(sessionId, liveSession);
    this.startSessionTelemetry(sessionId);
    this.scheduleHistorySync(sessionId, { immediate: true });

    return {
      type: 'success',
      sessionId,
      serverId: server.id,
      websocketUrl: `${this.websocketBaseUrl}/ws/ssh/${encodeURIComponent(sessionId)}`,
      websocketToken,
    };
  }

  public async trustFingerprint(input: TrustSshFingerprintInput): Promise<TrustSshFingerprintResult> {
    const db = this.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: input.serverId,
      },
      select: {
        id: true,
        host: true,
        port: true,
      },
    });

    if (!server) {
      return { type: 'not-found' };
    }

    const existingKnownHost = await db.sshKnownHost.findFirst({
      where: {
        host: server.host,
        port: server.port,
        keyType: input.algorithm,
        fingerprint: input.fingerprintSha256,
      },
      select: {
        id: true,
      },
    });

    if (existingKnownHost) {
      await db.sshKnownHost.update({
        where: {
          id: existingKnownHost.id,
        },
        data: {
          trusted: true,
          keyType: input.algorithm,
        },
      });
      return { type: 'success' };
    }

    await db.sshKnownHost.create({
      data: {
        id: randomUUID(),
        host: server.host,
        port: server.port,
        keyType: input.algorithm,
        fingerprint: input.fingerprintSha256,
        trusted: true,
      },
    });

    return { type: 'success' };
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

  private sendServerMessage(session: SshLiveSession, payload: ServerOutboundMessage): void {
    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      if (payload.type === 'output') {
        session.pendingOutput.push(payload.data);
      }
      return;
    }

    session.socket.send(JSON.stringify(payload));
  }

  private flushPendingOutput(session: SshLiveSession): void {
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

  private handleClientMessage(session: SshLiveSession, rawPayload: RawData): void {
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
        const submittedInputCount = message.data.split(/\r\n|[\r\n]/).length - 1;
        session.commandCount += Math.max(1, submittedInputCount);
        this.scheduleHistorySync(session.sessionId);
      }
      session.stream.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = toShellSize(message.cols, 120, 20, 400);
      const rows = toShellSize(message.rows, 32, 10, 200);
      session.stream.setWindow(rows, cols, 0, 0);
      return;
    }

    if (message.type === 'ping') {
      this.sendServerMessage(session, { type: 'pong' });
      return;
    }

    if (message.type === 'history-delete') {
      void this.deleteRemoteHistoryEntry(session, message.command);
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

    void this.finalizeLoginAudit(session);

    this.sendServerMessage(session, {
      type: 'exit',
      reason,
    });

    try {
      session.stream.close();
    } catch {
      // Ignore stream close race errors.
    }

    try {
      session.client.end();
    } catch {
      // Ignore client close race errors.
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
      void this.collectAndSendTelemetry(sessionId);
    }, TELEMETRY_INTERVAL_MS);

    // Kick off once immediately so the UI gets values without waiting for the first interval.
    void this.collectAndSendTelemetry(sessionId);
  }

  private async collectAndSendTelemetry(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) {
      return;
    }

    const parsed = await this.readRemoteTelemetry(session);
    if (!parsed) {
      // Frontend renders explicit N/A placeholders when metrics are unavailable on the remote host.
      this.sendServerMessage(session, {
        type: 'telemetry',
        cpuUsagePercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        networkRxBytesPerSec: null,
        networkTxBytesPerSec: null,
        recentCommands: [...session.recentCommands],
      });
      return;
    }

    const now = Date.now();
    const networkRates = this.computeNetworkRates(session, parsed.networkRxBytesTotal, parsed.networkTxBytesTotal, now);

    this.sendServerMessage(session, {
      type: 'telemetry',
      cpuUsagePercent: parsed.cpuUsagePercent,
      memoryUsedBytes: parsed.memoryUsedBytes,
      memoryTotalBytes: parsed.memoryTotalBytes,
      networkRxBytesPerSec: networkRates.rxBytesPerSec,
      networkTxBytesPerSec: networkRates.txBytesPerSec,
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
    // Keep remote history refresh responsive while preventing bursty exec calls.
    const throttleRemaining = Math.max(0, HISTORY_REFRESH_THROTTLE_MS - (now - session.lastHistorySyncStartedAtMs));
    const baseDelayMs = options?.immediate ? 0 : HISTORY_REFRESH_DEBOUNCE_MS;
    const delayMs = Math.max(baseDelayMs, throttleRemaining);

    session.historySyncTimeout = setTimeout(() => {
      session.historySyncTimeout = null;
      void this.syncRemoteHistory(sessionId);
    }, delayMs);
  }

  private async syncRemoteHistory(sessionId: string): Promise<void> {
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
      const commands = await this.readRemoteHistory(session);
      if (!commands) {
        return;
      }

      // Remote history is the source of truth for the commands sidebar.
      session.recentCommands = commands;
      this.sendServerMessage(session, {
        type: 'history',
        recentCommands: [...session.recentCommands],
      });
    } finally {
      session.historySyncInFlight = false;

      if (session.historySyncPending) {
        session.historySyncPending = false;
        this.scheduleHistorySync(sessionId);
      }
    }
  }

  private computeNetworkRates(
    session: SshLiveSession,
    currentRxBytesTotal: number,
    currentTxBytesTotal: number,
    timestampMs: number,
  ): { rxBytesPerSec: number; txBytesPerSec: number } {
    const previous = session.lastNetworkSample;
    session.lastNetworkSample = {
      rxBytesTotal: currentRxBytesTotal,
      txBytesTotal: currentTxBytesTotal,
      timestampMs,
    };

    if (!previous) {
      return {
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
      };
    }

    const deltaMs = Math.max(1, timestampMs - previous.timestampMs);
    const deltaSeconds = deltaMs / 1000;

    return {
      rxBytesPerSec: Math.max(0, (currentRxBytesTotal - previous.rxBytesTotal) / deltaSeconds),
      txBytesPerSec: Math.max(0, (currentTxBytesTotal - previous.txBytesTotal) / deltaSeconds),
    };
  }

  private async readRemoteTelemetry(session: SshLiveSession): Promise<ParsedRemoteTelemetry | null> {
    const stdout = await this.executeRemoteCommand(session, TELEMETRY_COMMAND);
    if (stdout === null) {
      return null;
    }

    return this.parseTelemetryOutput(stdout);
  }

  private async readRemoteHistory(session: SshLiveSession): Promise<string[] | null> {
    const stdout = await this.executeRemoteCommand(session, REMOTE_HISTORY_FETCH_COMMAND);
    if (stdout === null) {
      return null;
    }

    return this.parseHistoryOutput(stdout);
  }

  private parseHistoryOutput(output: string): string[] {
    const rawLines = output.split(/\r?\n/);
    const parsedCommands: string[] = [];

    for (const line of rawLines) {
      const parsed = this.parseHistoryLine(line);
      if (!parsed) {
        continue;
      }

      parsedCommands.push(parsed);
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
    if (trimmed.length === 0) {
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

  private async deleteRemoteHistoryEntry(session: SshLiveSession, command: string): Promise<void> {
    const normalizedCommand = command.trim();
    if (normalizedCommand.length === 0) {
      return;
    }

    const escapedCommand = this.escapeShellSingleQuote(normalizedCommand);
    // Best-effort delete across common POSIX shell history file formats.
    const deleteCommand =
      ' sh -lc \\' +
      `set +e; target='${escapedCommand}'; ` +
      'cleanup_plain(){ file="$1"; if [ -f "$file" ]; then tmp="$file.cosmosh.$$"; grep -Fvx -- "$target" "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file"; fi; }; ' +
      'cleanup_zsh(){ file="$1"; if [ -f "$file" ]; then tmp="$file.cosmosh.$$"; awk -v target="$target" "{line=$0;cmd=line; if (match(line,/^: [0-9]+:[0-9]+;/)) {cmd=substr(line,RSTART+RLENGTH)} if (cmd==target) {next} print line}" "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file"; fi; }; ' +
      'cleanup_plain "$HISTFILE"; cleanup_plain "$HOME/.bash_history"; cleanup_plain "$HOME/.ash_history"; cleanup_plain "$HOME/.sh_history"; cleanup_plain "$HOME/.mksh_history"; cleanup_plain "$HOME/.ksh_history"; cleanup_zsh "$HOME/.zsh_history";\'';

    await this.executeRemoteCommand(session, deleteCommand);

    session.recentCommands = session.recentCommands.filter((entry) => entry !== normalizedCommand);
    this.sendServerMessage(session, {
      type: 'history',
      recentCommands: [...session.recentCommands],
    });
    this.scheduleHistorySync(session.sessionId, { immediate: true });
  }

  private escapeShellSingleQuote(value: string): string {
    return value.replace(/'/g, "'\"'\"'");
  }

  private async executeRemoteCommand(session: SshLiveSession, command: string): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      let stdout = '';

      session.client.exec(command, (error, channel) => {
        if (error) {
          resolve(null);
          return;
        }

        channel.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });

        channel.on('close', () => {
          resolve(stdout);
        });
      });
    });
  }

  private parseTelemetryOutput(output: string): ParsedRemoteTelemetry | null {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 3) {
      return null;
    }

    const cpuUsagePercent = Number.parseFloat(lines[0] ?? '0');
    const [memoryUsedRaw, memoryTotalRaw] = (lines[1] ?? '').split(/\s+/);
    const [networkRxRaw, networkTxRaw] = (lines[2] ?? '').split(/\s+/);

    const memoryUsedBytes = Number.parseInt(memoryUsedRaw ?? '0', 10);
    const memoryTotalBytes = Number.parseInt(memoryTotalRaw ?? '0', 10);
    const networkRxBytesTotal = Number.parseInt(networkRxRaw ?? '0', 10);
    const networkTxBytesTotal = Number.parseInt(networkTxRaw ?? '0', 10);

    if (
      !Number.isFinite(cpuUsagePercent) ||
      !Number.isFinite(memoryUsedBytes) ||
      !Number.isFinite(memoryTotalBytes) ||
      !Number.isFinite(networkRxBytesTotal) ||
      !Number.isFinite(networkTxBytesTotal)
    ) {
      return null;
    }

    return {
      cpuUsagePercent: Math.max(0, Math.min(100, cpuUsagePercent)),
      memoryUsedBytes: Math.max(0, memoryUsedBytes),
      memoryTotalBytes: Math.max(0, memoryTotalBytes),
      networkRxBytesTotal: Math.max(0, networkRxBytesTotal),
      networkTxBytesTotal: Math.max(0, networkTxBytesTotal),
    };
  }

  private async createLoginAudit(input: {
    serverId: string;
    result: 'success' | 'failed';
    failureReason?: string;
    sessionId?: string;
    sessionStartedAt?: Date;
  }): Promise<string | null> {
    try {
      const db = this.getDbClient();
      const audit = await db.sshLoginAudit.create({
        data: {
          id: randomUUID(),
          serverId: input.serverId,
          result: input.result,
          failureReason: input.failureReason,
          sessionId: input.sessionId,
          sessionStartedAt: input.sessionStartedAt,
        },
        select: {
          id: true,
        },
      });

      return audit.id;
    } catch (error: unknown) {
      console.error('[ssh][audit] Failed to create SSH login audit record.', error);
      return null;
    }
  }

  private async finalizeLoginAudit(session: SshLiveSession): Promise<void> {
    if (!session.loginAuditId) {
      return;
    }

    try {
      const db = this.getDbClient();
      await db.sshLoginAudit.update({
        where: {
          id: session.loginAuditId,
        },
        data: {
          sessionEndedAt: new Date(),
          commandCount: session.commandCount,
        },
      });
    } catch (error: unknown) {
      console.error('[ssh][audit] Failed to finalize SSH login audit record.', error);
    }
  }

  private async openShell(
    server: SshServer,
    options: {
      cols: number;
      rows: number;
      term: string;
      connectTimeoutSec: number;
      trustedFingerprintSet: Set<string>;
      t: I18nInstance['t'];
      onOutput: (data: string) => void;
    },
  ): Promise<OpenShellResult> {
    const client = new Client();
    let presentedFingerprint = '';

    const connectConfig: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: options.connectTimeoutSec * 1000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string) => {
        presentedFingerprint = hashedKey;
        return options.trustedFingerprintSet.has(hashedKey);
      },
    };

    try {
      if (server.authType === 'password' || server.authType === 'both') {
        if (!server.passwordEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.passwordNotConfigured'),
          };
        }

        connectConfig.password = decryptSensitiveValue(server.passwordEncrypted, this.credentialEncryptionKey);
      }

      if (server.authType === 'key' || server.authType === 'both') {
        if (!server.privateKeyEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.privateKeyNotConfigured'),
          };
        }

        connectConfig.privateKey = decryptSensitiveValue(server.privateKeyEncrypted, this.credentialEncryptionKey);

        if (server.privateKeyPassphraseEncrypted) {
          connectConfig.passphrase = decryptSensitiveValue(
            server.privateKeyPassphraseEncrypted,
            this.credentialEncryptionKey,
          );
        }
      }
    } catch {
      return {
        type: 'failed',
        message: options.t('errors.ssh.decryptCredentialsFailed'),
      };
    }

    return await new Promise<OpenShellResult>((resolve) => {
      let settled = false;

      const settle = (result: OpenShellResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      client.once('ready', () => {
        const cols = toShellSize(options.cols, 120, 20, 400);
        const rows = toShellSize(options.rows, 32, 10, 200);
        const term = options.term.trim() || 'xterm-256color';

        client.shell({ term, cols, rows }, (error, stream) => {
          if (error) {
            client.end();
            settle({
              type: 'failed',
              message: options.t('errors.ssh.openShellFailed', { reason: error.message }),
            });
            return;
          }

          stream.on('data', (chunk: Buffer | string) => {
            const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            options.onOutput(data);
          });

          stream.stderr.on('data', (chunk: Buffer | string) => {
            const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            options.onOutput(data);
          });

          settle({
            type: 'ready',
            client,
            stream,
          });
        });
      });

      client.on('error', (error: Error) => {
        if (settled) {
          return;
        }

        client.end();

        if (presentedFingerprint && !options.trustedFingerprintSet.has(presentedFingerprint)) {
          settle({
            type: 'host-untrusted',
            fingerprint: presentedFingerprint,
            message: error.message,
          });
          return;
        }

        settle({
          type: 'failed',
          message: error.message,
        });
      });

      client.connect(connectConfig);
    });
  }
}
