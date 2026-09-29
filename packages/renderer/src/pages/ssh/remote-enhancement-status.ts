import type {
  RemoteEnhancementRuntimeStatus,
  SettingsValues,
  ShellContext,
  ShellHistoryView,
} from '@cosmosh/api-contract';

/** Current pane observations and live settings; this view never initiates a remote read. */
export type EnhancementStatusInput = {
  connectionState: 'connecting' | 'connected' | 'failed';
  serverEnabled: boolean;
  context: ShellContext | null;
  runtimeStatus: RemoteEnhancementRuntimeStatus | null;
  historyView: ShellHistoryView | null;
  settings: Pick<
    SettingsValues,
    | 'remoteEnhancementsEnabled'
    | 'remoteEnhancementsCwdEnabled'
    | 'remoteEnhancementsInputEnabled'
    | 'remoteEnhancementsHistoryEnabled'
    | 'terminalAutoCompleteEnabled'
    | 'terminalAutoCompletePathEnabled'
    | 'terminalNativeCompletionEnabled'
  >;
};

/** Localized diagnostic identifiers, separate from the helper's advertised capabilities. */
export type EnhancementDiagnostic = {
  state: 'available' | 'disabled' | 'paused' | 'unavailable' | 'partial';
  reason:
    | 'globalDisabled'
    | 'serverDisabled'
    | 'permissionDisabled'
    | 'suggestionsDisabled'
    | 'connecting'
    | 'disconnected'
    | 'waitingHelper'
    | 'helperUnavailable'
    | 'helperMismatch'
    | 'helperTimeout'
    | 'reconnectRequired'
    | 'unsupported'
    | 'commandRunning'
    | 'foreignShell'
    | 'unsupportedEditor'
    | 'waitingEditor'
    | 'directoryConfirmed'
    | 'directoryLogicalOnly'
    | 'directoryUnknown'
    | 'historyReady'
    | 'historyPartial'
    | 'historyPrivate'
    | 'historyUnavailable'
    | 'inputRequired'
    | 'directoryRequired'
    | 'verifiedEditingPending'
    | 'pathMenuPending'
    | 'nativeMenuPending';
};

/** Five independently explained capabilities; private command/history text is never included. */
export type EnhancementStatusModel = {
  summary: EnhancementDiagnostic['reason'] | 'helperConnected';
  directory: string | null;
  features: Array<
    EnhancementDiagnostic & { id: 'directory' | 'input' | 'history' | 'paths' | 'nativeCompletion'; allowed: boolean }
  >;
};

/**
 * Resolves connection-wide blockers without mistaking an installed helper for a working editor.
 * @param input Live pane and permission state. @returns A shared blocker, or null for an active helper.
 */
const sharedBlocker = (input: EnhancementStatusInput): EnhancementDiagnostic | null => {
  if (input.connectionState === 'connecting') return { state: 'paused', reason: 'connecting' };
  if (input.connectionState !== 'connected') return { state: 'unavailable', reason: 'disconnected' };
  if (!input.settings.remoteEnhancementsEnabled) return { state: 'disabled', reason: 'globalDisabled' };
  if (!input.serverEnabled) return { state: 'disabled', reason: 'serverDisabled' };
  const code = input.runtimeStatus?.code;
  if (input.runtimeStatus?.state === 'disabled') {
    if (code === 'PERMISSION_DISABLED' || code === 'REMOTE_ENHANCEMENTS_DISABLED')
      return { state: 'disabled', reason: 'reconnectRequired' };
    if (code === 'HELPER_CONTRACT_MISMATCH') return { state: 'unavailable', reason: 'helperMismatch' };
    if (code === 'HELPER_HANDSHAKE_TIMEOUT' || code === 'BOOTSTRAP_ENSURE_TIMEOUT')
      return { state: 'unavailable', reason: 'helperTimeout' };
    return { state: 'unavailable', reason: 'helperUnavailable' };
  }
  if (input.context?.status === 'unavailable') return { state: 'unavailable', reason: 'helperUnavailable' };
  if (input.runtimeStatus?.state !== 'active' || !input.context?.shellInstanceId)
    return { state: 'paused', reason: 'waitingHelper' };
  return null;
};

/**
 * Explains an unconfirmed original editor without reusing its last-known directory.
 * @param context Backend-owned current Shell metadata. @returns A pause reason, or null while ready.
 */
