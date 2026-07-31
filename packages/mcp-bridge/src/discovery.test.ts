import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  BridgeDiscoveryError,
  defaultDiscoveryPath,
  DISCOVERY_FILE_NAME,
  parseDiscoveryFile,
  readDiscoveryFile,
  resolveDiscoveryPath,
} from './discovery.js';

const createdDirs: string[] = [];

after(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cosmosh-bridge-test-'));
  createdDirs.push(dir);
  return dir;
};

describe('resolveDiscoveryPath', () => {
  const base = { env: {}, platform: 'linux' as NodeJS.Platform, homedir: '/home/tester' };

  it('prefers the --discovery <path> flag', () => {
    const resolved = resolveDiscoveryPath({ ...base, argv: ['--discovery', '/tmp/custom/bridge.json'] });
    assert.equal(resolved, path.resolve('/tmp/custom/bridge.json'));
  });

  it('accepts the --discovery=<path> form', () => {
    const resolved = resolveDiscoveryPath({ ...base, argv: ['--discovery=/tmp/eq/bridge.json'] });
    assert.equal(resolved, path.resolve('/tmp/eq/bridge.json'));
  });

  it('falls back to COSMOSH_MCP_DISCOVERY', () => {
    const resolved = resolveDiscoveryPath({
      ...base,
      argv: [],
      env: { COSMOSH_MCP_DISCOVERY: '/tmp/env/bridge.json' },
    });
    assert.equal(resolved, path.resolve('/tmp/env/bridge.json'));
  });

  it('falls back to the platform default when nothing is provided', () => {
    const resolved = resolveDiscoveryPath({ ...base, argv: [] });
    assert.equal(resolved, path.join('/home/tester', '.config', 'Cosmosh', 'mcp', DISCOVERY_FILE_NAME));
  });
});

describe('defaultDiscoveryPath', () => {
  it('uses APPDATA on win32', () => {
    const resolved = defaultDiscoveryPath({
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      platform: 'win32',
      homedir: 'C:\\Users\\tester',
    });
    assert.ok(resolved.endsWith(path.join('Cosmosh', 'mcp', DISCOVERY_FILE_NAME)));
    assert.ok(resolved.includes('Roaming'));
  });

  it('uses Application Support on darwin', () => {
    const resolved = defaultDiscoveryPath({ env: {}, platform: 'darwin', homedir: '/Users/tester' });
    assert.equal(
      resolved,
      path.join('/Users/tester', 'Library', 'Application Support', 'Cosmosh', 'mcp', DISCOVERY_FILE_NAME),
    );
  });

  it('honors XDG_CONFIG_HOME on linux', () => {
    const resolved = defaultDiscoveryPath({
      env: { XDG_CONFIG_HOME: '/home/tester/.xdg' },
      platform: 'linux',
      homedir: '/home/tester',
    });
    assert.equal(resolved, path.join('/home/tester/.xdg', 'Cosmosh', 'mcp', DISCOVERY_FILE_NAME));
  });
});

describe('parseDiscoveryFile', () => {
  const validPayload = JSON.stringify({
    version: 1,
    port: 51234,
    token: 'abc123token',
    pid: 4242,
    appVersion: '0.1.0',
    startedAt: '2026-07-26T00:00:00.000Z',
  });

  it('parses a well-formed discovery file', () => {
    const parsed = parseDiscoveryFile(validPayload, '/tmp/bridge.json');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.port, 51234);
    assert.equal(parsed.token, 'abc123token');
    assert.equal(parsed.pid, 4242);
  });

  it('rejects malformed JSON', () => {
    assert.throws(
      () => parseDiscoveryFile('{ not json', '/tmp/bridge.json'),
      (error: unknown) => error instanceof BridgeDiscoveryError && error.code === 'invalid',
    );
  });

  it('rejects a missing token', () => {
    const payload = JSON.stringify({ version: 1, port: 51234 });
    assert.throws(
      () => parseDiscoveryFile(payload, '/tmp/bridge.json'),
      (error: unknown) => error instanceof BridgeDiscoveryError && error.code === 'invalid',
    );
  });

  it('rejects an out-of-range port', () => {
    const payload = JSON.stringify({ version: 1, port: 70000, token: 'x' });
    assert.throws(
      () => parseDiscoveryFile(payload, '/tmp/bridge.json'),
      (error: unknown) => error instanceof BridgeDiscoveryError && error.code === 'invalid',
    );
  });

  it('rejects an unsupported schema version', () => {
    const payload = JSON.stringify({ version: 99, port: 51234, token: 'x' });
    assert.throws(
      () => parseDiscoveryFile(payload, '/tmp/bridge.json'),
      (error: unknown) => error instanceof BridgeDiscoveryError && error.code === 'unsupported-version',
    );
  });
});

describe('readDiscoveryFile', () => {
  it('reads and parses an on-disk discovery file', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, DISCOVERY_FILE_NAME);
    await writeFile(filePath, `${JSON.stringify({ version: 1, port: 40000, token: 'tok' }, null, 2)}\n`);

    const parsed = await readDiscoveryFile(filePath);
    assert.equal(parsed.port, 40000);
    assert.equal(parsed.token, 'tok');
  });

  it('reports not-found when the file is absent (app not running)', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'missing', DISCOVERY_FILE_NAME);

    await assert.rejects(
      readDiscoveryFile(filePath),
      (error: unknown) => error instanceof BridgeDiscoveryError && error.code === 'not-found',
    );
  });
});
