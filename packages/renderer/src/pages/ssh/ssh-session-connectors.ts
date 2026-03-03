import { createLocalTerminalSession, createSshSession, trustSshFingerprint } from '../../lib/backend';
import type { HostFingerprintPrompt, ResolvedTerminalTarget } from './ssh-types';

export type OpenTerminalSessionResult = {
  sessionType: 'ssh-server' | 'local-terminal';
  sessionId: string;
  socket: WebSocket;
};

type OpenTerminalSessionParams = {
  target: ResolvedTerminalTarget;
  cols: number;
  rows: number;
  term: string;
  connectTimeoutSec: number;
  requestHostFingerprintTrust: (prompt: HostFingerprintPrompt) => Promise<boolean>;
  hostFingerprintNotTrustedMessage: string;
};

/**
 * Opens a websocket-backed terminal session for either local or SSH target.
 *
 * @param params Target/session metadata and trust-confirm callback.
 * @param params.target Resolved terminal target selected by the page.
 * @param params.cols Initial terminal columns.
 * @param params.rows Initial terminal rows.
 * @param params.term Terminal emulator name sent to backend.
 * @param params.connectTimeoutSec SSH connect timeout in seconds.
 * @param params.requestHostFingerprintTrust Callback invoked when host is untrusted.
 * @param params.hostFingerprintNotTrustedMessage Error message used when user rejects trust.
 * @returns Session id/type and the connected websocket instance.
 * @throws Error When session creation fails or host fingerprint is rejected.
 */
export const openTerminalSessionSocket = async (
  params: OpenTerminalSessionParams,
): Promise<OpenTerminalSessionResult> => {
  const { target, cols, rows, term, connectTimeoutSec, requestHostFingerprintTrust, hostFingerprintNotTrustedMessage } =
    params;

  if (target.type === 'local-terminal') {
    const createResult = await createLocalTerminalSession({
      profileId: target.profileId,
      cols,
      rows,
      term,
    });

    const websocketUrl = new URL(createResult.data.websocketUrl);
    websocketUrl.searchParams.set('token', createResult.data.websocketToken);
    const socket = new WebSocket(websocketUrl.toString());

    return {
      sessionType: 'local-terminal',
      sessionId: createResult.data.sessionId,
      socket,
    };
  }

  let createResult = await createSshSession({
    serverId: target.server.id,
    cols,
    rows,
    term,
    connectTimeoutSec,
  });

  if (!createResult.success && createResult.code === 'SSH_HOST_UNTRUSTED') {
    const confirmed = await requestHostFingerprintTrust({
      serverId: createResult.data.serverId,
      host: createResult.data.host,
      port: createResult.data.port,
      algorithm: createResult.data.algorithm,
      fingerprint: createResult.data.fingerprint,
    });

    if (!confirmed) {
      throw new Error(hostFingerprintNotTrustedMessage);
    }

    await trustSshFingerprint({
      serverId: createResult.data.serverId,
      fingerprintSha256: createResult.data.fingerprint,
      algorithm: createResult.data.algorithm,
    });

    createResult = await createSshSession({
      serverId: target.server.id,
      cols,
      rows,
      term,
      connectTimeoutSec,
    });
  }

  if (!createResult.success) {
    throw new Error(createResult.message);
  }

  const websocketUrl = new URL(createResult.data.websocketUrl);
  websocketUrl.searchParams.set('token', createResult.data.websocketToken);
  const socket = new WebSocket(websocketUrl.toString());

  return {
    sessionType: 'ssh-server',
    sessionId: createResult.data.sessionId,
    socket,
  };
};
