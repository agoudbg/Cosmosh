// Playwright CLI wraps this file as a function expression; a trailing semicolon is invalid.
// prettier-ignore
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const results = [];
  const reset = async () => {
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.terminalHistoryFixture.reset());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('button', { name: 'echo newest', exact: false }).waitFor();
  };
  const actions = () => page.evaluate(() => window.terminalHistoryFixture.actions);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.terminalHistoryFixture);
  await reset();
  await page.getByRole('button', { name: 'echo newest', exact: false }).click();
  check((await actions())[0].command === 'echo newest  ', 'Significant trailing spaces changed');
  const multiline = page.getByRole('button', { name: 'printf "two lines"', exact: true });
  check(await multiline.getAttribute('aria-disabled') === 'true', 'Multiline insertion was enabled');
  await multiline.click({ force: true });
  check((await actions()).length === 1, 'Multiline record was inserted');
  await multiline.click({ button: 'right', force: true });
  check(await page.getByRole('menuitem', { name: 'Add to current terminal', exact: true }).getAttribute('data-disabled') !== null, 'Multiline context insert enabled');
  check(await page.getByRole('menuitem', { name: 'Run in current terminal', exact: true }).getAttribute('data-disabled') !== null, 'Multiline context run enabled');
  await page.getByRole('menuitem', { name: 'Copy complete command' }).click();
  check((await actions())[1].command === 'printf "two\nlines"', 'Copy changed complete record');
  results.push('exact record insertion and multiline copy-only actions');

  await reset();
  await page.getByRole('button', { name: 'Delete command from history', exact: true }).first().click();
  await page.getByRole('alertdialog').waitFor();
  check((await actions()).length === 0, 'Removal happened before explicit confirmation');
  check((await page.getByRole('alertdialog').innerText()).includes('other terminals'), 'Shared native history scope not explained');
  await page.getByRole('button', { name: 'Remove matches', exact: true }).click();
  const removed = (await actions())[0];
  check(removed.command === 'echo newest  ' && removed.sourceId === 'source-one', 'Removal changed record/source');
  check(await page.getByRole('button', { name: 'Delete command from history', exact: true }).first().isDisabled(), 'Double removal was enabled');
  await page.evaluate(() => window.terminalHistoryFixture.respond('removed-from-reader'));
  await page.getByText(/history file update could not be confirmed/).waitFor();
  results.push('confirmation, exact source binding, pending lock and reader-only result');

  for (const change of ['source', 'pane', 'permission']) {
    await reset();
    await page.getByRole('button', { name: 'Delete command from history', exact: true }).first().click();
    await page.getByRole('alertdialog').waitFor();
    await page.evaluate((kind) => {
      if (kind === 'pane') window.terminalHistoryFixture.pane('pane-2');
      if (kind === 'permission') window.terminalHistoryFixture.permission(false);
      if (kind === 'source') window.terminalHistoryFixture.setView({ status: 'ok', source: { id: 'changed-source', namespace: 'new', shell: 'fish' }, entries: ['other record'] });
    }, change);
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    check((await actions()).length === 0, 'Old confirmation survived ' + change);
  }
  results.push('open confirmations invalidated by source, pane and permission changes');
  await reset();
  for (const status of ['private', 'unavailable', 'unsupported', 'disabled']) {
    await page.evaluate((status) => window.terminalHistoryFixture.setView({ status, source: null, entries: [] }), status);
    await page.waitForFunction(() => document.querySelectorAll('[data-terminal-history] button').length === 0);
    check((await page.locator('[data-terminal-history]').innerText()).trim().length > 0, 'Missing empty reason: ' + status);
  }
  results.push('private, unavailable, unsupported and disabled empty states');
  await reset();
  await page.setViewportSize({ width: 440, height: 800 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'History sidebar overflowed narrow viewport');
  await page.getByRole('button', { name: 'Delete command from history', exact: true }).first().click();
  await page.getByRole('alertdialog').waitFor();
  const box = await page.getByRole('alertdialog').boundingBox();
  check(box.x >= 0 && box.x + box.width <= 440, 'Confirmation exceeded viewport');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  results.push('narrow viewport and confirmation cancellation');
  return results;
}
