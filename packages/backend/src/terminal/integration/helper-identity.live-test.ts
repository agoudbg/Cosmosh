import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { RemoteShellEventMessage } from '@cosmosh/api-contract';
import { DEFAULT_SETTINGS_VALUES } from '@cosmosh/api-contract';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import {
  applyShellContextEvent,
  createShellContext,
  invalidateShellInput,
  resolveShellPermissions,
} from '../shell-context.js';
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
  context = createShellContext('fixture', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true);

  /** @param terminal Real fixture whose captured PTY bytes will be parsed. */
  constructor(private readonly terminal: FixtureTerminal) {}

  /** Parses only bytes that arrived after the previous observation. @returns Current event count. */
  collect(): number {
    const output = this.terminal.readOutput(this.offset);
    this.offset += output.length;
    for (const frame of this.parser.parse(output))
      if (frame.type === 'event') {
        this.events.push(frame.event);
        this.context = applyShellContextEvent(this.context, frame.event);
      }
    assert.ok(this.events.length < 4096, 'helper event loop must stay bounded');
    return this.events.length;
  }

  /**
   * Executes one fixture command and waits for the original Shell's next real prompt.
   * @param command Test-owned command with explicitly quoted fixture paths.
   * @returns Confirmed directory metadata after the command.
   */
  async run(command: string) {
    const boundary = this.collect();
    const owner = this.context.shellInstanceId;
    this.context = invalidateShellInput(this.context, command + '\r');
    this.terminal.write(command + '\r');
    await this.waitFor((event) => event.event === 'prompt-ready' && event.shellInstanceId === owner, boundary);
    return this.context.cwd;
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
    { timeout: 120_000 },
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

      // All directories belong to disposable fixture accounts. Quoted names include Unicode and a final newline.
      const root = '/home/cosmosh-' + shell + '/cwd-' + randomUUID();
      const physical = root + '/actual/child';
      const link = root + '/link';
      const unusual = root + '/space 中文\n';
      await executeBoundedSshCommand(
        terminal.client,
        "mkdir -p '" + physical + "' '" + unusual + "'; ln -s '" + root + "/actual' '" + link + "'",
      );
      const linked = await events.run("cd '" + link + "/child'");
      assert.equal(linked?.logical, link + '/child');
      assert.equal(linked?.physical, physical);
      const failed = await events.run("cd '" + root + "/does-not-exist'");
      assert.deepEqual(failed, linked, 'failed cd must not move the confirmed directory');
      const movedBack = await events.run('cd ..');
      assert.equal(movedBack?.physical, root + '/actual');
      const unusualCwd = await events.run(
        shell === 'fish' ? 'cd ' + root + '/space\\ 中文\\n' : "cd $'" + root + "/space 中文\\n'",
      );
      assert.equal(unusualCwd?.logical, unusual);
      assert.equal(unusualCwd?.physical, unusual, 'trailing newline must survive pwd serialization');
      const home = '/home/cosmosh-' + shell;
      const customHome = root + '/custom home ';
      const changedHome = await events.run(
        shell === 'fish' ? "set -gx HOME '" + customHome + "'" : "export HOME='" + customHome + "'",
      );
      assert.equal(changedHome?.home, customHome);
      const missingHome = await events.run(shell === 'fish' ? 'set -e HOME' : 'unset HOME');
      assert.equal(missingHome?.home, null);
      await events.run(shell === 'fish' ? "set -gx HOME '" + home + "'" : "export HOME='" + home + "'");
      const deleted = root + '/deleted';
      await executeBoundedSshCommand(terminal.client, "mkdir '" + deleted + "'");
      await events.run("cd '" + deleted + "'");
      await executeBoundedSshCommand(terminal.client, "rmdir '" + deleted + "'");
      assert.equal((await events.run('true'))?.physical, null, 'deleted physical directory is unavailable');
      await events.run("cd '" + home + "'");

      if (shell === 'bash') {
        const hookBoundary = events.collect();
        terminal.write("bash --noprofile --norc\rPROMPT_COMMAND='cd " + physical + "'; source " + helper + '\r');
        const hookShell = await events.waitFor(
          (event) => event.event === 'integration-ready' && event.shellInstanceId !== original.shellInstanceId,
          hookBoundary,
        );
        const hookCwd = await events.waitFor(
          (event) => event.event === 'cwd' && event.shellInstanceId === hookShell.shellInstanceId,
          hookBoundary,
        );
        assert.equal(hookCwd.physicalCwd, physical, 'directory report follows user PROMPT_COMMAND');
        await events.waitFor(
          (event) => event.event === 'prompt-ready' && event.shellInstanceId === hookShell.shellInstanceId,
          hookBoundary,
        );
        await events.run('exit');
      }
      if (shell === 'fish') {
        const leftBoundary = events.collect();
        await events.run(
          "functions --copy fish_prompt __fixture_saved_prompt; function fish_prompt; cd '" +
            physical +
            "'; printf 'FIXTURE> '; end",
        );
        await events.waitFor((event) => event.event === 'cwd-invalidated', leftBoundary);
        assert.equal(events.context.cwd, null, 'the user left prompt can invalidate an earlier directory report');
        assert.equal((await events.run('true'))?.physical, physical, 'a stable prompt confirms the new directory');
        await events.run("function fish_right_prompt; printf 'RIGHT'; return 23; end");
        await events.run(
          'functions --copy fish_right_prompt __fixture_saved_right; function fish_right_prompt; ' +
            "__fixture_saved_right; set -l saved_status $status; printf 'EXTRA'; return $saved_status; end",
        );
        const wrapperOutput = terminal.readOutput().length;
        await events.run("fish_right_prompt; printf '\\nRIGHT_STATUS:%s\\n' $status");
        assert.match(
          terminal.readOutput(wrapperOutput),
          /RIGHTEXTRA/u,
          'user prompt wrappers compose without recursion',
        );
        assert.match(
          terminal.readOutput(wrapperOutput),
          /\r?\nRIGHT_STATUS:23\r?\n/u,
          'user return status is preserved',
        );
        await events.run('functions --erase fish_prompt; functions --copy __fixture_saved_prompt fish_prompt');
        const rightBoundary = events.collect();
        await events.run("function fish_right_prompt; cd '" + root + "/actual'; printf 'RIGHT'; end");
        await events.waitFor((event) => event.event === 'cwd-invalidated', rightBoundary);
        assert.equal(events.context.cwd, null, 'a changed right prompt cannot retain the old directory');
        assert.equal((await events.run('true'))?.physical, root + '/actual');
        const titleBoundary = events.collect();
        await events.run(
          "functions --copy fish_title __fixture_saved_title; function fish_title; cd '" +
            root +
            "'; set -gx HOME '" +
            customHome +
            "'; printf 'TITLE'; end",
        );
        await events.waitFor((event) => event.event === 'cwd-invalidated', titleBoundary);
        assert.equal(events.context.cwd, null, 'a later title mutation disables the reported directory');
        assert.equal(events.context.status, 'paused');
        assert.equal(
          events.events.slice(titleBoundary).filter((event) => event.event === 'cwd-invalidated').length,
          1,
          'multiple directory/home changes emit at most one invalidation per prompt',
        );
        await events.run(
          'functions --erase fish_prompt fish_title; functions --copy __fixture_saved_prompt fish_prompt; ' +
            "functions --copy __fixture_saved_title fish_title; functions --erase fish_right_prompt; set -gx HOME '" +
            home +
            "'",
        );
        assert.equal(events.context.status, 'ready', 'the next complete prompt report restores directory usability');
      }

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

      const batchBoundary = events.collect();
      const batch = "true\rcd '" + root + "'\r";
      events.context = invalidateShellInput(events.context, batch, 'fixture-batch');
      terminal.write(batch);
      await events.waitFor((event) => event.event === 'cwd' && event.physicalCwd === root, batchBoundary);
      const batchCwd = events.events
        .slice(batchBoundary)
        .reverse()
        .find((event) => event.event === 'cwd');
      await events.waitFor(
        (event) => event.event === 'prompt-ready' && event.promptGeneration === batchCwd?.promptGeneration,
        batchBoundary,
      );
      assert.equal(events.context.cwd, null, 'unacknowledged typeahead cannot restore directory operations');
      assert.equal(events.context.status, 'paused');
    },
  );
}
