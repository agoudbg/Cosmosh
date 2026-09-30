import { DEFAULT_TERMINAL_CLIPBOARD_ACCESS } from '@cosmosh/api-contract';

import { listLocalTerminalProfiles, listSshServers } from '../../lib/backend';
import type { SshConnectionIntent, SshResolvedTargetSnapshot } from '../../types/tabs';
import type { ResolvedTerminalTarget } from './ssh-types';

/**
 * Resolves the display name of a local terminal profile.
 *
 * This helper is intentionally resilient because profile listing can fail
 * during startup races; returning `null` keeps SSH page boot non-blocking.
 *
 * @param profileId Local terminal profile id.
 * @returns Profile display name or `null` when unavailable.
 */
export const resolveLocalTerminalProfileName = async (profileId: string): Promise<string | null> => {
  try {
    const response = await listLocalTerminalProfiles();
    const profile = response.data.items.find((item) => item.id === profileId);
    if (!profile?.name) {
      return null;
    }

    return profile.name;
  } catch {
    return null;
  }
};

/**
 * Converts one resolved runtime target into immutable retry snapshot.
 *
 * @param target Resolved runtime target.
 * @returns Immutable snapshot used by retries and mirror panes.
 */
export const toResolvedTargetSnapshot = (target: ResolvedTerminalTarget): SshResolvedTargetSnapshot => {
  const capturedAt = Date.now();
  if (target.type === 'local-terminal') {
    return {
      type: 'local-terminal',
      profileId: target.profileId,
      profileName: target.profileName,
      capturedAt,
    };
  }

  return {
    type: 'ssh-server',
    serverId: target.server.id,
    serverName: target.server.name,
    strictHostKey: target.server.strictHostKey ?? true,
    enableSshCompression: target.server.enableSshCompression ?? false,
    disableCharacterWidthCompatibilityMode: target.server.disableCharacterWidthCompatibilityMode ?? false,
    terminalClipboardAccess: target.server.terminalClipboardAccess ?? DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
    capturedAt,
  };
};

/**
 * Resolves runtime target from immutable snapshot only.
 *
 * @param snapshot Resolved snapshot captured during a previous successful resolve.
 * @param signal Optional cancellation signal.
 * @returns Resolved runtime target.
 */
export const resolveTerminalTargetFromSnapshot = async (
  snapshot: SshResolvedTargetSnapshot,
  signal?: AbortSignal,
): Promise<ResolvedTerminalTarget> => {
  if (snapshot.type === 'local-terminal') {
    const profileName = await resolveLocalTerminalProfileName(snapshot.profileId);
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    return {
      type: 'local-terminal',
      profileId: snapshot.profileId,
      profileName,
    };
  }

  const serverResponse = await listSshServers();
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const server = serverResponse.data.items.find((item) => item.id === snapshot.serverId);
  if (!server) {
    throw new Error('Selected SSH server no longer exists.');
  }

  return {
    type: 'ssh-server',
    server: {
      ...server,
      strictHostKey: snapshot.strictHostKey,
      enableSshCompression: snapshot.enableSshCompression,
      disableCharacterWidthCompatibilityMode: snapshot.disableCharacterWidthCompatibilityMode,
      terminalClipboardAccess: snapshot.terminalClipboardAccess,
    },
  };
};

/**
 * Resolves which terminal target should be opened for the page.
 *
 * Priority order:
 * 1) Explicit local profile stored in active target.
 * 2) Preferred SSH server id in active target.
 * 3) First available SSH server.
 *
 * @returns Resolved terminal target used to create the next session.
 * @throws Error when no SSH server has been configured.
 */
export const resolveTerminalTargetFromIntent = async (
  intent: SshConnectionIntent,
  signal?: AbortSignal,
): Promise<ResolvedTerminalTarget> => {
  if (!intent.target) {
    throw new Error('No SSH target selected for this tab.');
  }

  if (intent.target.type === 'local-terminal') {
    const profileName = await resolveLocalTerminalProfileName(intent.target.id);
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    return {
      type: 'local-terminal',
      profileId: intent.target.id,
      profileName,
    };
  }

  const serverResponse = await listSshServers();
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const servers = serverResponse.data.items;

  if (servers.length === 0) {
    throw new Error('No SSH server is configured yet.');
  }

  const preferredServer = servers.find((item) => item.id === intent.target?.id);
  if (!preferredServer) {
    throw new Error('Selected SSH server no longer exists.');
  }

  return {
    type: 'ssh-server',
    server: preferredServer,
  };
};
