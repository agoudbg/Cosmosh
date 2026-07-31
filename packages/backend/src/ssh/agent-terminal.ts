/**
 * Agent attachment and command state machine for one renderer-owned SSH PTY.
 *
 * The controller never parses prompts or terminal bytes. Its owner supplies
 * only events already authenticated by Remote Enhancements, which makes command
 * ownership independent from terminal escape sequences and visual heuristics.
 */

import type {
  AgentTerminalAttachmentStatus,
  McpClientInfo,
  McpConnectionMode,
  RemoteShellEventMessage,
} from '@cosmosh/api-contract';

import type { McpClock } from '../mcp/types.js';
import { systemMcpClock } from '../mcp/types.js';

/**
 * Identity of the Agent currently allowed to use one SSH session.
 */
export type AgentTerminalAttachment = {
  connectionId: string;
  client: McpClientInfo;
  mode: Extract<McpConnectionMode, 'terminal' | 'attached'>;
  agentCreatedTab: boolean;
};

/**
 * Successful result produced from trusted command lifecycle events.
 */
export type AgentTerminalCommandResult = {
  type: 'completed';
  output: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  userIntervened: boolean;
};

/**
 * Result returned when the caller stops waiting or the terminal disappears.
 */
export type AgentTerminalCommandFailure = {
  type: 'cancelled' | 'detached' | 'terminal-closed' | 'write-failed';
  message: string;
};

/** Complete Agent PTY command result union. */
export type AgentTerminalCommandOutcome = AgentTerminalCommandResult | AgentTerminalCommandFailure;

type ActiveCommand = {
  connectionId: string;
  startedAtMs: number;
  commandId: string | null;
  output: string;
  outputBytes: number;
  maxOutputBytes: number;
  truncated: boolean;
  userIntervened: boolean;
  callerSettled: boolean;
  resolve: (result: AgentTerminalCommandOutcome) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  abortHandler: () => void;
};

/**
 * Controls one Agent attachment and at most one in-flight command.
 */
export class AgentTerminalController {
  private readonly clock: McpClock;

  private readonly onStatusChanged: (status: AgentTerminalAttachmentStatus) => void;

  private attachment: AgentTerminalAttachment | null = null;

  private activeCommand: ActiveCommand | null = null;

  /**
   * Creates an Agent terminal controller.
   *
   * @param options Injectable clock and renderer status sink.
   */
  public constructor(options: { clock?: McpClock; onStatusChanged: (status: AgentTerminalAttachmentStatus) => void }) {
    this.clock = options.clock ?? systemMcpClock;
    this.onStatusChanged = options.onStatusChanged;
  }

  /**
   * Grants one Agent access to this terminal.
   *
   * @param attachment Non-terminal identity shown to the renderer.
   * @returns True when attached, or false when another Agent already owns it.
   */
  public attach(attachment: AgentTerminalAttachment): boolean {
    if (this.attachment) {
      return false;
    }

    this.attachment = attachment;
    this.emitStatus();
    return true;
  }

  /**
   * Revokes Agent access while preserving the underlying terminal.
   *
   * @param connectionId Expected owning MCP connection.
   * @returns True when the matching attachment was removed.
   */
  public detach(connectionId: string): boolean {
    if (this.attachment?.connectionId !== connectionId) {
      return false;
    }

    this.finishCaller(
      {
        type: 'detached',
        message: 'The Agent was detached from the terminal.',
      },
      true,
    );
    this.attachment = null;
    this.onStatusChanged({ type: 'agent-attachment-status', state: 'detached', connectionId });
    return true;
  }

  /**
   * Returns the current attachment without exposing terminal identity.
   *
   * @returns Current attachment, or null.
   */
  public getAttachment(): AgentTerminalAttachment | null {
    return this.attachment;
  }

  /**
   * Whether a command still owns the PTY lifecycle.
   *
   * Timed-out and cancelled callers leave the command active until its trusted
   * command-end event arrives, preventing a second Agent command from racing it.
   *
   * @returns True while a remote Agent command remains in flight.
   */
  public isBusy(): boolean {
    return this.activeCommand !== null;
  }

