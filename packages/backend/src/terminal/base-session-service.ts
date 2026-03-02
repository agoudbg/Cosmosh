import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { createI18n, type I18nInstance } from '../i18n-bridge.js';

/**
 * Minimal common fields required by terminal-like live sessions.
 */
export type TerminalLiveSessionBase = {
  sessionId: string;
  websocketToken: string;
  pendingOutput: string[];
  attachTimeout: NodeJS.Timeout;
  t: I18nInstance['t'];
  socket: WebSocket | null;
  disposed: boolean;
};

/**
 * Extended session shape for services that maintain telemetry/history timers.
 */
export type TerminalManagedSessionBase = TerminalLiveSessionBase & {
  telemetryInterval: NodeJS.Timeout | null;
  historySyncTimeout: NodeJS.Timeout | null;
};

type DisposeReasonParams = Record<string, string | number | boolean>;

/**
 * Generic terminal session base service that centralizes WebSocket attach/auth lifecycle.
 *
 * Boundary constraints:
 * - This layer owns WebSocket path/token validation and socket attachment semantics only.
 * - This layer never interprets terminal protocol payload intent.
 * - Transport semantics (SSH channel vs local PTY process) remain in concrete services.
 */
export abstract class BaseTerminalSessionService<
  TSession extends TerminalManagedSessionBase,
  TOutboundMessage extends { type: string },
> {
  protected readonly sessions = new Map<string, TSession>();

  protected readonly websocketBaseUrl: string;

  private readonly websocketServer: WebSocketServer;

  /**
   * Builds a dedicated WebSocket endpoint and performs generic session attach/auth workflow.
   * Concrete services remain responsible for transport-specific message handling and disposal details.
   */
  protected constructor(options: { host: string; port: number; pathPrefix: string }) {
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

      if (!requestUrl.pathname.startsWith(options.pathPrefix)) {
        socket.close(1008, requestTranslator('ws.invalidWebsocketPath'));
        return;
      }

      const sessionId = decodeURIComponent(requestUrl.pathname.slice(options.pathPrefix.length));
      const token = requestUrl.searchParams.get('token') ?? '';
      const session = this.sessions.get(sessionId);

      if (!session || session.disposed || token !== session.websocketToken) {
        // Reject unknown/expired token early to avoid binding sockets to stale session ids.
        socket.close(
          1008,
          session ? session.t('ws.sessionInvalidOrExpired') : requestTranslator('ws.sessionInvalidOrExpired'),
        );
        return;
      }

      if (session.socket && session.socket.readyState === session.socket.OPEN) {
        // Keep exactly one active client connection per session to prevent interleaved writes.
        session.socket.close(1012, session.t('ws.sessionReconnectedFromNewClient'));
      }

      session.socket = socket;
      clearTimeout(session.attachTimeout);
      this.onSessionAttached(session);

      socket.on('message', (payload: RawData) => {
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

  /**
   * Closes a single live session by id using common API-level close reason.
   */
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

  protected registerSession(session: TSession): void {
    this.sessions.set(session.sessionId, session);
  }

  /**
   * Sends outbound payload immediately when socket is attached, otherwise buffers output chunks.
   * Non-output payloads are intentionally dropped while detached to avoid stale control messages.
   */
  protected sendServerMessage(session: TSession, payload: TOutboundMessage): void {
    if (!session.socket || session.socket.readyState !== session.socket.OPEN) {
      if (payload.type === 'output') {
        const maybeOutputPayload = payload as unknown as { data?: unknown };
        if (typeof maybeOutputPayload.data === 'string') {
          session.pendingOutput.push(maybeOutputPayload.data);
        }
      }
      return;
    }

    session.socket.send(JSON.stringify(payload));
  }

  protected flushPendingOutput(session: TSession, createOutputMessage: (data: string) => TOutboundMessage): void {
    while (session.pendingOutput.length > 0) {
      const data = session.pendingOutput.shift();
      if (!data) {
        continue;
      }

      this.sendServerMessage(session, createOutputMessage(data));
    }
  }

  /**
   * Executes standard dispose sequence and delegates transport-specific teardown via hooks.
   */
  protected disposeSessionWithCommonLifecycle(
    sessionId: string,
    reasonKey: string,
    reasonParams: DisposeReasonParams | undefined,
    options: {
      createExitMessage: (reason: string) => TOutboundMessage;
      disposeTransport: (session: TSession) => void;
      beforeExit?: (session: TSession, reason: string) => void;
    },
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

    options.beforeExit?.(session, reason);

    this.sendServerMessage(session, options.createExitMessage(reason));
    options.disposeTransport(session);

    if (session.socket && session.socket.readyState === session.socket.OPEN) {
      session.socket.close(1000, reason);
    }

    session.socket = null;
  }

  /**
   * Handles a raw client payload after base attach/auth checks have passed.
   */
  protected abstract handleClientMessage(session: TSession, rawPayload: RawData): void;

  /**
   * Notifies concrete service that a socket has been attached or reattached to the session.
   */
  protected abstract onSessionAttached(session: TSession): void;

  /**
   * Performs transport-specific teardown and emits an exit reason.
   */
  protected abstract disposeSession(sessionId: string, reasonKey: string, reasonParams?: DisposeReasonParams): void;
}
