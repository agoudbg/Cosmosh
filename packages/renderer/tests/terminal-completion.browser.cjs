// Playwright CLI wraps this file as a function expression; a trailing semicolon is invalid.
// prettier-ignore
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const results = [], errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.text().includes('[ssh][input]')) errors.push(message.text()); });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const paint = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reset = async (settings = {}) => {
    await page.mouse.move(5, 500);
    await page.evaluate((next) => window.terminalInteractionFixture.reset(next), settings);
    await paint();
    await page.locator('#pane-1 textarea').focus();
  };
  const messages = (type) => page.evaluate((type) => window.terminalInteractionFixture.messages
    .filter((entry) => entry.payload.type === type).map((entry) => entry.payload), type);
  const inputs = async () => (await messages('input')).map((entry) => entry.data).join('');
  const show = async () => {
    await page.evaluate(() => window.terminalInteractionFixture.show());
    await page.waitForFunction(() => window.terminalInteractionFixture.messages.some((entry) => entry.payload.type === 'completion-query'));
    await page.evaluate(() => window.terminalInteractionFixture.respond());
    await page.locator('[data-terminal-autocomplete]').waitFor();
  };
  const focus = async () => {
    await page.keyboard.press('Control+Shift+Space');
    await page.evaluate(() => window.terminalInteractionFixture.respond());
    await page.locator('[data-terminal-autocomplete="focused"]').waitFor();
  };
  const accepted = async (index) => {
    const edits = await messages('completion-accept');
    check(edits.length === 1 && edits[0].candidateId === `10e2fbb0-d264-40f0-a99c-a28290ce324${index}`, 'Wrong opaque candidate selected');
    check(Object.keys(edits[0]).sort().join(',') === 'candidateId,requestId,snapshotId,type', 'Acceptance leaked replacement text');
    check(await inputs() === '', 'Suggestion acceptance synthesized terminal bytes');
    const cancels = await messages('completion-cancel');
    check(!cancels.some((message) => message.requestId === edits[0].requestId), 'Hiding menu canceled the chosen edit');
  };
  await page.waitForFunction(() => !!window.terminalInteractionFixture);
  for (const settings of [{}, { inputAllowed: false }, { enabled: false }]) {
    await reset(settings);
    const input = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(12);
    await page.keyboard.type(input);
    check(await inputs() === input, 'Rapid typing lost or changed a character');
  }
  results.push('rapid input remains exact with readable, denied and disabled completion');

  await reset(); await show();
  await page.evaluate(() => window.terminalInteractionFixture.failNextMenuReset());
  await page.keyboard.insertText('x');
  await page.evaluate(() => { window.terminalInteractionFixture.respond(); window.terminalInteractionFixture.accept(0); });
  check(await inputs() === 'x' && !(await messages('completion-accept')).length, 'Menu failure lost input or retained candidate authority');
  check(errors.length === 1 && errors[0].includes('[ssh][input]'), 'Optional UI failure not isolated');
  errors.length = 0;
  results.push('optional UI exceptions preserve input and revoke old candidates');

  for (const [key, bytes] of [['Tab','\t'], ['ArrowUp','\x1b[A'], ['ArrowDown','\x1b[B'], ['Enter','\r'], ['Escape','\x1b'], ['Shift+Tab','\x1b[Z']]) {
    await reset(); await show();
    check(await page.locator('[role="option"][aria-selected="true"]').count() === 0, 'Passive list selected a row');
    await page.keyboard.press(key);
    check(await inputs() === bytes, 'Passive key was captured: ' + key);
    check(await page.locator('[data-terminal-autocomplete]').count() === 0, 'Passive menu survived input');
  }
  results.push('passive Tab, history arrows, Enter, Escape and Shift+Tab remain native');

  await reset(); await show(); await focus();
  await page.keyboard.press('ArrowDown');
  const active = await page.locator('#pane-1 textarea').getAttribute('aria-activedescendant');
  check(!!active && await page.locator('[id="' + active + '"]').getAttribute('aria-selected') === 'true', 'Accessible option not linked');
  await page.keyboard.press('Tab'); await accepted(1);
  check(await page.locator('#pane-1 textarea').getAttribute('role') === null, 'xterm accessibility not restored');
  await page.evaluate(() => window.terminalInteractionFixture.acceptResult('applied'));
  check(await inputs() === '', 'Acknowledgement executed a command');
  results.push('focused opaque acceptance never types deletion or Enter');

  for (const [key, bytes] of [['g','g'], ['Control+c','\x03'], ['Escape','']]) {
    await reset(); await show(); await focus(); await page.keyboard.press(key);
    check(await inputs() === bytes, 'Focused exit changed input: ' + key);
    check(await page.locator('[data-terminal-autocomplete]').count() === 0, 'Focused menu retained keys');
  }
  await reset(); await show(); await focus();
  const composingPrevented = await page.locator('#pane-1 textarea').evaluate(async (element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event); element.value += '中';
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: '中', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '中', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return event.defaultPrevented;
  });
  check(!composingPrevented, 'IME was captured');
  await page.waitForFunction(() => window.terminalInteractionFixture.messages.some((entry) => entry.payload.type === 'input' && entry.payload.data === '中'));
  results.push('typing, Ctrl+C, Escape and IME immediately release menu ownership');

  for (const change of ['input', 'pane', 'context', 'editor', 'permission', 'history', 'blur']) {
    await reset();
    await page.keyboard.press('Control+Shift+Space');
    if (change === 'input') await page.keyboard.press('x');
    if (change === 'pane') await page.evaluate(() => window.terminalInteractionFixture.focusPane('pane-2'));
    if (change === 'context') await page.evaluate(() => window.terminalInteractionFixture.context({ promptGeneration: 2 }));
    if (change === 'editor') await page.evaluate(() => window.terminalInteractionFixture.context({ editorAvailable: false }));
    if (change === 'permission') await page.evaluate(() => window.terminalInteractionFixture.setInputAllowed(false));
    if (change === 'history') await page.evaluate(() => window.terminalInteractionFixture.setHistoryEnabled(false));
    if (change === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await paint();
    await page.evaluate(() => window.terminalInteractionFixture.respond());
    await paint();
    check(await page.locator('[data-terminal-autocomplete]').count() === 0, 'Old query survived ' + change);
  }
  results.push('pending replies cannot cross input, pane, prompt, permissions or focus changes');

  await reset();
  await page.keyboard.press('Control+Shift+Space');
  await page.evaluate(() => {
    window.terminalInteractionFixture.context({ revision: 3, inputGeneration: 2 });
    window.terminalInteractionFixture.respond({ complete: false, items: [] });
  });
  await paint();
  check(await page.locator('[data-terminal-autocomplete]').count() === 0, 'Empty first batch created a menu');
  await page.evaluate(() => window.terminalInteractionFixture.respond({ complete: false }));
  await page.locator('[data-terminal-autocomplete="focused"]').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.terminalInteractionFixture.respond({ items: [
    { id: 'extra-path', label: 'new path/', detail: 'Path', source: 'runtime', kind: 'path' },
    { id: '10e2fbb0-d264-40f0-a99c-a28290ce3241', label: 'git stash', detail: 'Fixture history', source: 'history', kind: 'history' },
    { id: '10e2fbb0-d264-40f0-a99c-a28290ce3240', label: 'git status', detail: 'Fixture history', source: 'history', kind: 'history' },
  ] }));
  await paint();
  check((await page.locator('[role="option"][aria-selected="true"]').innerText()).includes('git stash'), 'Slow source changed selected candidate');
  await page.keyboard.press('Tab'); await accepted(1);
  results.push('initial context confirmation, empty early results and slow sources preserve exact selection');

  for (const action of ['mouse', 'keyboard', 'removed']) {
    await reset(); await show(); await focus(); await page.keyboard.press('ArrowDown');
    await page.evaluate((action) => {
      const reversed = [
        { id: '10e2fbb0-d264-40f0-a99c-a28290ce3241', label: 'git stash', detail: 'Fixture history', source: 'history', kind: 'history' },
        { id: '10e2fbb0-d264-40f0-a99c-a28290ce3240', label: 'git status', detail: 'Fixture history', source: 'history', kind: 'history' },
      ];
      window.terminalInteractionFixture.respond({ items: action === 'removed' ? reversed.slice(0, 1) : reversed });
      // The DOM still represents the previous render, while the hook has already received the new batch.
      if (action === 'removed') document.querySelectorAll('[role="option"]')[0].click();
      else if (action === 'mouse') document.querySelectorAll('[role="option"]')[1].click();
      else document.querySelector('#pane-1 textarea').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true,
      }));
    }, action);
    if (action === 'removed') check(!(await messages('completion-accept')).length, 'Removed candidate accepted another row');
    else await accepted(1);
  }
  results.push('same-turn source reordering preserves clicked and keyboard-selected candidate IDs');

  await reset(); await show(); await focus(); await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.terminalInteractionFixture.respond({ items: [
    { id: '10e2fbb0-d264-40f0-a99c-a28290ce3240', label: 'git status', detail: 'Fixture history', source: 'history', kind: 'history' },
  ] }));
  await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent.includes('git stash'));
  await page.keyboard.press('Tab'); await accepted(1);
  results.push('a later source cannot evict the focused candidate or substitute another edit');

  await reset(); await show();
  await page.evaluate(() => window.terminalInteractionFixture.context({ revision: 2 }));
  await page.evaluate(() => { window.terminalInteractionFixture.respond(); window.terminalInteractionFixture.accept(0); });
  check(!(await messages('completion-accept')).length, 'A context revision rebound an old displayed menu');
  await reset(); await show(); await focus(); await page.keyboard.press('Tab'); await accepted(0);
  await page.keyboard.press('x');
  const edit = (await messages('completion-accept'))[0];
  check((await messages('completion-cancel')).some((message) => message.requestId === edit.requestId), 'Later input did not cancel pending acceptance');
  await page.evaluate(() => window.terminalInteractionFixture.acceptResult('unknown'));
  check(await inputs() === 'x' && (await messages('completion-accept')).length === 1, 'Unknown result retried or changed new input');
  check((await page.evaluate(() => window.terminalInteractionFixture.warnings)).length === 1, 'Unknown edit outcome was hidden');
  results.push('displayed revision expires and later input cancels acceptance without retries');

  for (const accepting of [false, true]) {
    await reset(); await show(); await focus();
    if (accepting) { await page.keyboard.press('Tab'); await accepted(0); }
    await page.evaluate(() => {
      window.terminalInteractionFixture.directInput('DIRECT_PASTE');
      document.querySelector('#pane-1 textarea').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true,
      }));
    });
    check(await inputs() === 'DIRECT_PASTE\t', 'Programmatic input retained menu ownership before the server replied');
    check((await messages('completion-accept')).length === Number(accepting), 'Programmatic input accepted an old candidate');
    if (accepting) {
      const id = (await messages('completion-accept'))[0].requestId;
      check((await messages('completion-cancel')).some((message) => message.requestId === id), 'Programmatic input failed to cancel acceptance');
    }
  }
  results.push('programmatic paste and input synchronously release keys and cancel pending edits');

  for (const settings of [{ inputAllowed: false }, { enabled: false }, { isActive: false }, { connected: false }]) {
    await reset(settings); await page.keyboard.press('Tab'); check(await inputs() === '\t', 'Disabled feature captured Tab');
  }
  await reset(); await page.evaluate(() => window.terminalInteractionFixture.alternate(true));
  await page.keyboard.press('Tab'); check(await inputs() === '\t', 'Alternate screen captured Tab');
  await reset(); await show(); await focus(); await page.locator('#outside').click();
  check(await page.locator('[data-terminal-autocomplete]').count() === 0, 'Outside focus retained menu');
  results.push('disabled features, alternate screens and external focus preserve terminal input');

  await reset(); await page.keyboard.type('gi');
  await page.waitForFunction(() => window.terminalInteractionFixture.messages.some((entry) => entry.payload.type === 'completion-query'));
  const query = (await messages('completion-query')).at(-1);
  check(Object.keys(query).sort().join(',') === 'requestId,trigger,type', 'Query retained guessed input or directory');
  check(query.trigger === 'typing', 'Typing needed an output echo or manual request');
  results.push('typing queries need no echo and contain no guessed text or CWD');

  await reset({ acceptKeys: 'enter' }); await show(); await focus(); await page.keyboard.press('Enter'); await accepted(0);
  await reset(); await show(); await page.getByRole('option', { name: 'git stash Fixture history' }).click(); await accepted(1);
  check(await page.locator('#pane-1 textarea').evaluate((element) => element === document.activeElement), 'Mouse lost terminal focus');
  check(await page.evaluate(() => window.terminalInteractionFixture.transportCallbackChanges) === 0, 'UI state recreated PTY effect callbacks');
  results.push('mouse and configured Enter acceptance use stable transport callbacks');

  await reset(); await show(); await focus();
  await page.screenshot({ path: '.playwright-cli/terminal-completion-focused.png' });
  await page.setViewportSize({ width: 440, height: 800 });
  await page.waitForFunction(() => { const rect = document.querySelector('[data-terminal-autocomplete]')?.getBoundingClientRect(); return rect && rect.left >= 0 && rect.right <= innerWidth; });
  await page.screenshot({ path: '.playwright-cli/terminal-completion-narrow.png' });
  results.push('focused popup remains within a narrow viewport');
  check(!errors.length, 'Renderer errors: ' + errors.join('; '));
  return { passed: results.length, scenarios: results };
}