const editorBlocker = (context: ShellContext): EnhancementDiagnostic | null => {
  if (context.status === 'ready') return null;
  if (context.reason === 'foreign-shell') return { state: 'paused', reason: 'foreignShell' };
  if (context.reason === 'unsupported-editor') return { state: 'unavailable', reason: 'unsupportedEditor' };
  if (context.status === 'busy' || context.reason === 'command-running')
    return { state: 'paused', reason: 'commandRunning' };
  return { state: 'paused', reason: 'waitingEditor' };
};

/**
 * Combines actual observations with current opt-outs for display only. Permission and advertised
 * support never imply a successful read or an enabled completion consumer. Native history can be
 * observed independently while input editing is paused, so it uses its own accepted view.
 * @param input Current active pane plus current settings. @returns Text-free, deterministic diagnostics.
 */
export const resolveEnhancementStatus = (input: EnhancementStatusInput): EnhancementStatusModel => {
  const { context, settings } = input;
  const common = sharedBlocker(input);
  const preferences = {
    directory: settings.remoteEnhancementsCwdEnabled,
    input: settings.remoteEnhancementsInputEnabled,
    history: settings.remoteEnhancementsHistoryEnabled,
    paths: settings.terminalAutoCompletePathEnabled,
    nativeCompletion: settings.terminalNativeCompletionEnabled,
  };
  /** @param id Capability to explain. @returns Its current effective state and specific reason. */
  const explain = (id: EnhancementStatusModel['features'][number]['id']): EnhancementDiagnostic => {
    if (common) return common;
    if (!context) return { state: 'paused', reason: 'waitingHelper' };
    const enabled = {
      directory: settings.remoteEnhancementsCwdEnabled && context.permissions.cwd,
      input: settings.remoteEnhancementsInputEnabled && context.permissions.input,
      history: settings.remoteEnhancementsHistoryEnabled && context.permissions.history,
      paths: settings.terminalAutoCompletePathEnabled && context.permissions.paths,
      nativeCompletion: settings.terminalNativeCompletionEnabled && context.permissions.nativeCompletion,
    };
    if (!enabled[id]) return { state: 'disabled', reason: 'permissionDisabled' };
    if ((id === 'paths' || id === 'nativeCompletion') && !settings.terminalAutoCompleteEnabled)
      return { state: 'disabled', reason: 'suggestionsDisabled' };
    if (id === 'history') {
      if (context.shell !== 'fish' || !context.capabilities.includes('history-read'))
        return { state: 'unavailable', reason: 'unsupported' };
      switch (input.historyView?.status) {
        case 'ok':
          return { state: 'available', reason: 'historyReady' };
        case 'partial':
          return { state: 'partial', reason: 'historyPartial' };
        case 'private':
          return { state: 'paused', reason: 'historyPrivate' };
        case 'disabled':
          return { state: 'disabled', reason: 'permissionDisabled' };
        case 'unsupported':
          return { state: 'unavailable', reason: 'unsupported' };
        default:
          return { state: 'unavailable', reason: 'historyUnavailable' };
      }
    }
    if (id === 'directory') {
      if (!context.capabilities.includes('cwd')) return { state: 'unavailable', reason: 'unsupported' };
      const blocked = editorBlocker(context);
      if (blocked) return blocked;
      if (!context.cwd) return { state: 'paused', reason: 'directoryUnknown' };
      return context.cwd.physical
        ? { state: 'available', reason: 'directoryConfirmed' }
        : { state: 'partial', reason: 'directoryLogicalOnly' };
    }
    if (id === 'nativeCompletion' && context.shell !== 'fish') return { state: 'unavailable', reason: 'unsupported' };
    if (!enabled.input) return { state: 'disabled', reason: 'inputRequired' };
    if (id !== 'input' && !enabled.directory) return { state: 'disabled', reason: 'directoryRequired' };
    if (!context.capabilities.includes('input-snapshot')) return { state: 'unavailable', reason: 'unsupported' };
    const blocked = editorBlocker(context);
    if (blocked) return blocked;
    // These sources exist independently; no current UI consumer can claim verified filling yet.
    return {
      state: 'unavailable',
      reason: id === 'input' ? 'verifiedEditingPending' : id === 'paths' ? 'pathMenuPending' : 'nativeMenuPending',
    };
  };
  const features = (['directory', 'history', 'input', 'paths', 'nativeCompletion'] as const).map((id) => ({
    id,
    allowed: settings.remoteEnhancementsEnabled && input.serverEnabled && preferences[id],
    ...explain(id),
  }));
  return {
    summary: common?.reason ?? 'helperConnected',
    directory:
      features[0].state === 'available' || features[0].state === 'partial' ? (context?.cwd?.logical ?? null) : null,
    features,
  };
};
