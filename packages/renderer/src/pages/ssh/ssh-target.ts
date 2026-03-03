import { listLocalTerminalProfiles, listSshServers } from '../../lib/backend';
import { getActiveSshServerId, parseTerminalTarget } from '../../lib/ssh-target';
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
export const resolveTerminalTarget = async (): Promise<ResolvedTerminalTarget> => {
  const activeTarget = parseTerminalTarget(getActiveSshServerId());
  if (activeTarget?.type === 'local-terminal') {
    const profileName = await resolveLocalTerminalProfileName(activeTarget.id);
    return {
      type: 'local-terminal',
      profileId: activeTarget.id,
      profileName,
    };
  }

  const serverResponse = await listSshServers();
  const servers = serverResponse.data.items;

  if (servers.length === 0) {
    throw new Error('No SSH server is configured yet.');
  }

  const preferredTarget = parseTerminalTarget(getActiveSshServerId());
  const preferredServerId = preferredTarget?.type === 'ssh-server' ? preferredTarget.id : null;
  if (preferredServerId) {
    const preferredServer = servers.find((item) => item.id === preferredServerId);
    if (preferredServer) {
      return {
        type: 'ssh-server',
        server: preferredServer,
      };
    }
  }

  return {
    type: 'ssh-server',
    server: servers[0],
  };
};
