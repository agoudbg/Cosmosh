import type { ShellContext, TerminalCompletionUpdate } from '@cosmosh/api-contract';

/** One pane's authority to display and select an opaque Backend suggestion. */
export type CompletionViewRequest = {
  paneId: string;
  requestId: string;
  trigger: 'typing' | 'manual';
  sessionId: string;
  shellInstanceId: string;
  promptGeneration: number | null;
  snapshotId: string | null;
  contextRevision: number | null;
};

/**
 * Allows a query while the original editor is being reconfirmed after ordinary input.
 * The Backend still verifies delivery, reader state and permissions before reading.
 * @param context Latest Backend-owned pane context; local terminals have no eligible context.
 * @returns Whether the pane can request precise suggestions.
 */
export const canRequestTerminalCompletion = (context: ShellContext | null | undefined): boolean =>
  !!context?.shellInstanceId &&
  context.editorAvailable &&
  context.permissions.input &&
  context.capabilities.includes('input-snapshot') &&
  context.capabilities.includes('input-apply') &&
  (context.status === 'ready' || (context.status === 'paused' && context.reason === 'waiting-for-prompt'));

/**
 * Checks ownership without treating the query's own editor confirmation as new input.
 * Local input invalidates the request synchronously before a delayed context acknowledgement arrives.
 * @param request Current opaque query.
 * @param context Latest authoritative context.
 * @returns Whether pending work or displayed items still belong to this editor.
 */
export const retainsCompletionView = (
  request: CompletionViewRequest,
  context: ShellContext | null | undefined,
): boolean =>
  canRequestTerminalCompletion(context) &&
  context?.sessionId === request.sessionId &&
  context.shellInstanceId === request.shellInstanceId &&
  context.promptGeneration === request.promptGeneration &&
  (request.snapshotId === null || context.revision === request.contextRevision);

/**
 * Adopts cumulative results only after their exact context has reached this pane.
 * @param request Current query authority.
 * @param paneId Response owner.
 * @param context Latest authoritative context.
 * @param update Cumulative display data from Backend.
 * @returns Bound display authority, or null for stale, unsupported or unrelated results.
 */
export const bindCompletionViewUpdate = (
  request: CompletionViewRequest,
  paneId: string,
  context: ShellContext | null | undefined,
  update: TerminalCompletionUpdate,
): CompletionViewRequest | null => {
  if (
    request.paneId !== paneId ||
    request.requestId !== update.requestId ||
    !retainsCompletionView(request, context) ||
    context?.status !== 'ready' ||
    update.status !== 'ready' ||
    !update.snapshotId ||
    update.contextRevision !== context.revision ||
    (request.snapshotId !== null && request.snapshotId !== update.snapshotId)
  )
    return null;
  return { ...request, snapshotId: update.snapshotId, contextRevision: update.contextRevision };
};

/**
 * Explains an explicit empty query without exposing input or provider error details.
 * @param update The current query's final display result.
 * @returns A localized message key, or null for pending, populated or stale queries.
 */
export const completionQueryNotice = (update: TerminalCompletionUpdate): string | null => {
  if (!update.complete || update.items.length || update.status === 'stale') return null;
  const sources = Object.values(update.sources);
  const reason = sources.includes('timeout')
    ? 'queryTimeout'
    : sources.includes('private')
      ? 'queryPrivate'
      : update.status === 'unsupported'
        ? 'queryUnsupported'
        : update.status !== 'ready' || sources.includes('unavailable')
          ? 'queryUnavailable'
          : sources.includes('unsupported')
            ? 'queryUnsupported'
            : null;
  return reason ? `ssh.enhancementStatus.reasons.${reason}` : 'ssh.autocomplete.noMatches';
};

/**
 * Requests another observation after plain text or deletion without retaining the text.
 * Native keys, paste framing, submissions and controls only dismiss; manual queries remain available.
 * @param data Already-forwarded xterm input.
 * @returns Whether a debounced observation is appropriate.
 */
export const shouldQueryAfterTerminalInput = (data: string): boolean => {
  if (data.length === 0) return false;
  for (const character of data) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 8) || (code >= 128 && code <= 159)) return false;
  }
  return true;
};
