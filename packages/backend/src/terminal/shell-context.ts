import type {
  RemoteShellCapability,
  RemoteShellEventMessage,
  SettingsValues,
  ShellContext,
  ShellContextReason,
  ShellPermissions,
} from '@cosmosh/api-contract';

/**
 * Resolves per-session permission without allowing request flags to override persisted opt-outs.
 * @param settings Current persisted application settings.
 * @param serverAllowed Persisted server/request enhancement gate resolved at session creation.
 * @returns Permissions used independently from advertised helper capabilities.
 */
export const resolveShellPermissions = (settings: SettingsValues, serverAllowed: boolean): ShellPermissions => {
  const enabled = settings.remoteEnhancementsEnabled && serverAllowed;
  return {
    cwd: enabled && settings.remoteEnhancementsCwdEnabled,
    input: enabled && settings.remoteEnhancementsInputEnabled,
    history: enabled && settings.terminalAutoCompleteHistoryEnabled,
    paths: enabled && settings.terminalAutoCompletePathEnabled,
    nativeCompletion: enabled && settings.terminalNativeCompletionEnabled,
  };
};

/**
 * Creates one session's authoritative, text-free enhancement state.
 * @param sessionId Backend session identity.
 * @param permissions Effective user permission.
 * @param pending Whether installation validation allows a live handshake.
 * @returns Initial state; no capability is usable before a matching handshake and prompt.
 */
export const createShellContext = (
  sessionId: string,
  permissions: ShellPermissions,
  pending: boolean,
): ShellContext => ({
  sessionId,
  shellInstanceId: null,
  shell: null,
  helperVersion: null,
  protocolVersion: null,
  capabilities: [],
  permissions: { ...permissions },
  status: pending ? 'initializing' : 'unavailable',
  reason: pending ? 'waiting-for-prompt' : 'helper-unavailable',
  revision: 0,
  inputGeneration: 0,
  promptGeneration: null,
  cwdGeneration: 0,
  cwd: null,
  lastKnownCwd: null,
});

/**
 * Invalidates outstanding editor work before any bytes reach the remote PTY.
 * @param context Current session context.
 * @param input Raw bytes used only for immediate boundary detection, never retained.
 * @returns New generation and, for submit/cancel, a paused context until a fresh Shell prompt.
 */
export const invalidateShellInput = (context: ShellContext, input: string): ShellContext => {
  const submitted = ['\r', '\n', '\u0003', '\u0004'].some((boundary) => input.includes(boundary));
  return {
    ...context,
    revision: context.revision + 1,
    inputGeneration: context.inputGeneration + 1,
    ...(submitted && context.status !== 'unavailable'
      ? { status: 'paused' as const, reason: 'input-submitted' as const, cwd: null }
      : {}),
  };
};

/**
 * Clears usability while retaining only explicitly permitted last-known directory metadata.
 * @param context Current context.
 * @param reason Observable pause/disable cause.
 * @param unavailable Whether the runtime can no longer recover without reconnecting.
 * @returns Context with all outstanding operations invalidated.
 */
export const suspendShellContext = (
  context: ShellContext,
  reason: ShellContextReason,
  unavailable = false,
): ShellContext => ({
  ...context,
  revision: context.revision + 1,
  inputGeneration: context.inputGeneration + 1,
  status: unavailable ? 'unavailable' : 'paused',
  reason,
  cwd: null,
  ...(unavailable ? { capabilities: [], promptGeneration: null } : {}),
});

/**
 * Updates permission and erases directory metadata immediately after a CWD opt-out.
 * @param context Current context.
 * @param permissions Newly persisted permissions.
 * @returns Original object when unchanged, otherwise an invalidated context.
 */
export const updateShellPermissions = (context: ShellContext, permissions: ShellPermissions): ShellContext => {
  if (
    (Object.keys(permissions) as Array<keyof ShellPermissions>).every(
      (key) => context.permissions[key] === permissions[key],
    )
  )
    return context;
  return {
    ...context,
    permissions: { ...permissions },
    revision: context.revision + 1,
    inputGeneration: context.inputGeneration + 1,
    ...(!permissions.cwd ? { cwd: null, lastKnownCwd: null, cwdGeneration: context.cwdGeneration + 1 } : {}),
  };
};

/**
 * Applies an event only after the service has validated the installed helper's exact version/capabilities.
 * A nested Shell cannot replace the original Shell identity; only the original prompt resumes it.
 * @param context Current context.
 * @param event Normalized helper event.
 * @returns Next state, or the original object for a rejected/stale event.
 */
export const applyShellContextEvent = (context: ShellContext, event: RemoteShellEventMessage): ShellContext => {
  if (context.status === 'unavailable') return context;
  if (context.shellInstanceId && context.shellInstanceId !== event.shellInstanceId) {
    return context.reason === 'foreign-shell' ? context : suspendShellContext(context, 'foreign-shell');
  }
  if (event.event === 'integration-ready') {
    if (context.shellInstanceId) return context;
    return {
      ...context,
      shellInstanceId: event.shellInstanceId,
      shell: event.shell,
      helperVersion: event.helperVersion,
      protocolVersion: event.protocolVersion,
      capabilities: [...event.capabilities],
      revision: context.revision + 1,
      status: 'initializing',
      reason: 'waiting-for-prompt',
    };
  }
  if (!context.shellInstanceId) return context;
  if (event.event === 'prompt-ready') {
    if (event.promptGeneration === undefined && event.shell !== 'sh' && event.shell !== 'ash')
      return suspendShellContext(context, 'unsupported-editor');
    if (
      event.promptGeneration !== undefined &&
      context.promptGeneration !== null &&
      event.promptGeneration <= context.promptGeneration
    )
      return context;
    return {
      ...context,
      revision: context.revision + 1,
      status: 'ready',
      reason: null,
      promptGeneration: event.promptGeneration ?? null,
      cwd: context.permissions.cwd ? context.lastKnownCwd : null,
    };
  }
  if (event.event === 'cwd') {
    if (!context.permissions.cwd) return context;
    const directory = { logical: event.cwd, physical: null, home: null };
    return {
      ...context,
      revision: context.revision + 1,
      cwdGeneration: context.cwdGeneration + Number(context.lastKnownCwd?.logical !== event.cwd),
      lastKnownCwd: directory,
      cwd: context.status === 'ready' ? directory : null,
    };
  }
  if (event.event === 'command-start' || event.event === 'foreground-command' || event.event === 'command-end') {
    return { ...context, revision: context.revision + 1, status: 'busy', reason: 'command-running', cwd: null };
  }
  return context;
};

/**
 * Checks installed capability, user permission, and current original-Shell usability together.
 * @param context Current authoritative context.
 * @param capability Requested helper capability.
 * @returns Whether a consumer may attempt the operation; editor application must still verify its live buffer.
 */
export const canUseShellCapability = (context: ShellContext, capability: RemoteShellCapability): boolean => {
  if (context.status !== 'ready' || !context.capabilities.includes(capability)) return false;
  if (capability === 'cwd') return context.permissions.cwd && context.cwd !== null;
  if (capability === 'input-snapshot' || capability === 'input-apply') return context.permissions.input;
  if (capability === 'directory-read')
    return context.permissions.paths && context.permissions.cwd && context.cwd !== null;
  if (capability === 'history-read') return context.permissions.history;
  if (capability === 'native-completion')
    return (
      context.permissions.nativeCompletion &&
      context.permissions.input &&
      context.permissions.cwd &&
      context.cwd !== null
    );
  return true;
};
