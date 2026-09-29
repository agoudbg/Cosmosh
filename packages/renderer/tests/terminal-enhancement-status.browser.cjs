// Playwright CLI invokes this expression with its managed browser page.
// prettier-ignore
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const results = [];
  const button = () => page.getByRole('button', { name: 'Enhancement Status', exact: true });
  const feature = (id) => page.locator('[data-enhancement-feature="' + id + '"]');
  const update = async (change) => {
    await page.evaluate((value) => window.enhancementStatusFixture.update(value), change);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.enhancementStatusFixture);
  await page.evaluate(() => window.enhancementStatusFixture.locale('en'));
  await button().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  check((await feature('history').innerText()).includes('Allowed · Available'), 'Empty successful history was unavailable');
  check((await feature('input').innerText()).includes('Filling never executes the command'), 'Verified edit behavior missing');
  check((await feature('paths').innerText()).includes('freshly confirmed remote directory'), 'Path source behavior missing');
  check((await feature('nativeCompletion').innerText()).includes('when you enter the suggestion list'), 'Manual native query behavior missing');
  await page.screenshot({ path: '.playwright-cli/enhancement-status-desktop.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check(await button().evaluate((element) => element === document.activeElement), 'Escape did not restore button focus');
  results.push('keyboard opening, precise support claims and focus restoration');

  await button().click();
  await update({ completionSources: { history: 'ok', metadata: 'ok', paths: 'timeout', native: 'ok' } });
  check((await feature('paths').innerText()).includes('source timed out'), 'Current source failure was hidden');
  check((await feature('nativeCompletion').innerText()).includes('Allowed · Available'), 'One failed source disabled another');
  await page.evaluate(() => {
    const input = window.enhancementStatusFixture.read();
    window.enhancementStatusFixture.update({ context: { ...input.context, editorAvailable: false } });
  });
  await page.waitForFunction(() => document.querySelector('[data-enhancement-feature="input"]').textContent.includes('not supported'));
  check((await feature('directory').innerText()).includes('Allowed · Available'), 'Editor revocation removed confirmed CWD');
  check((await feature('nativeCompletion').innerText()).includes('not supported'), 'Revoked editor still advertised native queries');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.enhancementStatusFixture.reset());
  results.push('source failures remain separate and revoked editing preserves independent directory status');

  await button().click();
  await page.evaluate(() => {
    const input = window.enhancementStatusFixture.read();
    window.enhancementStatusFixture.update({
      settings: { ...input.settings, remoteEnhancementsCwdEnabled: false, remoteEnhancementsInputEnabled: false },
      context: { ...input.context, status: 'paused', reason: 'input-submitted' },
    });
  });
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]').textContent.includes('/home/user/current'));
  check((await feature('history').innerText()).includes('Allowed · Available'), 'Paused input incorrectly disabled independent history');
  await update({ historyView: { status: 'private', source: null, entries: [] } });
  check((await feature('history').innerText()).includes('no enabled history source'), 'Missing private or disabled-source reason');
  results.push('permission revocation removes directory and preserves independent history');

  await update({ connectionState: 'failed' });
  check((await page.getByRole('dialog').innerText()).includes('connection has ended'), 'Stale active helper hid disconnect');
  check(!(await page.getByRole('dialog').innerText()).includes('helper is connected'), 'Disconnected helper shown active');
  await page.evaluate(() => {
    const input = window.enhancementStatusFixture.read();
    window.enhancementStatusFixture.update({ settings: { ...input.settings, remoteEnhancementsEnabled: false }, serverEnabled: false });
  });
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('connection has ended'));
  await page.evaluate(() => window.enhancementStatusFixture.reset());
  await update({ runtimeStatus: { type: 'remote-enhancement-runtime-status', state: 'disabled', code: 'HELPER_CONTRACT_MISMATCH' } });
  check((await page.getByRole('dialog').innerText()).includes('does not match'), 'Missing version mismatch reason');
  await update({ runtimeStatus: { type: 'remote-enhancement-runtime-status', state: 'disabled', code: 'PERMISSION_DISABLED' } });
  check((await page.getByRole('dialog').innerText()).includes('Reconnect after enabling'), 'Global re-enable promised automatic recovery');
  results.push('disconnect, helper mismatch and reconnect requirement');

  await page.evaluate(() => window.enhancementStatusFixture.pane(2));
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.enhancementStatusFixture.reset());
  await button().click();
  check((await page.getByRole('dialog').innerText()).includes('terminal 2'), 'Dialog retained another pane identity');
  await page.setViewportSize({ width: 360, height: 480 });
  const box = await page.getByRole('dialog').boundingBox();
  check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 360 && box.y + box.height <= 480, 'Dialog exceeded short narrow viewport');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  results.push('pane change closes old dialog and narrow viewport keeps close reachable');

  await button().click();
  await page.evaluate(() => window.enhancementStatusFixture.tab(false));
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.enhancementStatusFixture.tab(true));
  await button().waitFor();
  check(await page.getByRole('dialog').count() === 0, 'Status dialog reopened on return to tab');
  results.push('tab switch closes status without reopening on return');

  await page.evaluate(() => window.enhancementStatusFixture.locale('zh-CN'));
  await page.getByRole('button', { name: '增强状态', exact: true }).click();
  await page.getByRole('dialog', { name: '增强状态' }).waitFor();
  check((await feature('history').innerText()).includes('已允许 · 可用'), 'Chinese status copy missing');
  check(!(await page.getByRole('dialog').innerText()).includes('ssh.enhancementStatus'), 'Raw translation key rendered');
  await page.screenshot({ path: '.playwright-cli/enhancement-status-narrow-zh.png', animations: 'disabled' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  results.push('Chinese status and narrow dialog interaction');
  return { passed: results.length, results };
}
