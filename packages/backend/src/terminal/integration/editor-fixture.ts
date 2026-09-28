import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type {
  RemoteShellEventMessage,
  ShellEditorBuffer,
  ShellEditorRequest,
  ShellEditorSnapshot,
} from '@cosmosh/api-contract';

import { executeShellEditorRequest, type ShellEditorExecOptions } from '../../ssh/editor-exec.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { type FixtureShell, type FixtureTerminal, openFixtureTerminal } from './fixture-client.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const binary = path.join(workspace, '.cosmosh/terminal-fixture/cosmosh-bootstrap-linux-amd64');
/** Real helper's private editor identity, observed only through its actual OSC output. */
export type EditorEvent = Extract<RemoteShellEventMessage, { event: 'editor-state' }>;

/** @param shell Disposable fixture account. @returns Its verified, fixed helper executable path. */
export const editorBinaryPath = (shell: FixtureShell): string =>
  '/home/cosmosh-' + shell + '/.local/share/cosmosh/bootstrap/bin/cosmosh-bootstrap';

/** @param shell Disposable fixture account. @returns Nothing after building and installing the actual Go helper. */
export const installFixtureEditor = async (shell: FixtureShell): Promise<void> => {
  execFileSync('go', ['build', '-o', binary, './cmd/cosmosh-bootstrap'], {
    cwd: path.join(workspace, 'packages/remote-bootstrap'),
    env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
    timeout: 60_000,
    stdio: 'pipe',
  });
  const terminal = await openFixtureTerminal(shell);
  try {
    const installer = '/home/cosmosh-' + shell + '/fixture-bootstrap';
    await new Promise<void>((resolve, reject) =>
      terminal.client.sftp((error, sftp) => {
        if (error) {
          reject(error);
          return;
        }
        sftp.fastPut(binary, installer, { mode: 0o700 }, (error) => {
          sftp.end();
          if (error) reject(error);
          else resolve();
        });
      }),
    );
    const result = await executeBoundedSshCommand(
      terminal.client,
      installer + ' install --shell ' + shell + ' --version fixture-v3',
    );
    assert.match(result ?? '', /"state":"(?:ok|skipped)"/u);
  } finally {
    terminal.close();
  }
};

/** Real helper observer; it never infers a prompt or an editor buffer from rendered screen text. */
export class EditorFixture {
  private parser = new RemoteShellEventOscParser();
  private offset = 0;
  private latest: EditorEvent | null = null;
  /** @param terminal Actual disposable SSH PTY. @param shell Original fixture Shell. */
  constructor(
    readonly terminal: FixtureTerminal,
    readonly shell: FixtureShell = 'bash',
  ) {}
  /** @returns The latest original helper editor epoch. */
  collect(): EditorEvent | null {
    const output = this.terminal.readOutput(this.offset);
    this.offset += output.length;
    for (const frame of this.parser.parse(output))
      if (
        frame.type === 'event' &&
        frame.event.event === 'editor-state' &&
        (!this.latest || this.latest.shellInstanceId === frame.event.shellInstanceId)
      )
        this.latest = frame.event;
    return this.latest;
  }
  /** @param after Previous epoch. @returns A newly observed real editor epoch. */
  async prompt(after = 0): Promise<EditorEvent> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const event = this.collect();
      if (event && event.promptGeneration > after) return event;
      await delay(10);
    }
    throw new Error('Actual editor epoch did not arrive: ' + JSON.stringify(this.latest));
  }
  /** @param command Fixture-owned command. @returns Its next editor epoch. */
  async run(command: string): Promise<EditorEvent> {
    const generation = this.collect()?.promptGeneration ?? 0;
    this.terminal.write(command + '\r');
    return await this.prompt(generation);
  }
  /** @returns The next real prompt after canceling editing or the foreground program. */
  async cancel(): Promise<EditorEvent> {
    const generation = this.collect()?.promptGeneration ?? 0;
    this.terminal.write('\x03');
    return await this.prompt(generation);
  }
  /**
   * @param operation Requested permission scope. @param expected Exact previous observation.
   * @param replacement Data-only edit. @param options Explicit cancellation/race test boundary.
   * @returns Actual remote worker and original Shell result.
   */
  async request(
    operation: 'context' | 'snapshot' | 'apply',
    expected?: ShellEditorSnapshot,
    replacement?: ShellEditorBuffer,
    options?: Partial<ShellEditorExecOptions>,
  ) {
    const event = await this.prompt();
    assert.equal(event.available, true, 'real helper must own its editor registration');
    const request: ShellEditorRequest = {
      requestId: randomUUID(),
      target: { instanceId: event.shellInstanceId, shell: this.shell, pid: event.pid, startTime: event.startTime },
      operation,
      promptGeneration: event.promptGeneration,
      includeDirectory: true,
      ...(event.notification ? { notification: event.notification } : {}),
      ...(expected ? { expected } : {}),
      ...(replacement ? { replacement } : {}),
    };
    return await executeShellEditorRequest(this.terminal.client, editorBinaryPath(this.shell), request, {
      signal: new AbortController().signal,
      isCurrent: () => true,
      trigger: () => {
        if (!event.notification) this.terminal.write('\x1b[997;' + event.triggerNonce + '~');
      },
      ...options,
    });
  }
}
