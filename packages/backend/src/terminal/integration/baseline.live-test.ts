import assert from 'node:assert/strict';
import test from 'node:test';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { FIXTURE_SHELLS, openFixtureTerminal } from './fixture-client.js';

for (const shell of FIXTURE_SHELLS) {
  test(`real ${shell} SSH PTY preserves input, cwd, Unicode and exit`, { timeout: 30_000 }, async (t) => {
    const terminal = await openFixtureTerminal(shell);
    t.after(() => terminal.close());
    let offset = terminal.write("printf 'COSMOSH_READY:%s\\n' 'ok'\r");
    await terminal.waitFor(/COSMOSH_READY:ok\r?\n/u, offset);

    offset = terminal.write('cd fixtures; printf \'COSMOSH_CWD:%s\\n\' "$PWD"\r');
    await terminal.waitFor(new RegExp(`COSMOSH_CWD:/home/cosmosh-${shell}/fixtures\\r?\\n`, 'u'), offset);

    // A background exec starts in the login directory, proving it is not the interactive CWD.
    const independentCwd = await executeBoundedSshCommand(terminal.client, 'pwd');
    assert.equal(independentCwd?.trim(), `/home/cosmosh-${shell}`);

    offset = terminal.write("printf 'COSMOSH_FILE:'; cat '中文文件.txt'; printf 'COSMOSH_UNICODE:%s\\n' '中文😀'\r");
    await terminal.waitFor(/COSMOSH_FILE:terminal fixture\r?\n/u, offset);
    await terminal.waitFor(/COSMOSH_UNICODE:中文😀\r?\n/u, offset);

    offset = terminal.write("printf 'COSMOSH_GOODBYE:%s\\n' 'ok'; exit\r");
    await terminal.waitFor(/COSMOSH_GOODBYE:ok\r?\n/u, offset);
    assert.equal(await terminal.waitForExit(), 0);
  });
}
