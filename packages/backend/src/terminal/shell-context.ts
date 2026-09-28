import type {
  RemoteShellCapability,
  RemoteShellEventMessage,
  SettingsValues,
  ShellContext,
  ShellContextReason,
  ShellDirectoryContext,
  ShellPermissions,
} from '@cosmosh/api-contract';

/** Backend-only pending report; a directory becomes usable only at its matching original-Shell prompt. */
export type ShellContextState = ShellContext & {
  pendingDirectory?: { directory: ShellDirectoryContext; promptGeneration: number | null } | null;
  /** Typeahead may belong to a running program; only a verified editor exchange can resolve this ambiguity. */
  requiresEditorConfirmation?: boolean;
  /** Private verified editor binding; reset at every execution/transport boundary. */
  editorBinding?: { pid: number; startTime: string; triggerNonce: string; promptGeneration: number } | null;
};

/**
 * Excludes unconfirmed reports from transport snapshots.
 * @param state Backend-owned state.
 * @returns Public, confirmed context metadata only.
 */
export const getShellContextSnapshot = (state: ShellContextState): ShellContext => {
  const context = { ...state };
  delete context.pendingDirectory;
  delete context.requiresEditorConfirmation;
  delete context.editorBinding;
  return context;
};

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
): ShellContextState => ({
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
  submissionToken: null,
  promptGeneration: null,
  cwdGeneration: 0,
  cwd: null,
  lastKnownCwd: null,
});

/**
 * Invalidates outstanding editor work before any bytes reach the remote PTY.
 * @param context Current session context.
 * @param input Raw bytes used only for immediate boundary detection, never retained.
 * @param submissionToken Opaque client submission identifier acknowledged before forwarding the bytes.
 * @returns New generation and, for submit/cancel, a paused context until a fresh Shell prompt.
 */
export const invalidateShellInput = (
  context: ShellContextState,
  input: string,
  submissionToken?: string,
): ShellContextState => {
  // Count transport boundaries without parsing or retaining command text. CRLF is one boundary.
  let submissionCount = 0;
  for (let index = 0; index < input.length && submissionCount < 2; index += 1) {
    const character = input[index];
    if (character === '\r' || character === '\n' || character === '\u0003' || character === '\u0004') {
      submissionCount += 1;
      if (character === '\r' && input[index + 1] === '\n') index += 1;
    }
  }
  const submitted = submissionCount > 0;
  return {
    ...context,
    revision: context.revision + 1,
    inputGeneration: context.inputGeneration + 1,
    submissionToken: submitted ? (submissionToken ?? null) : context.submissionToken,
    requiresEditorConfirmation:
      context.requiresEditorConfirmation ||
      submissionCount > 1 ||
      (submitted &&
        (context.status === 'busy' ||
          context.status === 'initializing' ||
          context.reason === 'input-submitted' ||
          context.reason === 'foreign-shell')),
    ...(submitted && context.status !== 'unavailable'
      ? { status: 'paused' as const, reason: 'input-submitted' as const, cwd: null, pendingDirectory: null }
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
  context: ShellContextState,
  reason: ShellContextReason,
  unavailable = false,
): ShellContextState => ({
  ...context,
  revision: context.revision + 1,
  inputGeneration: context.inputGeneration + 1,
  status: unavailable ? 'unavailable' : 'paused',
  reason,
  cwd: null,
  pendingDirectory: null,
  editorBinding: null,
  ...(unavailable ? { capabilities: [], promptGeneration: null } : {}),
});

/**
 * Updates permission and erases directory metadata immediately after a CWD opt-out.
 * @param context Current context.
 * @param permissions Newly persisted permissions.
 * @returns Original object when unchanged, otherwise an invalidated context.
 */
export const updateShellPermissions = (
  context: ShellContextState,
  permissions: ShellPermissions,
): ShellContextState => {
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
    ...(!permissions.cwd
      ? { cwd: null, lastKnownCwd: null, pendingDirectory: null, cwdGeneration: context.cwdGeneration + 1 }
      : {}),
  };
};

/**
 * Applies an event only after the service has validated the installed helper's exact version/capabilities.
 * A nested Shell cannot replace the original Shell identity; only the original prompt resumes it.
 * @param context Current context.
 * @param event Normalized helper event.
 * @returns Next state, or the original object for a rejected/stale event.
 */
export const applyShellContextEvent = (
  context: ShellContextState,
  event: RemoteShellEventMessage,
): ShellContextState => {
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
  if (event.event === 'editor-state') {
    if (event.promptGeneration !== context.promptGeneration) return context;
    return {
      ...context,
      revision: context.revision + 1,
      editorBinding: event.available
        ? {
            pid: event.pid,
            startTime: event.startTime,
            triggerNonce: event.triggerNonce,
            promptGeneration: event.promptGeneration,
          }
        : null,
    };
  }
  if (event.event === 'prompt-ready') {
    if (event.promptGeneration === undefined && event.shell !== 'sh' && event.shell !== 'ash')
      return suspendShellContext(context, 'unsupported-editor');
    if (
      event.promptGeneration !== undefined &&
      context.promptGeneration !== null &&
      event.promptGeneration <= context.promptGeneration
    )
      return context;
    const directory =
      context.permissions.cwd && context.pendingDirectory?.promptGeneration === (event.promptGeneration ?? null)
        ? context.pendingDirectory.directory
        : null;
    const previous = context.lastKnownCwd;
    const directoryChanged =
      directory !== null &&
      (previous?.logical !== directory.logical ||
        previous.physical !== directory.physical ||
        previous.home !== directory.home);
    return {
      ...context,
      revision: context.revision + 1,
      status: context.requiresEditorConfirmation ? 'paused' : 'ready',
      reason: context.requiresEditorConfirmation ? 'input-submitted' : null,
      promptGeneration: event.promptGeneration ?? null,
      cwd: context.requiresEditorConfirmation ? null : directory,
      lastKnownCwd: directory ?? context.lastKnownCwd,
      cwdGeneration: context.cwdGeneration + Number(directoryChanged),
      pendingDirectory: null,
      editorBinding: null,
    };
  }
  if (event.event === 'cwd-invalidated') {
    if (!context.permissions.cwd || event.promptGeneration !== context.promptGeneration) return context;
    return suspendShellContext(context, 'waiting-for-prompt');
  }
  if (event.event === 'cwd') {
    if (!context.permissions.cwd) return context;
    if (
      (event.promptGeneration === undefined && event.shell !== 'sh' && event.shell !== 'ash') ||
      (event.promptGeneration !== undefined &&
        context.promptGeneration !== null &&
        event.promptGeneration <= context.promptGeneration)
    )
      return context;
    const directory = { logical: event.cwd, physical: event.physicalCwd, home: event.homeDirectory };
    return {
      ...context,
      revision: context.revision + 1,
      status: 'initializing',
      reason: 'waiting-for-prompt',
      cwd: null,
      pendingDirectory: { directory, promptGeneration: event.promptGeneration ?? null },
    };
  }
  if (event.event === 'command-start' || event.event === 'foreground-command' || event.event === 'command-end') {
    return {
      ...context,
      revision: context.revision + 1,
      status: 'busy',
      reason: 'command-running',
      cwd: null,
      pendingDirectory: null,
      editorBinding: null,
    };
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
