/**
 * MCP HTTP surface.
 *
 * Two concerns live here:
 *  - {@link registerMcpManagementRoutes} exposes the authenticated `/api/v1/mcp/*`
 *    management API the renderer uses to read status, manage the pairing token,
 *    inspect clients/connections, resolve authorization prompts, and open the
 *    renderer event channel. These sit behind the shared internal-token guard.
 *  - {@link registerMcpEndpoint} mounts the externally-reachable `/mcp`
 *    streamable-HTTP endpoint with independent Bearer (pairing token) auth; it is
 *    rejected with 503 while MCP is disabled and 401 on a bad token.
 */

import crypto from 'node:crypto';

import {
  API_CODES,
  API_PATHS,
  type ApiMcpBindTerminalLaunchRequest,
  type ApiMcpBindTerminalLaunchResponse,
  type ApiMcpCreateEventsChannelResponse,
  type ApiMcpListApprovalsResponse,
  type ApiMcpListClientsResponse,
  type ApiMcpListConnectionsResponse,
  type ApiMcpListTerminalLaunchesResponse,
  type ApiMcpResolveApprovalRequest,
  type ApiMcpResolveApprovalResponse,
  type ApiMcpRotatePairingTokenResponse,
  type ApiMcpStatusResponse,
  createApiSuccess,
  isMcpApprovalUserDecision,
} from '@cosmosh/api-contract';

import { isRecord } from '../../validation-utils.js';
import { buildErrorPayload } from '../errors.js';
import { type BackendHttpApp, getTranslator } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

const MCP_ENDPOINT_PATH = '/mcp';
const MCP_TERMINAL_SESSION_ID_MAX_LENGTH = 128;

/**
 * Validates renderer-owned terminal session identifiers before they cross into MCP state.
 *
 * @param value Candidate request value.
 * @returns Whether the value is a bounded, non-empty terminal session identifier.
 */
const isValidTerminalSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MCP_TERMINAL_SESSION_ID_MAX_LENGTH;

/**
 * Extracts a Bearer token from an Authorization header value.
 *
 * @param header Raw Authorization header, if present.
 * @returns The token, or undefined when absent/malformed.
 */
const parseBearerToken = (header: string | undefined): string | undefined => {
  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
};

/**
 * Registers the authenticated renderer-facing MCP management API.
 *
 * @param app Backend Hono app.
 * @param context Shared backend context.
 */
