import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

test(
  'packaged Zsh module preserves native editing and releases real input locks before signals',
  { timeout: 110_000 },
  async (t) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(workspace, 'scripts/terminal-fixture/native-zsh.mjs')],
      {
        cwd: workspace,
        timeout: 100_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
    const report: unknown = JSON.parse(stdout);
    assert.ok(report && typeof report === 'object' && 'version' in report && typeof report.version === 'string');
    assert.match(report.version, /^zsh 5\.(?:8(?:\.1)?|9)(?:\s|$)/u);
    assert.ok('scenarios' in report && Array.isArray(report.scenarios));
    const scenarios = (report.scenarios as unknown[]).map((scenario) => {
      assert.ok(scenario && typeof scenario === 'object');
      assert.ok('name' in scenario && typeof scenario.name === 'string');
      assert.ok('passed' in scenario && scenario.passed === true);
      assert.ok('cleaned' in scenario && scenario.cleaned === true);
      assert.ok('notificationClosed' in scenario && scenario.notificationClosed === true);
      assert.ok('promptChecks' in scenario && typeof scenario.promptChecks === 'number');
      return { name: scenario.name, cleaned: scenario.cleaned, promptChecks: scenario.promptChecks };
    });
    assert.deepEqual(
      scenarios.map((scenario) => scenario.name),
      ['normal', 'winch', 'winch-custom', 'int'],
    );
    for (const scenario of scenarios) {
      await t.test(scenario.name, () => {
        assert.equal(scenario.cleaned, true);
        if (scenario.name.startsWith('winch')) assert.ok(scenario.promptChecks > 0);
      });
    }
    t.diagnostic(report.version);
  },
);
