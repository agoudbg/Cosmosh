import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { buildMcpUrl, probeBackend, runBridge } from './proxy.js';

const discovery = { version: 1, port: 51234, token: 'tok-abc' };

describe('buildMcpUrl', () => {
  it('targets the loopback /mcp endpoint', () => {
    assert.equal(buildMcpUrl(51234).toString(), 'http://127.0.0.1:51234/mcp');
  });
});

describe('probeBackend', () => {
  const makeFetch = (impl: () => Promise<Response> | Response): typeof fetch =>
    (async () => impl()) as unknown as typeof fetch;

  it('returns ok and sends the Bearer token for a live endpoint', async () => {
    let sentAuth: string | null = null;
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentAuth = headers.authorization ?? null;
      return new Response('{}', { status: 400 });
    }) as unknown as typeof fetch;

    const result = await probeBackend(discovery, { fetchImpl });
    assert.deepEqual(result, { status: 'ok' });
    assert.equal(sentAuth, 'Bearer tok-abc');
  });

  it('maps 503 to disabled', async () => {
    const result = await probeBackend(discovery, { fetchImpl: makeFetch(() => new Response('', { status: 503 })) });
    assert.deepEqual(result, { status: 'disabled' });
  });

  it('maps 401 to unauthorized', async () => {
    const result = await probeBackend(discovery, { fetchImpl: makeFetch(() => new Response('', { status: 401 })) });
    assert.deepEqual(result, { status: 'unauthorized' });
  });

  it('maps a network failure to unreachable (app not running)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await probeBackend(discovery, { fetchImpl });
    assert.equal(result.status, 'unreachable');
    assert.match((result as { detail: string }).detail, /ECONNREFUSED/);
  });
});

/** Controllable in-memory transport used to drive the passthrough. */
class FakeTransport {
  public sent: JSONRPCMessage[] = [];

  public started = false;

  public closed = false;

  public onmessage?: (message: JSONRPCMessage) => void;

  public onclose?: () => void;

  public onerror?: (error: Error) => void;

  public async start(): Promise<void> {
    this.started = true;
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

const pingMessage: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('runBridge passthrough', () => {
  it('forwards stdio -> http and http -> stdio, then resolves on stdio close', async () => {
    const http = new FakeTransport();
    const stdio = new FakeTransport();

    const done = runBridge(discovery, { httpTransport: http, stdioTransport: stdio });

    // Both transports must be started.
    await Promise.resolve();
    assert.equal(http.started, true);
    assert.equal(stdio.started, true);

    // Agent -> backend.
    stdio.onmessage?.(pingMessage);
    await Promise.resolve();
    assert.deepEqual(http.sent, [pingMessage]);

    // Backend -> agent.
    const pong: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: {} };
    http.onmessage?.(pong);
    await Promise.resolve();
    assert.deepEqual(stdio.sent, [pong]);

    // Agent hangs up -> clean shutdown.
    stdio.onclose?.();
    await done;
    assert.equal(http.closed, true);
    assert.equal(stdio.closed, true);
  });

  it('rejects and closes both transports when a transport errors', async () => {
    const http = new FakeTransport();
    const stdio = new FakeTransport();

    const done = runBridge(discovery, { httpTransport: http, stdioTransport: stdio });
    await Promise.resolve();

    http.onerror?.(new Error('socket hang up'));

    await assert.rejects(done, /socket hang up/);
    assert.equal(http.closed, true);
    assert.equal(stdio.closed, true);
  });
});
