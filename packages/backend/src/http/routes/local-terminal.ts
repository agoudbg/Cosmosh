import {
  API_CODES,
  API_PATHS,
  type ApiLocalTerminalCreateSessionRequest,
  type ApiLocalTerminalCreateSessionResponse,
  type ApiLocalTerminalListProfilesResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';

import { buildErrorPayload } from '../errors.js';
import type { BackendHttpApp } from '../i18n.js';
import { getTranslator, translateValidationMessage } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

/**
 * Registers local terminal profile and session management routes.
 */
export const registerLocalTerminalRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.get(API_PATHS.localTerminalListProfiles, async (c) => {
    const t = getTranslator(c);
    const items = await context.localTerminalSessionService.listProfiles();

    const payload: ApiLocalTerminalListProfilesResponse = createApiSuccess({
      code: API_CODES.localTerminalListOk,
      message: t('success.localTerminal.profilesFetched'),
      data: {
        items,
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.localTerminalCreateSession, async (c) => {
    const t = getTranslator(c);

    // Parse loosely typed body first, then normalize/validate each field explicitly.
    const payload = (await c.req.json().catch(() => undefined)) as
      | Partial<ApiLocalTerminalCreateSessionRequest>
      | undefined;
    const profileId = typeof payload?.profileId === 'string' ? payload.profileId.trim() : '';
    const cols = typeof payload?.cols === 'number' ? payload.cols : Number(payload?.cols ?? 120);
    const rows = typeof payload?.rows === 'number' ? payload.rows : Number(payload?.rows ?? 32);
    const term = typeof payload?.term === 'string' ? payload.term : 'xterm-256color';
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

    if (!profileId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.profileIdRequired')), 400);
    }

    if (!Number.isInteger(cols) || cols < 20 || cols > 400) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.colsRange')), 400);
    }

    if (!Number.isInteger(rows) || rows < 10 || rows > 200) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.rowsRange')), 400);
    }

    const result = await context.localTerminalSessionService.createSession({
      locale: c.get('locale'),
      profileId,
      cols,
      rows,
      term,
      cwd,
    });

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.localTerminal.profileNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          translateValidationMessage(
            result.message,
            t('errors.localTerminal.sessionCreateFailed', { reason: result.message }),
            t('errors.localTerminal.sessionCreateFailedNoReason'),
          ),
        ),
        400,
      );
    }

    const successPayload: ApiLocalTerminalCreateSessionResponse = createApiSuccess({
      code: API_CODES.localTerminalSessionCreateOk,
      message: t('success.localTerminal.sessionCreated'),
      data: {
        sessionId: result.sessionId,
        profileId: result.profileId,
        websocketUrl: result.websocketUrl,
        websocketToken: result.websocketToken,
      },
    });

    return c.json(successPayload);
  });

  app.delete(API_PATHS.localTerminalCloseSession.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId || !context.localTerminalSessionService.closeSession(sessionId)) {
      return c.json(buildErrorPayload(API_CODES.sshSessionNotFound, t('errors.localTerminal.sessionNotFound')), 404);
    }

    return c.body(null, 204);
  });
};
