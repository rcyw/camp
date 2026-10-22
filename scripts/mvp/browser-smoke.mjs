import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const receipt = JSON.parse(await readFile(resolve('.camp/mvp-receipt.json'), 'utf8'));
const response = await fetch(`${receipt.apiUrl}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: seed.user.email, password: seed.user.password }),
});
assert.equal(response.status, 200);
const { accessToken, refreshToken } = await response.json();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  await context.addInitScript(({ accessToken, refreshToken }) => {
    localStorage.setItem('slock_access_token', accessToken);
    localStorage.setItem('slock_refresh_token', refreshToken);
  }, { accessToken, refreshToken });
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(receipt.webUrl, { waitUntil: 'domcontentloaded' });
  if (process.argv.includes('--submit')) {
    const composer = page.getByTestId('composer-textarea');
    await composer.waitFor({ state: 'visible', timeout: 45_000 });
    await composer.fill(`/camp ${receipt.goal}`);
    const submitted = page.waitForResponse(response => response.url().endsWith(`/api/camp/rooms/${receipt.roomId}/tasks`) && response.request().method() === 'POST');
    await composer.press('Enter');
    const result = await submitted;
    assert.equal(result.status(), 201, 'The real channel command must create a pipeline');
    const state = await result.json();
    receipt.taskIds = state.tasks.map(task => task.id);
    await writeFile(resolve('.camp/mvp-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    await composer.waitFor({ state: 'visible' });
    assert.equal(await composer.inputValue(), '', 'The accepted command must clear the composer');
  }
  const tab = page.getByTestId('panel-tab-camp');
  await tab.waitFor({ state: 'visible', timeout: 45_000 });
  await tab.click();
  const panel = page.getByTestId('camp-room-panel');
  await panel.waitFor({ state: 'visible' });
  for (const role of ['planner', 'builder', 'reviewer']) await page.getByTestId(`camp-role-${role}`).waitFor({ state: 'visible' });
  assert.equal(await panel.getByTestId('camp-room-error').count(), 0, 'Room panel must load without an API error');
  assert.equal(await panel.locator('textarea').count(), 1);
  // Worker credentials are never requested or expanded during this check.
  const screenshot = resolve('.camp/mvp-room.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(failures, [], 'Browser must not throw');
  console.log(JSON.stringify({ event: 'browser_smoke_passed', url: receipt.webUrl, screenshot }));
} finally {
  await browser.close();
}
