import assert from 'node:assert/strict';
import test from 'node:test';

import type { Client } from 'ssh2';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { SshSessionService } from '../../ssh/session-service.js';
import { openFixtureTerminal } from './fixture-client.js';

/** Invoke production history reading while the SSH transport remains real. */
type HistoryReader = { readRemoteHistory(session: { client: Client }): Promise<string[] | null> };

test('real history probe excludes interpreter and database input stores', { timeout: 20_000 }, async (t) => {
  const terminal = await openFixtureTerminal('bash');
  t.after(() => terminal.close());
  const setup = await executeBoundedSshCommand(
    terminal.client,
    "printf 'echo accepted-shell-command\\n' > .bash_history; " +
      'for file in .python_history .sqlite_history .mysql_history .lesshst .node_repl_history; do ' +
      'printf \'PRIVATE_REPL_SENTINEL\\n\' > "$file"; done; printf ready',
  );
  assert.equal(setup, 'ready');
  const reader = SshSessionService.prototype as unknown as HistoryReader;
  const commands = await reader.readRemoteHistory.call(SshSessionService.prototype, { client: terminal.client });
  assert.ok(commands?.includes('echo accepted-shell-command'));
  assert.equal(
    commands?.some((command) => command.includes('PRIVATE_REPL_SENTINEL')),
    false,
  );
});
