import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_CODES,
  API_PATHS,
  type ApiErrorResponse,
  type ApiSftpGetTaskResponse,
  type ApiSftpListTasksResponse,
  type ApiSftpStartTaskRequest,
  type ApiSftpStartTaskResponse,
  type ApiSftpTaskData,
} from '@cosmosh/api-contract';
import { Hono } from 'hono';

import { type BackendHttpApp, type BackendHttpEnv, registerI18nMiddleware } from '../i18n.js';
import type { BackendAppContext } from '../types.js';
import { registerSftpRoutes } from './sftp.js';

type SftpSessionService = BackendAppContext['sftpSessionService'];
type SftpTaskRouteService = Pick<SftpSessionService, 'getTask' | 'listTasks' | 'startTask'>;

const SESSION_ID = 'sftp-session-1';
const CLOSED_SESSION_ID = 'closed-sftp-session';
const UNKNOWN_SESSION_ID = 'unknown-sftp-session';
const TASK_ID = '2d8069af-1b83-4b5c-8b18-88f31de7045f';
const UPLOAD_TRANSFER_ID = '6af0e82f-67bb-4bce-afc6-e4697bb02916';
const DOWNLOAD_TRANSFER_ID = '2603f35a-d2ce-4dbf-9209-c22a81699755';

const RETAINED_TASK: ApiSftpTaskData = {
  sessionId: SESSION_ID,
  taskId: TASK_ID,
  operation: 'rename',
  state: 'queued',
  remotePaths: ['/workspace/source.txt', '/workspace/renamed.txt'],
  createdAt: '2026-07-25T01:00:00.000Z',
  deadlineAt: '2026-07-26T01:00:00.000Z',
};

/**
 * Builds the minimal backend context required to exercise SFTP task routes.
 *
 * @param service Mock task-service methods observed by the route tests.
 * @returns Backend context with unrelated services replaced by inert placeholders.
 */
const createSftpTaskRouteContext = (service: SftpTaskRouteService): BackendAppContext => {
  return {
    runtimeMode: 'standalone',
    isSecureLocalMode: false,
    internalToken: undefined,
    credentialEncryptionKey: Buffer.alloc(32),
    getDbClient: () => ({}) as never,
    auditEventService: {} as never,
    sshSessionService: {} as never,
    sftpSessionService: service as SftpSessionService,
    portForwardSessionService: {} as never,
    localTerminalSessionService: {} as never,
    mcpService: {} as never,
  };
};

/**
 * Creates a route-only Hono app with request-scoped backend translations.
 *
 * @param service Mock task-service methods used by SFTP routes.
 * @returns Test HTTP application.
 */
const createSftpTaskRouteApp = (service: SftpTaskRouteService): BackendHttpApp => {
  const app = new Hono<BackendHttpEnv>();
  registerI18nMiddleware(app);
  registerSftpRoutes(app, createSftpTaskRouteContext(service));
  return app;
};

/**
 * Expands a task collection route for one test session.
 *
 * @param sessionId SFTP session identifier.
 * @returns Concrete HTTP route.
 */
const getTaskCollectionPath = (sessionId: string): string => {
  return API_PATHS.sftpStartTask.replace('{sessionId}', sessionId);
};

/**
 * Expands a task detail route for one session and task.
 *
 * @param sessionId SFTP session identifier.
 * @param taskId SFTP task identifier.
 * @returns Concrete HTTP route.
 */
const getTaskDetailPath = (sessionId: string, taskId: string): string => {
  return API_PATHS.sftpGetTask.replace('{sessionId}', sessionId).replace('{taskId}', taskId);
};

/**
 * Creates an application/json POST request for the Hono test client.
 *
 * @param app Route-only Hono application.
 * @param path Concrete request path.
 * @param payload JSON request payload.
 * @returns Route response.
 */
const postJson = async (app: BackendHttpApp, path: string, payload: unknown): Promise<Response> => {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cosmosh-locale': 'en',
    },
    body: JSON.stringify(payload),
  });
};

test('SFTP task start route accepts rename and forwards the normalized descriptor', async () => {
  const calls: Array<{ sessionId: string; request: ApiSftpStartTaskRequest }> = [];
  const app = createSftpTaskRouteApp({
    startTask: (sessionId, request) => {
      calls.push({ sessionId, request });
      return { type: 'success', task: RETAINED_TASK };
    },
    listTasks: () => [],
    getTask: () => null,
  });

  const response = await postJson(app, getTaskCollectionPath(SESSION_ID), {
    operation: 'rename',
    payload: {
      sourcePath: '/workspace/source.txt',
      targetPath: '/workspace/renamed.txt',
    },
  });

  assert.equal(response.status, 202);
  const payload = (await response.json()) as ApiSftpStartTaskResponse;
  assert.equal(payload.success, true);
  assert.equal(payload.code, API_CODES.sftpTaskAccepted);
  assert.deepEqual(payload.data, RETAINED_TASK);
  assert.deepEqual(calls, [
    {
      sessionId: SESSION_ID,
      request: {
        operation: 'rename',
        payload: {
          sourcePath: '/workspace/source.txt',
          targetPath: '/workspace/renamed.txt',
        },
      },
    },
  ]);
});

