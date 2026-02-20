let activeSshServerId: string | null = null;
let shouldOpenSshEditorCreateMode = false;

export const LOCAL_TERMINAL_TARGET_PREFIX = 'local-terminal:';

export const toLocalTerminalTargetId = (profileId: string): string => {
  return `${LOCAL_TERMINAL_TARGET_PREFIX}${profileId}`;
};

export const parseTerminalTarget = (
  targetId: string | null,
):
  | {
      type: 'ssh-server';
      id: string;
    }
  | {
      type: 'local-terminal';
      id: string;
    }
  | null => {
  if (!targetId) {
    return null;
  }

  if (targetId.startsWith(LOCAL_TERMINAL_TARGET_PREFIX)) {
    const profileId = targetId.slice(LOCAL_TERMINAL_TARGET_PREFIX.length).trim();
    if (!profileId) {
      return null;
    }

    return {
      type: 'local-terminal',
      id: profileId,
    };
  }

  const trimmed = targetId.trim();
  if (!trimmed) {
    return null;
  }

  return {
    type: 'ssh-server',
    id: trimmed,
  };
};

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
