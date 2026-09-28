import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';

import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  quoteShellLiteral,
  quoteShellPath,
} from '../completion/snapshot-edits.js';
import { EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const shells = ['bash', 'zsh', 'fish'] as const;
before(async () => {
  for (const shell of shells) await installFixtureEditor(shell);
});

for (const shell of shells) {
  test(
    'real ' + shell + ' receives quoted completion as one literal argument after explicit Enter',
    { timeout: 90_000 },
    async (t) => {
      const terminal = await openFixtureTerminal(
        shell,
        shell === 'fish' ? '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish' : undefined,
        shell === 'fish' ? { disableFishAutosuggestions: true } : undefined,
      );
      t.after(() => terminal.close());
      const fixture = new EditorFixture(terminal, shell);
      await fixture.prompt();
      const marker = 'COSMOSH_ARG_' + randomUUID().replaceAll('-', '') + ':';
      const script =
        'import sys; print("' +
        marker +
        '"+str(len(sys.argv)-1)+":"+sys.argv[1].encode().hex()+":"+sys.argv[2].encode().hex())';
      const prefix = 'python3 -c ' + quoteShellLiteral(shell, script) + ' ';
      const suffix = " 'tail sentinel'";
      for (const value of [
        'My File.txt',
        "single'quote",
        'double"quote',
        'back\\slash',
        '$HOME; printf COSMOSH_UNEXPECTED',
        '$(printf COSMOSH_UNEXPECTED)',
        '中文🐟👩‍💻e\u0301',
        '-option',
        'a\u00a0b',
      ]) {
        terminal.write(prefix + "'file'" + suffix);
        const original = await fixture.request('snapshot');
        assert.equal(original.status, 'ok');
        if (original.status !== 'ok' || !original.snapshot.buffer) return;
        // Move the real editor cursor inside the filename through the same verified native interface.
        const middle = { text: original.snapshot.buffer.text, cursor: Array.from(prefix).length + 3 };
        assert.deepEqual(await fixture.request('apply', original.snapshot, middle), { status: 'applied' });
        const captured = await fixture.request('snapshot');
        assert.equal(captured.status, 'ok');
        if (captured.status !== 'ok' || !captured.snapshot.buffer) return;
        const context = parseShellCompletionContext(shell, captured.snapshot.buffer);
        assert.ok(context);
        assert.equal(context.word.prefix, 'fi');
        const literal = quoteShellPath(shell, value)!;
        const replacement = buildShellCompletionReplacement(captured.snapshot.buffer, {
          ...context.word,
          text: literal,
        });
        assert.ok(replacement);
        assert.equal(replacement.text, prefix + literal + suffix);
        const boundary = terminal.readOutput().length;
        assert.deepEqual(await fixture.request('apply', captured.snapshot, replacement), { status: 'applied' });
        const verified = await fixture.request('snapshot');
        assert.equal(verified.status, 'ok');
        if (verified.status === 'ok') assert.deepEqual(verified.snapshot.buffer, replacement);
        assert.equal(
          terminal.readOutput(boundary).includes(marker + '2:'),
          false,
          'acceptance must never execute the command',
        );
        const generation = fixture.collect()!.promptGeneration;
        const executeOffset = terminal.write('\r');
        const expectedValue = value.startsWith('-') ? './' + value : value;
        const expected =
          marker +
          '2:' +
          Buffer.from(expectedValue).toString('hex') +
          ':' +
          Buffer.from('tail sentinel').toString('hex');
        await terminal.waitFor(new RegExp(expected + '\\r?\\n', 'u'), executeOffset);
        await fixture.prompt(generation);
      }
    },
  );
}
