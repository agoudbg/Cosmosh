import assert from 'node:assert/strict';
import test from 'node:test';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import type { AuditEventService } from '../audit/service.js';
import { McpSessionManager } from './sessions.js';
import type { McpToolRuntime } from './tools.js';

const HTTP_PORT = 54_720;

/**
 * Builds a tool runtime that keeps protocol tests isolated from SSH state.
 *
 * @returns No-op MCP tool runtime.
 */
const createRuntime = (): McpToolRuntime => {
  return {
    listServers: async () => [],
    openConnection: async () => ({ ok: false, reason: 'failed', message: 'Not used by this test.' }),
    attachTerminal: async () => ({ ok: false, reason: 'failed', message: 'Not used by this test.' }),
    listConnections: () => [],
    runCommand: async () => ({ ok: false, reason: 'failed', message: 'Not used by this test.' }),
    closeConnection: async () => ({
      ok: false,
      reason: 'connection-not-found',
      message: 'Not used by this test.',
    }),
  };
};

/**
 * Builds the minimal audit surface used by the session manager.
 *
 * @returns No-op audit service.
 */
const createAuditService = (): AuditEventService => {
  return {
    logEvent: async () => null,
  } as unknown as AuditEventService;
};

/**
 * Builds an MCP initialize request with an explicit HTTP Host header.
 *
 * @param host Complete Host header value, including the dynamic backend port.
 * @returns Web Standard initialize request.
 */
const createInitializeRequest = (host: string): Request => {
  return new Request(`http://${host}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'mcp-session-test',
          version: '1.0.0',
        },
      },
    }),
  });
};

/**
 * Builds a session manager bound to the deterministic test port.
 *
 * @returns Isolated session manager.
 */
const createSessionManager = (): McpSessionManager => {
  return new McpSessionManager({
    runtime: createRuntime(),
    emitEvent: () => {},
    auditEventService: createAuditService(),
    appVersion: '0.1.0-test',
    httpPort: HTTP_PORT,
  });
};

test('initialize accepts the loopback Host header with the runtime port', async (context) => {
  const manager = createSessionManager();
  context.after(async () => {
    await manager.closeAll();
  });

  const response = await manager.handleRequest(createInitializeRequest(`127.0.0.1:${HTTP_PORT}`));

  assert.equal(response.status, 200);
  assert.ok(response.headers.get('mcp-session-id'));
  assert.equal(manager.count(), 1);
});

test('initialize rejects a Host header outside the loopback runtime allowlist', async () => {
  const manager = createSessionManager();

  const response = await manager.handleRequest(createInitializeRequest('attacker.example'));
  const payload = (await response.json()) as { error?: { message?: string } };

  assert.equal(response.status, 403);
  assert.match(payload.error?.message ?? '', /Invalid Host header/);
  assert.equal(manager.count(), 0);
});
