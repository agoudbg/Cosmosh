let activeSshServerId: string | null = null;
let shouldOpenSshEditorCreateMode = false;

export const setActiveSshServerId = (serverId: string): void => {
  const trimmed = serverId.trim();
  activeSshServerId = trimmed.length > 0 ? trimmed : null;
};

export const getActiveSshServerId = (): string | null => {
  return activeSshServerId;
};

export const requestSshEditorCreateMode = (): void => {
  shouldOpenSshEditorCreateMode = true;
};

export const consumeSshEditorCreateMode = (): boolean => {
  const shouldConsume = shouldOpenSshEditorCreateMode;
  shouldOpenSshEditorCreateMode = false;
  return shouldConsume;
};
