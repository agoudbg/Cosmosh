import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ApiRuntimeActiveConnectionsCloseResponse,
  ApiRuntimeActiveConnectionsGetResponse,
} from '@cosmosh/api-contract';
import { API_PATHS } from '@cosmosh/api-contract';
import { Hono } from 'hono';

import { type BackendHttpApp, type BackendHttpEnv, registerI18nMiddleware } from '../i18n.js';
import type { BackendAppContext } from '../types.js';
import { registerSystemRoutes } from './system.js';

/**
 * Builds the minimal mutable service context needed to exercise runtime routes.
 *
 * @param sshCount Initial active SSH session count.
 * @param sftpCount Initial active SFTP session count.
 * @returns Backend context backed by in-memory session counters.
 */
const createRuntimeRouteContext = (sshCount: number, sftpCount: number): BackendAppContext => {
  let activeSshCount = sshCount;
  let activeSftpCount = sftpCount;

  return {
    runtimeMode: 'standalone',
    isSecureLocalMode: false,
    internalToken: undefined,
    credentialEncryptionKey: Buffer.alloc(32),
    getDbClient: () => ({}) as never,
    auditEventService: {} as never,
    sshSessionService: {
      getActiveSessionCount: () => activeSshCount,
      closeAllSessions: () => {
        const closedCount = activeSshCount;
        activeSshCount = 0;
        return closedCount;
      },
    } as never,
    sftpSessionService: {
      getActiveSessionCount: () => activeSftpCount,
      closeAllSessions: () => {
        const closedCount = activeSftpCount;
        activeSftpCount = 0;
        return closedCount;
      },
    } as never,
    portForwardSessionService: {} as never,
    localTerminalSessionService: {} as never,
    mcpService: {} as never,
  };
};

/**
 * Creates a route-only Hono app with request-scoped backend translations.
 *
 * @param context Backend runtime services used by system routes.
 * @returns Test HTTP application.
 */
const createSystemRouteApp = (context: BackendAppContext): BackendHttpApp => {
  const app = new Hono<BackendHttpEnv>();
  registerI18nMiddleware(app);
  registerSystemRoutes(app, context);
  return app;
};

test('runtime active connection routes report and close SSH/SFTP sessions', async () => {
  const app = createSystemRouteApp(createRuntimeRouteContext(2, 3));

  const getResponse = await app.request(API_PATHS.runtimeGetActiveConnections, {
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(getResponse.status, 200);
  const getPayload = (await getResponse.json()) as ApiRuntimeActiveConnectionsGetResponse;
  assert.deepEqual(getPayload.data, {
    sshCount: 2,
    sftpCount: 3,
    totalCount: 5,
  });

  const closeResponse = await app.request(API_PATHS.runtimeCloseActiveConnections, {
    method: 'DELETE',
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(closeResponse.status, 200);
  const closePayload = (await closeResponse.json()) as ApiRuntimeActiveConnectionsCloseResponse;
  assert.deepEqual(closePayload.data, {
    sshCount: 2,
    sftpCount: 3,
    totalCount: 5,
  });

  const emptyResponse = await app.request(API_PATHS.runtimeGetActiveConnections);
  const emptyPayload = (await emptyResponse.json()) as ApiRuntimeActiveConnectionsGetResponse;
  assert.deepEqual(emptyPayload.data, {
    sshCount: 0,
    sftpCount: 0,
    totalCount: 0,
  });
});
