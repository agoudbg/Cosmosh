// Playwright CLI requires a function expression without a trailing semicolon.
// prettier-ignore
async (page) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForFunction(() => !!window.credentialFixture);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = page.getByRole('button', { name: /login password|Filling|登录密码|填入中/u });
  const checkPaneBounds = async (paneId) => {
    const pane = await page.locator('[data-fixture-pane="' + paneId + '"]').boundingBox();
    const action = await button.boundingBox();
    check(pane && action && action.x >= pane.x && action.x + action.width <= pane.x + pane.width + 1 && action.y >= pane.y && action.y + action.height <= pane.y + pane.height + 1, 'Credential action escaped pane ' + paneId);
  };
  await page.evaluate(() => window.credentialFixture.offer('one'));
  await button.waitFor();
  await checkPaneBounds('first');
  check(/password|密码/iu.test(await button.innerText()), 'Action does not identify its credential');
  await button.click();
  check(await button.isDisabled(), 'Pending action remains clickable');
  check(await page.locator('[data-fixture-pane="first"] textarea').evaluate((element) => element === document.activeElement), 'Click moved focus out of the originating xterm');
  check(JSON.stringify(await page.evaluate(() => window.credentialFixture.requests)) === '[{"paneId":"first","token":"one"}]', 'Click did not send only the prompt token to its pane');
  await page.evaluate(() => window.credentialFixture.result({ type: 'credential-fill-result', token: 'one', status: 'filled' }));
  await page.getByRole('status').waitFor();
  check(/Enter|回车/u.test(await page.getByRole('status').innerText()), 'Filled status omits manual submission');
  await page.screenshot({ path: '.playwright-cli/terminal-credential-filled.png' });
  await page.evaluate(() => window.credentialFixture.offer('short', 200));
  await button.waitFor();
  await button.waitFor({ state: 'detached' });
  await page.evaluate(() => window.credentialFixture.offer('two'));
  await button.waitFor();
  await page.setViewportSize({ width: 440, height: 600 });
  await checkPaneBounds('first');
  const bounds = await button.boundingBox();
  check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 440, 'Action exceeds the narrow viewport');
  await page.screenshot({ path: '.playwright-cli/terminal-credential-action.png' });
  await page.evaluate(() => window.credentialFixture.activate('second'));
  await button.waitFor({ state: 'detached' });
  await page.evaluate(() => window.credentialFixture.offer('second-token'));
  await button.waitFor();
  await checkPaneBounds('second');
  await button.click();
  check(JSON.stringify(await page.evaluate(() => window.credentialFixture.requests.at(-1))) === '{"paneId":"second","token":"second-token"}', 'Second pane request went to the first pane');
  await page.evaluate(() => window.credentialFixture.disconnect());
  await button.waitFor({ state: 'detached' });
  check((await page.getByRole('status').count()) === 0, 'Disconnect retained a stale status');
  return { passed: 6, scenarios: ['independent action', 'opaque token and focus preservation', 'manual Enter status', 'expiration', 'narrow viewport and disconnect', 'two-pane placement and request routing'] };
}
