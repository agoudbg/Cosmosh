let activeSshServerId: string | null = null;

export const setActiveSshServerId = (serverId: string): void => {
  const trimmed = serverId.trim();
  activeSshServerId = trimmed.length > 0 ? trimmed : null;
};

export const getActiveSshServerId = (): string | null => {
  return activeSshServerId;
};