export const registerMcpManagementRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.get(API_PATHS.mcpGetStatus, async (c) => {
    const t = getTranslator(c);
    const status = await context.mcpService.getStatus();
    const payload: ApiMcpStatusResponse = createApiSuccess({
      code: API_CODES.mcpStatusGetOk,
      message: t('success.mcp.statusFetched'),
      data: status,
    });

    return c.json(payload);
  });

  app.post(API_PATHS.mcpRotatePairingToken, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const token = await context.mcpService.rotatePairingToken(requestId);
    const payload: ApiMcpRotatePairingTokenResponse = createApiSuccess({
      code: API_CODES.mcpPairingTokenRotateOk,
      message: t('success.mcp.pairingTokenRotated'),
      requestId,
      data: token,
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.mcpRevokePairingToken, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    if (!(await context.mcpService.hasPairingToken())) {
      return c.json(buildErrorPayload(API_CODES.mcpPairingTokenNotFound, t('errors.mcp.pairingTokenNotFound')), 404);
    }

    await context.mcpService.revokePairingToken(requestId);
    return c.body(null, 204);
  });

  app.get(API_PATHS.mcpListClients, (c) => {
    const t = getTranslator(c);
    const payload: ApiMcpListClientsResponse = createApiSuccess({
      code: API_CODES.mcpClientListOk,
      message: t('success.mcp.clientsFetched'),
      data: {
        items: context.mcpService.listClients(),
      },
    });

    return c.json(payload);
  });

  app.get(API_PATHS.mcpListConnections, (c) => {
    const t = getTranslator(c);
    const payload: ApiMcpListConnectionsResponse = createApiSuccess({
      code: API_CODES.mcpConnectionListOk,
      message: t('success.mcp.connectionsFetched'),
      data: {
        items: context.mcpService.listConnectionSummaries(),
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.mcpCloseConnection.replace('{connectionId}', ':connectionId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const connectionId = c.req.param('connectionId');
    if (!connectionId) {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const closed = await context.mcpService.closeConnectionFromUi(connectionId, requestId);
    if (!closed) {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.connectionNotFound')), 404);
    }

    return c.body(null, 204);
  });

  app.post(API_PATHS.mcpDetachConnection.replace('{connectionId}', ':connectionId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const connectionId = c.req.param('connectionId');
    if (!connectionId) {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const detached = await context.mcpService.detachConnectionFromUi(connectionId, requestId);
    if (!detached) {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.connectionNotFound')), 404);
    }

    return c.body(null, 204);
  });

  app.post(API_PATHS.mcpInterruptConnection.replace('{connectionId}', ':connectionId'), (c) => {
    const t = getTranslator(c);
    const connectionId = c.req.param('connectionId');
    if (!connectionId || !context.mcpService.stopTerminalCommandFromUi(connectionId)) {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.connectionNotFound')), 404);
    }

    return c.body(null, 204);
  });

  app.get(API_PATHS.mcpListApprovals, (c) => {
    const t = getTranslator(c);
    const payload: ApiMcpListApprovalsResponse = createApiSuccess({
      code: API_CODES.mcpApprovalListOk,
      message: t('success.mcp.approvalsFetched'),
      data: {
        items: context.mcpService.listApprovals(),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.mcpResolveApproval.replace('{approvalId}', ':approvalId'), async (c) => {
    const t = getTranslator(c);
    const approvalId = c.req.param('approvalId');
    if (!approvalId) {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const body = (await c.req.json().catch(() => undefined)) as ApiMcpResolveApprovalRequest | undefined;
    if (
      !isRecord(body) ||
      !isMcpApprovalUserDecision(body.decision) ||
      (body.terminalSessionId !== undefined && !isValidTerminalSessionId(body.terminalSessionId))
    ) {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.mcp.invalidDecision')), 400);
    }

    const terminalSessionId = isValidTerminalSessionId(body.terminalSessionId) ? body.terminalSessionId : undefined;
    const result = await context.mcpService.resolveApproval(approvalId, body.decision, terminalSessionId);
    if (result === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.mcpApprovalNotFound, t('errors.mcp.approvalNotFound')), 404);
    }
    if (result === 'audit-unavailable') {
      return c.json(buildErrorPayload(API_CODES.mcpAuditUnavailable, t('errors.mcp.auditUnavailable')), 503);
    }
    if (result === 'terminal-not-found') {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.connectionNotFound')), 404);
    }
    if (result !== 'resolved') {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.validation.invalidPayload')), 409);
    }

    const payload: ApiMcpResolveApprovalResponse = createApiSuccess({
      code: API_CODES.mcpApprovalResolveOk,
      message: t('success.mcp.approvalResolved'),
      data: {
        approvalId,
        decision: body.decision,
      },
    });

    return c.json(payload);
  });

  app.get(API_PATHS.mcpListTerminalLaunches, (c) => {
    const t = getTranslator(c);
    const payload: ApiMcpListTerminalLaunchesResponse = createApiSuccess({
      code: API_CODES.mcpTerminalLaunchListOk,
      message: t('success.mcp.terminalLaunchesFetched'),
      data: {
        items: context.mcpService.listTerminalLaunches(),
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.mcpCancelTerminalLaunch.replace('{launchId}', ':launchId'), (c) => {
    const t = getTranslator(c);
    const launchId = c.req.param('launchId');
    if (!launchId || !context.mcpService.cancelTerminalLaunch(launchId)) {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.terminalLaunchNotFound')), 404);
    }

    return c.body(null, 204);
  });

  app.post(API_PATHS.mcpBindTerminalLaunch.replace('{launchId}', ':launchId'), async (c) => {
    const t = getTranslator(c);
    const launchId = c.req.param('launchId');
    const body = (await c.req.json().catch(() => undefined)) as ApiMcpBindTerminalLaunchRequest | undefined;
    if (!launchId || !isRecord(body) || !isValidTerminalSessionId(body.terminalSessionId)) {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const result = await context.mcpService.bindTerminalLaunch(launchId, body.terminalSessionId);
    if (result.type === 'launch-not-found' || result.type === 'terminal-not-found') {
      return c.json(buildErrorPayload(API_CODES.mcpConnectionNotFound, t('errors.mcp.terminalLaunchNotFound')), 404);
    }
    if (result.type !== 'success') {
      return c.json(buildErrorPayload(API_CODES.mcpValidationFailed, t('errors.mcp.terminalUnavailable')), 409);
    }

    const payload: ApiMcpBindTerminalLaunchResponse = createApiSuccess({
      code: API_CODES.mcpTerminalLaunchBindOk,
      message: t('success.mcp.terminalLaunchBound'),
      data: {
        connection: result.connection,
      },
    });
    return c.json(payload);
  });

  app.post(API_PATHS.mcpCreateEventsChannel, (c) => {
    const t = getTranslator(c);
    const channel = context.mcpService.createEventsChannel();
    if (!channel) {
      return c.json(buildErrorPayload(API_CODES.mcpDisabled, t('errors.mcp.disabled')), 503);
    }

    const payload: ApiMcpCreateEventsChannelResponse = createApiSuccess({
      code: API_CODES.mcpEventsChannelCreateOk,
      message: t('success.mcp.eventsChannelCreated'),
      data: channel,
    });

    return c.json(payload);
  });
};

/**
 * Mounts the externally-reachable `/mcp` streamable-HTTP endpoint.
 *
 * @param app Backend Hono app.
 * @param context Shared backend context.
 */
export const registerMcpEndpoint = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.all(MCP_ENDPOINT_PATH, async (c) => {
    const t = getTranslator(c);
    if (!context.mcpService.isEnabled()) {
      return c.json(buildErrorPayload(API_CODES.mcpDisabled, t('errors.mcp.disabled')), 503);
    }

    const token = parseBearerToken(c.req.header('authorization'));
    if (!(await context.mcpService.validateBearer(token))) {
      return c.json(buildErrorPayload(API_CODES.authInvalidToken, t('errors.common.invalidInternalAuthToken')), 401);
    }

    return await context.mcpService.handleRequest(c.req.raw);
  });
};
