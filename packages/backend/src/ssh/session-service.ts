import { randomBytes, randomUUID } from 'node:crypto';

import type { PrismaClient, SshServer } from '@prisma/client';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { decryptSensitiveValue } from './crypto.js';

type GetDbClient = () => PrismaClient;

type CreateSshSessionInput = {
  serverId: string;
  cols: number;
  rows: number;
  term: string;
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
    };

type SshLiveSession = {
  sessionId: string;
  serverId: string;
  websocketToken: string;
  client: Client;
  stream: ClientChannel;
  pendingOutput: string[];
  attachTimeout: NodeJS.Timeout;
  socket: WebSocket | null;
  disposed: boolean;
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

const toShellSize = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

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
      const requestUrl = new URL(request.url ?? '', this.websocketBaseUrl);
      const pathPrefix = '/ws/ssh/';

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

  public getWebSocketBaseUrl(): string {
    return this.websocketBaseUrl;
  }

  public async createSession(input: CreateSshSessionInput): Promise<CreateSshSessionResult> {
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
      trustedFingerprintSet,
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
      return {
        type: 'failed',
        message: shellResult.message,
      };
    }

    const sessionId = randomUUID();
    const websocketToken = randomBytes(24).toString('hex');

    const attachTimeout = setTimeout(() => {
      this.disposeSession(sessionId, 'WebSocket connection timeout.');
    }, 30_000);

    liveSession = {
      sessionId,
      serverId: server.id,
      websocketToken,
      client: shellResult.client,
      stream: shellResult.stream,
      pendingOutput,
      attachTimeout,
      socket: null,
      disposed: false,
    };

    shellResult.stream.on('close', () => {
      this.disposeSession(sessionId, 'SSH stream closed.');
    });

    shellResult.client.on('close', () => {
      this.disposeSession(sessionId, 'SSH connection closed.');
    });

    shellResult.client.on('error', (error: Error) => {
      this.sendServerMessage(liveSession, {
        type: 'error',
        message: error.message,
      });
      this.disposeSession(sessionId, 'SSH connection error.');
    });

    this.sessions.set(sessionId, liveSession);

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
        message: 'Invalid websocket message format.',
      });
      return;
    }

    if (message.type === 'input') {
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

  private async openShell(
    server: SshServer,
    options: {
      cols: number;
      rows: number;
      term: string;
      trustedFingerprintSet: Set<string>;
      onOutput: (data: string) => void;
    },
  ): Promise<OpenShellResult> {
    const client = new Client();
    let presentedFingerprint = '';

    const connectConfig: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 20_000,
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
            message: 'Password is required but not configured for this server.',
          };
        }

        connectConfig.password = decryptSensitiveValue(server.passwordEncrypted, this.credentialEncryptionKey);
      }

      if (server.authType === 'key' || server.authType === 'both') {
        if (!server.privateKeyEncrypted) {
          return {
            type: 'failed',
            message: 'Private key is required but not configured for this server.',
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
    } catch (error: unknown) {
      return {
        type: 'failed',
        message:
          error instanceof Error
            ? `Unable to decrypt SSH credentials: ${error.message}. Please re-save this server credentials.`
            : 'Unable to decrypt SSH credentials. Please re-save this server credentials.',
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
              message: `Failed to open SSH shell: ${error.message}`,
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

      client.once('error', (error: Error) => {
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