  /**
   * Starts one command after the owning service has verified prompt readiness.
   *
   * @param input Command, bounds, cancellation, and PTY write callback.
   * @returns Trusted merged output and exit metadata, or a lifecycle failure.
   */
  public async runCommand(input: {
    connectionId: string;
    command: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
    write: (data: string) => void;
  }): Promise<AgentTerminalCommandOutcome> {
    if (this.attachment?.connectionId !== input.connectionId) {
      return { type: 'detached', message: 'The Agent is not attached to this terminal.' };
    }
    if (this.activeCommand) {
      return { type: 'write-failed', message: 'The terminal is already running an Agent command.' };
    }
    if (input.signal.aborted) {
      return {
        type: 'cancelled',
        message: 'The Agent stopped waiting before the command was written to the terminal.',
      };
    }

    let resolveCommand!: (result: AgentTerminalCommandOutcome) => void;
    const result = new Promise<AgentTerminalCommandOutcome>((resolve) => {
      resolveCommand = resolve;
    });
    const abortHandler = (): void => {
      this.finishCaller({
        type: 'cancelled',
        message: 'The Agent stopped waiting; the remote command may still be running in the visible terminal.',
      });
    };
    const timer = this.clock.setTimeout(() => {
      const command = this.activeCommand;
      if (!command || command.callerSettled) {
        return;
      }

      this.finishCaller({
        type: 'completed',
        output: command.output,
        exitCode: null,
        truncated: command.truncated,
        timedOut: true,
        durationMs: Math.max(0, this.clock.now() - command.startedAtMs),
        userIntervened: command.userIntervened,
      });
    }, input.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.activeCommand = {
      connectionId: input.connectionId,
      startedAtMs: this.clock.now(),
      commandId: null,
      output: '',
      outputBytes: 0,
      maxOutputBytes: input.maxOutputBytes,
      truncated: false,
      userIntervened: false,
      callerSettled: false,
      resolve: resolveCommand,
      timer,
      signal: input.signal,
      abortHandler,
    };
    input.signal.addEventListener('abort', abortHandler, { once: true });
    this.emitStatus();

    try {
      input.write(`${input.command}\r`);
    } catch (error: unknown) {
      this.finishCaller(
        {
          type: 'write-failed',
          message: error instanceof Error ? error.message : 'Failed to write the Agent command to the terminal.',
        },
        true,
      );
    }

    return await result;
  }

  /**
   * Captures visible PTY output only between trusted command lifecycle events.
   *
   * @param data Visible output with helper control frames already removed.
   */
  public handleOutput(data: string): void {
    const command = this.activeCommand;
    if (!command || !command.commandId || command.callerSettled) {
      return;
    }

    const remainingBytes = command.maxOutputBytes - command.outputBytes;
    if (remainingBytes <= 0) {
      command.truncated = true;
      return;
    }

    const appended = takeUtf8Prefix(data, remainingBytes);
    command.output += appended;
    command.outputBytes += Buffer.byteLength(appended, 'utf8');
    if (appended.length < data.length) {
      command.truncated = true;
    }
  }

  /**
   * Applies one trusted helper command lifecycle event.
   *
   * @param event Event already validated against the installed helper contract.
   */
  public handleRemoteShellEvent(event: RemoteShellEventMessage): void {
    const command = this.activeCommand;
    if (!command) {
      return;
    }

    if (event.event === 'command-start' && !command.commandId) {
      command.commandId = event.commandId;
      return;
    }

    if (event.event !== 'command-end' || event.commandId !== command.commandId) {
      return;
    }

    if (!command.callerSettled) {
      this.finishCaller(
        {
          type: 'completed',
          output: command.output,
          exitCode: event.exitCode,
          truncated: command.truncated,
          timedOut: false,
          durationMs: event.durationMs,
          userIntervened: command.userIntervened,
        },
        true,
      );
      return;
    }
    this.clearActiveCommand();
    this.emitStatus();
  }

  /**
   * Records that renderer input may have changed Agent command behavior.
   */
  public markUserIntervened(): void {
    if (this.activeCommand) {
      this.activeCommand.userIntervened = true;
    }
  }

  /**
   * Fails and clears terminal ownership when the SSH session is destroyed.
   */
  public closeTerminal(): void {
    const connectionId = this.attachment?.connectionId;
    this.finishCaller(
      {
        type: 'terminal-closed',
        message: 'The visible terminal was closed.',
      },
      true,
    );
    this.attachment = null;
    this.onStatusChanged({ type: 'agent-attachment-status', state: 'detached', connectionId });
  }

  /**
   * Resolves the waiting caller while optionally clearing remote command ownership.
   *
   * @param result Result returned to the MCP caller.
   * @param clearActive Whether trusted remote command ownership is also finished.
   */
  private finishCaller(result: AgentTerminalCommandOutcome, clearActive = false): void {
    const command = this.activeCommand;
    if (!command) {
      return;
    }

    if (!command.callerSettled) {
      command.callerSettled = true;
      this.clock.clearTimeout(command.timer);
      command.signal.removeEventListener('abort', command.abortHandler);
      command.resolve(result);
    }

    if (clearActive) {
      this.clearActiveCommand();
    }
    this.emitStatus();
  }

  /**
   * Removes one completed command and its cancellation resources.
   */
  private clearActiveCommand(): void {
    const command = this.activeCommand;
    if (!command) {
      return;
    }

    this.clock.clearTimeout(command.timer);
    command.signal.removeEventListener('abort', command.abortHandler);
    this.activeCommand = null;
  }

  /**
   * Emits the renderer-safe current attachment state.
   */
  private emitStatus(): void {
    if (!this.attachment) {
      this.onStatusChanged({ type: 'agent-attachment-status', state: 'detached' });
      return;
    }

    this.onStatusChanged({
      type: 'agent-attachment-status',
      state: this.activeCommand ? 'running' : 'idle',
      connectionId: this.attachment.connectionId,
      client: this.attachment.client,
      mode: this.attachment.mode,
      agentCreatedTab: this.attachment.agentCreatedTab,
    });
  }
}

/**
 * Takes the longest prefix that fits a UTF-8 byte budget without splitting a
 * Unicode scalar value.
 *
 * @param value Candidate string.
 * @param maxBytes Available byte budget.
 * @returns Valid UTF-8 prefix.
 */
const takeUtf8Prefix = (value: string, maxBytes: number): string => {
  let result = '';
  let usedBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }

    result += character;
    usedBytes += characterBytes;
  }

  return result;
};
