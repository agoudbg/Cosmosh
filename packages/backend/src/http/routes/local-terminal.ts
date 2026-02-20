import { API_CODES, createApiSuccess } from '@cosmosh/api-contract';
import type { Hono } from 'hono';

import { buildErrorPayload } from '../errors.js';
import type { BackendAppContext } from '../types.js';

const LOCAL_TERMINAL_LIST_PATH = '/api/v1/local-terminals/profiles';
const LOCAL_TERMINAL_CREATE_SESSION_PATH = '/api/v1/local-terminals/sessions';
const LOCAL_TERMINAL_CLOSE_SESSION_PATH = '/api/v1/local-terminals/sessions/{sessionId}';

export const registerLocalTerminalRoutes = (app: Hono, context: BackendAppContext): void => {
  app.get(LOCAL_TERMINAL_LIST_PATH, async (c) => {
    const items = await context.localTerminalSessionService.listProfiles();

    return c.json(
      createApiSuccess({
        code: 'LOCAL_TERMINAL_LIST_OK',
        message: 'Local terminal profiles fetched successfully.',
        data: {
          items,
        },
      }),
    );
  });

  app.post(LOCAL_TERMINAL_CREATE_SESSION_PATH, async (c) => {
    const payload = (await c.req.json().catch(() => undefined)) as
      | {
          profileId?: unknown;
          cols?: unknown;
          rows?: unknown;
          term?: unknown;
        }
      | undefined;

    const profileId = typeof payload?.profileId === 'string' ? payload.profileId.trim() : '';
    const cols = typeof payload?.cols === 'number' ? payload.cols : Number(payload?.cols ?? 120);
    const rows = typeof payload?.rows === 'number' ? payload.rows : Number(payload?.rows ?? 32);
    const term = typeof payload?.term === 'string' ? payload.term : 'xterm-256color';

    if (!profileId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, 'profileId is required.'), 400);
    }

    if (!Number.isInteger(cols) || cols < 20 || cols > 400) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, 'cols must be an integer between 20 and 400.'),
        400,
      );
    }

    if (!Number.isInteger(rows) || rows < 10 || rows > 200) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, 'rows must be an integer between 10 and 200.'),
        400,
      );
    }

    const result = await context.localTerminalSessionService.createSession({
      profileId,
      cols,
      rows,
      term,
    });

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, 'Local terminal profile was not found.'), 404);
    }

    if (result.type === 'failed') {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, result.message), 400);
    }

    return c.json(
      createApiSuccess({
        code: 'LOCAL_TERMINAL_SESSION_CREATE_OK',
        message: 'Local terminal session created successfully.',
        data: {
          sessionId: result.sessionId,
          profileId: result.profileId,
          websocketUrl: result.websocketUrl,
          websocketToken: result.websocketToken,
        },
      }),
    );
  });

  app.delete(LOCAL_TERMINAL_CLOSE_SESSION_PATH.replace('{sessionId}', ':sessionId'), async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!sessionId || !context.localTerminalSessionService.closeSession(sessionId)) {
      return c.json(buildErrorPayload(API_CODES.sshSessionNotFound, 'Local terminal session was not found.'), 404);
    }

    return c.body(null, 204);
  });
};
