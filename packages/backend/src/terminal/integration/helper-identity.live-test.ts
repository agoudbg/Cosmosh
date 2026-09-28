import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { RemoteShellEventMessage } from '@cosmosh/api-contract';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { FIXTURE_SHELLS, type FixtureTerminal, openFixtureTerminal } from './fixture-client.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const binary = path.join(workspace, '.cosmosh/terminal-fixture/cosmosh-bootstrap-linux-amd64');

before(() => {
  // Build the actual installer; only disposable loopback fixture accounts receive it.
  execFileSync('go', ['build', '-o', binary, './cmd/cosmosh-bootstrap'], {
    cwd: path.join(workspace, 'packages/remote-bootstrap'),
    env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
    timeout: 60_000,
    stdio: 'pipe',
  });
});

/** Incremental parser over actual fixture output, retaining only bounded normalized metadata. */
class ShellEvents {
  private readonly parser = new RemoteShellEventOscParser();
  private offset = 0;
  readonly events: RemoteShellEventMessage[] = [];

  /** @param terminal Real fixture whose captured PTY bytes will be parsed. */
  constructor(private readonly terminal: FixtureTerminal) {}

  /** Parses only bytes that arrived after the previous observation. @returns Current event count. */
  collect(): number {
    const output = this.terminal.readOutput(this.offset);
    this.offset += output.length;
    for (const frame of this.parser.parse(output)) if (frame.type === 'event') this.events.push(frame.event);
    assert.ok(this.events.length < 4096, 'helper event loop must stay bounded');
    return this.events.length;
  }

  /**
   * Waits for a real normalized event, never synthesizing Shell state.
   * @param predicate Event condition.
   * @param after Exclusive event-count boundary captured before an action.
   * @returns Matching event, or an explicit deadline failure.
   */
  async waitFor(predicate: (event: RemoteShellEventMessage) => boolean, after = 0): Promise<RemoteShellEventMessage> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      this.collect();
      const found = this.events.slice(after).find(predicate);
      if (found) return found;
      await delay(10);
    }
    throw new Error('Expected helper event was not observed. Events: ' + JSON.stringify(this.events.slice(-8)));
  }
}

for (const shell of FIXTURE_SHELLS) {
  test(
    'installed ' + shell + ' helper keeps independent identities across repeated sources, nested shells and terminals',
    { timeout: 60_000 },
    async (t) => {
      const installerTerminal = await openFixtureTerminal(shell);
      t.after(() => installerTerminal.close());
      await new Promise<void>((resolve, reject) => {
        installerTerminal.client.sftp((error, sftp) => {
          if (error) {
            reject(error);
            return;
          }
          sftp.fastPut(binary, '/home/cosmosh-' + shell + '/fixture-bootstrap', { mode: 0o700 }, (error) => {
            sftp.end();
            if (error) reject(error);
            else resolve();
          });
        });
      });
      const installation = await executeBoundedSshCommand(
        installerTerminal.client,
        '/home/cosmosh-' + shell + '/fixture-bootstrap install --shell ' + shell + ' --version fixture-v3',
        { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
      );
      assert.ok(
        installation?.includes('"state":"ok"') || installation?.includes('"state":"skipped"'),
        'real installer must install or validate its current installation',
      );
      const statusOutput = await executeBoundedSshCommand(
        installerTerminal.client,
        '/home/cosmosh-' + shell + '/fixture-bootstrap status --shell ' + shell,
      );
      const installed: unknown = JSON.parse(statusOutput ?? 'null');
      assert.ok(installed && typeof installed === 'object');
      for (const property of ['installed', 'helperCurrent', 'profileCurrent'] as const) {
        assert.ok(
          property in installed && Reflect.get(installed, property) === true,
          'installed helper verification failed: ' + property,
        );
      }
      assert.ok('protocolVersion' in installed && installed.protocolVersion === 3);
      assert.ok('version' in installed && installed.version === 'fixture-v3');
      installerTerminal.close();

      const terminal = await openFixtureTerminal(shell);
      t.after(() => terminal.close());
      const events = new ShellEvents(terminal);
      const original = await events.waitFor((event) => event.event === 'integration-ready');
      const firstPrompt = await events.waitFor((event) => event.event === 'prompt-ready');
      assert.equal(original.protocolVersion, 3);
      assert.match(original.shellInstanceId, /^[a-f0-9-]{36}$/u);
      assert.equal(original.shell, shell);
      assert.equal(
        original.capabilities.includes('input-snapshot'),
        false,
        'unimplemented editor operations must not be advertised',
      );
      assert.equal(firstPrompt.shellInstanceId, original.shellInstanceId);

      const helper = '$HOME/.config/cosmosh/bootstrap/helper.' + (shell === 'fish' ? 'fish' : 'sh');
      const sourceBoundary = events.collect();
      terminal.write('source ' + helper + '; source ' + helper + '\r');
      const repeat = await events.waitFor((event) => event.event === 'prompt-ready', sourceBoundary);
      assert.equal(repeat.shellInstanceId, original.shellInstanceId);
      assert.equal(
        events.events.slice(sourceBoundary).filter((event) => event.event === 'integration-ready').length,
        0,
      );
      assert.ok(
        repeat.event === 'prompt-ready' &&
          firstPrompt.event === 'prompt-ready' &&
          (repeat.promptGeneration ?? 0) > (firstPrompt.promptGeneration ?? 0),
        'repeat sourcing must not reset prompt generations',
      );

      const childBoundary = events.collect();
      terminal.write(shell + '\r');
      const child = await events.waitFor(
        (event) => event.event === 'integration-ready' && event.shellInstanceId !== original.shellInstanceId,
        childBoundary,
      );
      await events.waitFor(
        (event) => event.event === 'prompt-ready' && event.shellInstanceId === child.shellInstanceId,
        childBoundary,
      );
      const exitBoundary = events.collect();
      terminal.write('exit\r');
      const resumed = await events.waitFor(
        (event) => event.event === 'prompt-ready' && event.shellInstanceId === original.shellInstanceId,
        exitBoundary,
      );
      assert.equal(resumed.shellInstanceId, original.shellInstanceId);

      const sibling = await openFixtureTerminal(shell);
      t.after(() => sibling.close());
      const siblingReady = await new ShellEvents(sibling).waitFor((event) => event.event === 'integration-ready');
      assert.notEqual(siblingReady.shellInstanceId, original.shellInstanceId);
      assert.notEqual(siblingReady.shellInstanceId, child.shellInstanceId);

      const nonInteractive = await executeBoundedSshCommand(
        terminal.client,
        shell + " -c 'source " + helper + "; printf NONINTERACTIVE_OK'",
      );
      assert.equal(nonInteractive, 'NONINTERACTIVE_OK', 'non-interactive exec must never emit helper OSC');
    },
  );
}
