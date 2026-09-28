// Playwright CLI wraps this file as a function expression; a trailing semicolon is invalid.
// prettier-ignore
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const results = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const reset = async (settings = {}) => {
    // Keep a prior mouse-selection scenario from choosing an item under the stationary pointer.
    await page.mouse.move(5, 500);
    await page.evaluate((next) => window.terminalInteractionFixture.reset(next), settings);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#pane-1 textarea').focus();
  };
  const show = async () => {
    await page.evaluate(() => window.terminalInteractionFixture.show());
    await page.waitForFunction(() =>
      window.terminalInteractionFixture.messages.some((entry) => entry.payload.type === 'completion-request'),
    );
    await page.evaluate(() => window.terminalInteractionFixture.respond());
    await page.locator('[data-terminal-autocomplete]').waitFor();
  };
  const inputs = () =>
    page.evaluate(() =>
      window.terminalInteractionFixture.messages
        .filter((entry) => entry.payload.type === 'input')
        .map((entry) => entry.payload.data),
    );
  const focus = async () => {
    await page.keyboard.press('Control+Shift+Space');
    await page.locator('[data-terminal-autocomplete="focused"]').waitFor();
  };
  await page.waitForFunction(() => !!window.terminalInteractionFixture);
  for (const [key, expected] of [
    ['Tab', '\t'],
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['Enter', '\r'],
    ['Escape', '\x1b'],
    ['Shift+Tab', '\x1b[Z'],
  ]) {
    await reset();
    await show();
    check(
      (await page.locator('[role="option"][aria-selected="true"]').count()) === 0,
      'Passive list must have no selection',
    );
    await page.keyboard.press(key);
    check(JSON.stringify(await inputs()) === JSON.stringify([expected]), 'Passive key lost or changed: ' + key);
    check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'Passive list survived input: ' + key);
  }
  results.push('passive native Tab/arrows/Enter/Escape/Shift+Tab');

  await reset();
  await show();
  await focus();
  await page.keyboard.press('ArrowDown');
  const active = await page.locator('#pane-1 textarea').getAttribute('aria-activedescendant');
  check(
    !!active && (await page.locator('[id="' + active + '"]').getAttribute('aria-selected')) === 'true',
    'Accessible active option not linked',
  );
  await page.keyboard.press('Tab');
  check(
    JSON.stringify(await inputs()) === JSON.stringify(['\x7f\x7fgit stash']),
    'Focused acceptance did not apply selected item',
  );
  check((await page.locator('#pane-1 textarea').getAttribute('role')) === null, 'xterm role not restored');
  results.push('focused navigation, selected acceptance, restored accessibility');

  for (const [key, expected] of [
    ['g', 'g'],
    ['Control+c', '\x03'],
    ['Escape', null],
  ]) {
    await reset();
    await show();
    await focus();
    await page.keyboard.press(key);
    check(
      JSON.stringify(await inputs()) === JSON.stringify(expected === null ? [] : [expected]),
      'Focused exit lost or changed key: ' + key,
    );
    check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'List still owns input: ' + key);
  }
  await reset();
  await show();
  await focus();
  const composingPrevented = await page.locator('#pane-1 textarea').evaluate(async (element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    element.value += '中';
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: '中', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '中', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return event.defaultPrevented;
  });
  check(!composingPrevented, 'IME event captured');
  await page.waitForFunction(() => window.terminalInteractionFixture.messages.some(
    (entry) => entry.payload.type === 'input' && entry.payload.data === '中'));
  check((await inputs()).includes('中'), 'First composed character lost');
  results.push('typing, Ctrl+C, Escape, IME release');

  await reset();
  await page.keyboard.press('Control+Shift+Space');
  await page.waitForFunction(() =>
    window.terminalInteractionFixture.messages.some((entry) => entry.payload.type === 'completion-request'),
  );
  await page.keyboard.press('x');
  await page.evaluate(() => window.terminalInteractionFixture.respond());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check((await inputs()).join('') === 'x', 'Input lost during pending request');
  check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'Delayed response reopened list');
  results.push('pending request and stale response');

  await reset();
  await show();
  await focus();
  await page.evaluate(() => window.terminalInteractionFixture.setInputAllowed(false));
  await page.waitForFunction(() => !document.querySelector('[data-terminal-autocomplete]'));
  const requestsBeforeOptOutInput = await page.evaluate(() =>
    window.terminalInteractionFixture.messages.filter((entry) => entry.payload.type === 'completion-request').length);
  await page.keyboard.type('PRIVATE_INPUT_PERMISSION_TEST');
  await page.keyboard.press('Control+Shift+Space');
  await page.keyboard.press('Tab');
  await page.evaluate(() => window.terminalInteractionFixture.respond());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check((await inputs()).join('') === 'PRIVATE_INPUT_PERMISSION_TEST\t', 'Input opt-out changed ordinary PTY input');
  check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'Input opt-out admitted stale suggestions');
  check((await page.evaluate(() =>
    window.terminalInteractionFixture.messages.filter((entry) => entry.payload.type === 'completion-request').length)) ===
    requestsBeforeOptOutInput, 'Input opt-out sent a new candidate request');
  results.push('input permission revocation preserves native input and rejects stale responses');

  for (const settings of [{ enabled: false }, { isActive: false }, { connected: false }]) {
    await reset(settings);
    await page.keyboard.press('Tab');
    check((await inputs()).join('') === '\t', 'Unavailable completion stole Tab');
  }
  await reset();
  await page.evaluate(() => window.terminalInteractionFixture.alternate(true));
  await page.keyboard.press('Tab');
  check((await inputs()).join('') === '\t', 'Alternate buffer stole Tab');
  results.push('disabled, inactive, disconnected, alternate buffer');

  await reset();
  await show();
  await focus();
  await page.evaluate(() => window.terminalInteractionFixture.focusPane('pane-2'));
  await page.keyboard.press('Tab');
  check(
    (await page.evaluate(() => window.terminalInteractionFixture.messages.at(-1).paneId)) === 'pane-2',
    'Input routed to old pane',
  );
  check((await inputs()).join('') === '\t', 'Pane change retained list ownership');
  await reset();
  await show();
  await focus();
  await page.locator('#outside').click();
  check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'Outside focus retained list');
  await reset();
  await show();
  await focus();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check((await page.locator('[data-terminal-autocomplete]').count()) === 0, 'Window blur retained list');
  results.push('pane, control and window focus release');

  await reset();
  await page.keyboard.type('gi');
  await page.keyboard.press('Tab');
  await page.evaluate(() => window.terminalInteractionFixture.output('\r\x1b[2K$ git '));
  await page.keyboard.type('s');
  await page.evaluate(() => window.terminalInteractionFixture.output('s'));
  await show();
  check(
    (await page.evaluate(
      () =>
        window.terminalInteractionFixture.messages.filter((entry) => entry.payload.type === 'completion-request').at(-1)
          .payload.linePrefix,
    )) === 'git s',
    'Native Tab expansion retained stale input prefix',
  );
  results.push('native Tab expansion followed by typing');

  await reset({ acceptKeys: 'enter' });
  await show();
  await focus();
  await page.keyboard.press('Enter');
  check((await inputs()).join('') === '\x7f\x7fgit status', 'Configured Enter acceptance failed');
  await reset();
  await show();
  await page.getByRole('option', { name: 'git stash Fixture history' }).click();
  check((await inputs()).join('') === '\x7f\x7fgit stash', 'Mouse acceptance failed');
  check(
    await page.locator('#pane-1 textarea').evaluate((element) => element === document.activeElement),
    'Mouse moved focus out of xterm',
  );
  check(
    (await page.evaluate(() => window.terminalInteractionFixture.transportCallbackChanges)) === 0,
    'UI state changed PTY effect callbacks',
  );
  results.push('mouse/configured acceptance and stable transport callbacks');

  await reset();
  await show();
  await focus();
  await page.screenshot({ path: '.playwright-cli/terminal-autocomplete-focused.png' });
  await page.setViewportSize({ width: 440, height: 800 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector('[data-terminal-autocomplete]')?.getBoundingClientRect();
    return bounds && bounds.left >= 0 && bounds.right <= innerWidth;
  });
  await page.screenshot({ path: '.playwright-cli/terminal-autocomplete-narrow.png' });
  results.push('popup remains in bounds after viewport resize');
  return { passed: results.length, scenarios: results };
}
