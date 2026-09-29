import type {
  ShellContext,
  ShellDirectoryContext,
  TerminalClientMessage,
  TerminalServerMessage,
} from '@cosmosh/api-contract';

/** The live source of a directory action, including its exact connected transport. */
export type DirectoryRequestOwner = {
  socket: object;
  context: ShellContext;
  send: (message: TerminalClientMessage) => void;
};

/** One bounded directory request; it retains metadata only, never terminal input. */
type PendingDirectory = {
  paneId: string;
  requestId: string;
  owner: DirectoryRequestOwner;
  resolve: (directory: ShellDirectoryContext | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Confirms directories at the moment of use and rejects replies from replaced panes or input.
 * The caller invalidates synchronously before forwarding input, filling credentials, closing or changing panes.
 * A public acknowledgement of input sent before this query may arrive later; Backend binds that ordered input.
 */
export class TerminalDirectoryRequests {
  private readonly pending = new Map<string, PendingDirectory>();

  /**
   * @param owner Reads the current original Shell and connected socket for a pane.
   * @param timeoutMs UI deadline, slightly longer than the backend's private observation deadline.
   */
  constructor(
    private readonly owner: (paneId: string) => DirectoryRequestOwner | null,
    private readonly timeoutMs = 12_000,
  ) {}

  /** @param context Current metadata. @returns Whether a directory-only observation can be requested. */
  private eligible(context: ShellContext): boolean {
    return (
      context.permissions.cwd &&
      context.capabilities.includes('cwd') &&
      !!context.shellInstanceId &&
      (context.status === 'ready' || (context.status === 'paused' && context.reason === 'waiting-for-prompt'))
    );
  }

  /** @param pending Original request. @param next Current owner. @returns Whether its original input and connection still own the action. */
  private current(pending: PendingDirectory, next: DirectoryRequestOwner | null): boolean {
    const before = pending.owner.context;
    const after = next?.context;
    return (
      !!next &&
      next.socket === pending.owner.socket &&
      !!after &&
      this.eligible(after) &&
      before.sessionId === after.sessionId &&
      before.shellInstanceId === after.shellInstanceId &&
      before.promptGeneration === after.promptGeneration
    );
  }

  /** @param pending Finished request. @param directory Fresh result, or null on any lost authority. @returns Nothing. */
  private finish(pending: PendingDirectory, directory: ShellDirectoryContext | null): void {
    if (this.pending.get(pending.paneId) !== pending) return;
    this.pending.delete(pending.paneId);
    clearTimeout(pending.timer);
    pending.resolve(directory);
  }

  /** @param paneId Optional owner to release; omission releases all panes. @returns Nothing; failed optional sends cannot interrupt input. */
  invalidate(paneId?: string): void {
    for (const pending of [...this.pending.values()]) {
      if (paneId !== undefined && paneId !== pending.paneId) continue;
      this.finish(pending, null);
      try {
        pending.owner.send({ type: 'directory-cancel', requestId: pending.requestId });
      } catch {
        console.warn('[ssh][directory] Failed to cancel an optional directory observation.');
      }
    }
  }

  /** @param paneId Source pane. @returns Fresh directory metadata only while the same input and transport remain current. */
  request(paneId: string): Promise<ShellDirectoryContext | null> {
    this.invalidate(paneId);
    const owner = this.owner(paneId);
    if (!owner || !this.eligible(owner.context)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const pending: PendingDirectory = {
        paneId,
        requestId,
        owner,
        resolve,
        timer: setTimeout(() => this.invalidate(paneId), this.timeoutMs),
      };
      this.pending.set(paneId, pending);
      try {
        owner.send({ type: 'directory-query', requestId });
      } catch {
        this.finish(pending, null);
        console.warn('[ssh][directory] Failed to request an optional directory observation.');
      }
    });
  }

  /** @param paneId Context owner. @param context New state, before React renders it. @returns Nothing; revision-only confirmation is permitted. */
  contextChanged(paneId: string, context: ShellContext): void {
    const pending = this.pending.get(paneId);
    const owner = this.owner(paneId);
    if (pending && !this.current(pending, owner ? { ...owner, context } : null)) this.invalidate(paneId);
  }

  /** @param paneId Reply owner. @param message Fresh backend result. @returns Nothing; old request IDs never affect a newer action. */
  receive(paneId: string, message: Extract<TerminalServerMessage, { type: 'directory-result' }>): void {
    const pending = this.pending.get(paneId);
    if (!pending || pending.requestId !== message.requestId) return;
    const owner = this.owner(paneId);
    const confirmed =
      message.status === 'ok' &&
      this.current(pending, owner) &&
      owner?.context.status === 'ready' &&
      owner.context.revision === message.contextRevision;
    this.finish(pending, confirmed ? message.directory : null);
  }
}
