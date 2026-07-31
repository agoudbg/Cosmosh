/**
 * MCP authorization event channel.
 *
 * The renderer subscribes to a dedicated WebSocket (same direct-connect + query
 * token pattern the terminal uses) to receive authorization prompts and runtime
 * lifecycle events, then submits decisions back over the authenticated REST API.
 * A channel is created via REST, which mints a one-time token; the renderer then
 * opens `ws://host:port/mcp-events/<channelId>?token=<token>`.
 */

import { randomUUID } from 'node:crypto';

import type { McpEventMessage } from '@cosmosh/api-contract';
import { type WebSocket, WebSocketServer } from 'ws';

import { MCP_EVENTS_ATTACH_TIMEOUT_MS, MCP_EVENTS_PATH_PREFIX } from './constants.js';

type McpEventChannel = {
  channelId: string;
  token: string;
  socket: WebSocket | null;
  attachTimeout: NodeJS.Timeout;
};

/**
 * Handle returned to the renderer for opening the authorization event socket.
 */
export type McpEventsChannelHandle = {
  websocketUrl: string;
  websocketToken: string;
};

/**
 * Owns the authorization event WebSocket listener and connected renderer sockets.
 */
export class McpEventsService {
  private readonly websocketServer: WebSocketServer;

  private readonly websocketBaseUrl: string;

  private readonly channels = new Map<string, McpEventChannel>();

  public constructor(options: { host: string; port: number }) {
    this.websocketServer = new WebSocketServer({
      host: options.host,
      port: options.port,
      maxPayload: 64 * 1024,
    });
    this.websocketBaseUrl = `ws://${options.host}:${options.port}`;

    this.websocketServer.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '', this.websocketBaseUrl);
      const channelId = resolveChannelId(requestUrl.pathname);
      if (!channelId) {
        socket.close(1008, 'Invalid MCP events path.');
        return;
      }

      const token = requestUrl.searchParams.get('token') ?? '';
      const channel = this.channels.get(channelId);
      if (!channel || channel.socket || token !== channel.token) {
        socket.close(1008, 'MCP events channel is invalid or expired.');
        return;
      }

      channel.socket = socket;
      clearTimeout(channel.attachTimeout);

      socket.on('close', () => {
        if (channel.socket === socket) {
          this.channels.delete(channelId);
        }
      });
      socket.on('error', () => {
        if (channel.socket === socket) {
          this.channels.delete(channelId);
        }
      });
      // Inbound frames are ignored; the renderer submits decisions over REST.
      socket.on('message', () => undefined);
    });
  }

  /**
   * Creates one pending event channel and returns the connection handle.
   *
   * @returns WebSocket URL and one-time channel token.
   */
  public createChannel(): McpEventsChannelHandle {
    const channelId = randomUUID();
    const token = randomUUID();
    const attachTimeout = setTimeout(() => {
      const channel = this.channels.get(channelId);
      if (channel && !channel.socket) {
        this.channels.delete(channelId);
      }
    }, MCP_EVENTS_ATTACH_TIMEOUT_MS);
    if (typeof attachTimeout.unref === 'function') {
      attachTimeout.unref();
    }

    this.channels.set(channelId, {
      channelId,
      token,
      socket: null,
      attachTimeout,
    });

    return {
      websocketUrl: `${this.websocketBaseUrl}${MCP_EVENTS_PATH_PREFIX}${channelId}`,
      websocketToken: token,
    };
  }

  /**
   * Broadcasts one event to all attached renderer sockets.
   *
   * @param message Event message.
   */
  public broadcast(message: McpEventMessage): void {
    const serialized = JSON.stringify(message);
    for (const channel of this.channels.values()) {
      if (channel.socket && channel.socket.readyState === channel.socket.OPEN) {
        channel.socket.send(serialized);
      }
    }
  }

  /**
   * Number of renderer sockets currently attached.
   *
   * @returns Attached subscriber count.
   */
  public attachedSubscriberCount(): number {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (channel.socket && channel.socket.readyState === channel.socket.OPEN) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Closes all channels and stops the WebSocket listener.
   */
  public async stop(): Promise<void> {
    for (const channel of this.channels.values()) {
      clearTimeout(channel.attachTimeout);
      if (channel.socket && channel.socket.readyState === channel.socket.OPEN) {
        channel.socket.close(1001, 'MCP runtime shutting down.');
      }
    }
    this.channels.clear();

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
}

/**
 * Extracts the channel id from an events WebSocket path.
 *
 * @param pathname Request URL pathname.
 * @returns Channel id, or null when the path is malformed.
 */
const resolveChannelId = (pathname: string): string | null => {
  if (!pathname.startsWith(MCP_EVENTS_PATH_PREFIX)) {
    return null;
  }

  try {
    const channelId = decodeURIComponent(pathname.slice(MCP_EVENTS_PATH_PREFIX.length));
    return channelId.length > 0 ? channelId : null;
  } catch {
    return null;
  }
};