test('SFTP task start route requires transfer ids and forwards authorized local paths', async () => {
  const calls: Array<{ sessionId: string; request: ApiSftpStartTaskRequest }> = [];
  const app = createSftpTaskRouteApp({
    startTask: (sessionId, request) => {
      calls.push({ sessionId, request });
      return { type: 'success', task: RETAINED_TASK };
    },
    listTasks: () => [],
    getTask: () => null,
  });

  const missingUploadTransferId = await postJson(app, getTaskCollectionPath(SESSION_ID), {
    operation: 'upload',
    payload: {
      path: '/workspace/upload.bin',
      localPath: 'C:\\staged\\upload.bin',
    },
  });
  assert.equal(missingUploadTransferId.status, 400);
  assert.equal(((await missingUploadTransferId.json()) as ApiErrorResponse).code, API_CODES.sftpValidationFailed);

  const missingDownloadTransferId = await postJson(app, getTaskCollectionPath(SESSION_ID), {
    operation: 'download',
    payload: {
      path: '/workspace/download.bin',
      localPath: 'C:\\downloads\\download.bin',
    },
  });
  assert.equal(missingDownloadTransferId.status, 400);
  assert.equal(((await missingDownloadTransferId.json()) as ApiErrorResponse).code, API_CODES.sftpValidationFailed);
  assert.equal(calls.length, 0);

  const uploadResponse = await postJson(app, getTaskCollectionPath(SESSION_ID), {
    operation: 'upload',
    payload: {
      path: '/workspace/upload.bin',
      localPath: 'C:\\staged\\upload.bin',
      transferId: UPLOAD_TRANSFER_ID,
      overwrite: true,
    },
  });
  assert.equal(uploadResponse.status, 202);

  const downloadResponse = await postJson(app, getTaskCollectionPath(SESSION_ID), {
    operation: 'download',
    payload: {
      path: '/workspace/download.bin',
      localPath: 'C:\\downloads\\download.bin',
      transferId: DOWNLOAD_TRANSFER_ID,
    },
  });
  assert.equal(downloadResponse.status, 202);

  assert.deepEqual(calls, [
    {
      sessionId: SESSION_ID,
      request: {
        operation: 'upload',
        payload: {
          path: '/workspace/upload.bin',
          localPath: 'C:\\staged\\upload.bin',
          expectedSize: undefined,
          expectedModifiedAt: undefined,
          overwrite: true,
          transferId: UPLOAD_TRANSFER_ID,
        },
      },
    },
    {
      sessionId: SESSION_ID,
      request: {
        operation: 'download',
        payload: {
          path: '/workspace/download.bin',
          localPath: 'C:\\downloads\\download.bin',
          transferId: DOWNLOAD_TRANSFER_ID,
        },
      },
    },
  ]);
});

test('SFTP task list route returns retained tasks and rejects closed or unknown sessions', async () => {
  const app = createSftpTaskRouteApp({
    startTask: () => ({ type: 'success', task: RETAINED_TASK }),
    listTasks: (sessionId) => (sessionId === SESSION_ID ? [RETAINED_TASK] : null),
    getTask: () => null,
  });

  const response = await app.request(getTaskCollectionPath(SESSION_ID), {
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ApiSftpListTasksResponse;
  assert.equal(payload.success, true);
  assert.equal(payload.code, API_CODES.sftpTaskListOk);
  assert.deepEqual(payload.data, {
    sessionId: SESSION_ID,
    items: [RETAINED_TASK],
  });

  for (const unavailableSessionId of [CLOSED_SESSION_ID, UNKNOWN_SESSION_ID]) {
    const unavailableResponse = await app.request(getTaskCollectionPath(unavailableSessionId), {
      headers: { 'x-cosmosh-locale': 'en' },
    });
    assert.equal(unavailableResponse.status, 404);
    assert.equal(((await unavailableResponse.json()) as ApiErrorResponse).code, API_CODES.sftpSessionNotFound);
  }
});

test('SFTP task detail route returns retained state and validates task lookup ids', async () => {
  const lookupCalls: Array<{ sessionId: string; taskId: string }> = [];
  const app = createSftpTaskRouteApp({
    startTask: () => ({ type: 'success', task: RETAINED_TASK }),
    listTasks: () => [],
    getTask: (sessionId, taskId) => {
      lookupCalls.push({ sessionId, taskId });
      return sessionId === SESSION_ID && taskId === TASK_ID ? RETAINED_TASK : null;
    },
  });

  const response = await app.request(getTaskDetailPath(SESSION_ID, TASK_ID), {
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ApiSftpGetTaskResponse;
  assert.equal(payload.success, true);
  assert.equal(payload.code, API_CODES.sftpTaskStatusOk);
  assert.deepEqual(payload.data, RETAINED_TASK);

  const unknownTaskId = '23b5261d-e140-465c-b037-157214695c78';
  const unknownResponse = await app.request(getTaskDetailPath(SESSION_ID, unknownTaskId), {
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(unknownResponse.status, 404);
  assert.equal(((await unknownResponse.json()) as ApiErrorResponse).code, API_CODES.sftpTaskNotFound);

  const callsBeforeMalformedRequest = lookupCalls.length;
  const malformedResponse = await app.request(getTaskDetailPath(SESSION_ID, 'not-a-uuid'), {
    headers: { 'x-cosmosh-locale': 'en' },
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal(((await malformedResponse.json()) as ApiErrorResponse).code, API_CODES.sftpValidationFailed);
  assert.equal(lookupCalls.length, callsBeforeMalformedRequest);
});
