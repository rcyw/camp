// Real browser and authenticated shell; all Camp mutations are explicit fixtures.
// No room is created in the real database and no worker, model or sandbox runs.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright';
import { CAMP_PREFLIGHT_CHECK_IDS, DEFAULT_BUDGETS } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const channelId = seed.channel.id, roomId = randomUUID(), firstDigest = 'a'.repeat(64), projectDigest = 'b'.repeat(64);
const token = 'camp_worker_fixture_' + randomUUID().replaceAll('-', '');
const imageId = 'sha256:' + 'd'.repeat(64), now = new Date().toISOString();
let state = null, mints = 0, saves = 0, policies = 0, goals = 0;
const report = { schemaVersion: 1, workerVersion: '0.4.0', mode: 'agent', modelConfigured: true, toolchainDigest: 'c'.repeat(64), imageId, checks: CAMP_PREFLIGHT_CHECK_IDS.map(id => ({ id, status: 'passed', code: 'ok' })) };
const folder = resolve('.camp/setup-ui', Date.now().toString(36)); await mkdir(folder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(({ accessToken, refreshToken }) => {
    localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.campFixtureClipboard = text; } } });
  }, auth);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length), method = request.method();
    assert.equal(request.headers().authorization, 'Bearer ' + auth.accessToken); assert.equal(request.headers()['x-server-id'], seed.server.id);
    let data;
    const body = ['PUT', 'POST'].includes(method) ? request.postDataJSON() : null;
    if (path === '/rooms' && method === 'GET') data = { rooms: state ? [state.room] : [] };
    else if (path === '/rooms' && method === 'POST') {
      assert.equal(body.channelId, channelId);
      state = { room: { id: roomId, channelId, name: body.name, project: body.project, roles: ['planner', 'builder', 'reviewer'].map(role => ({ role, agentId: randomUUID() })), verificationPolicy: null, acceptedHead: { revision: 0, goalId: null, candidate: null } }, setup: { projectDigest: firstDigest, projectMutable: true, readiness: null }, goals: [], runs: [], tasks: [], events: [], questions: [], workers: [], canManage: true, canSubmit: true, roomBusy: false, defaultBudget: DEFAULT_BUDGETS };
      data = state.room;
    } else if (path === '/rooms/' + roomId && method === 'GET') data = state;
    else if (path === `/rooms/${roomId}/project` && method === 'PUT') {
      saves++; assert.equal(body.expectedDigest, firstDigest); assert.equal(body.project.repoPath, '/workspaces/corrected-source');
      state.room.project = body.project; state.setup.projectDigest = projectDigest;
      state.setup.readiness = { selfReported: true, observedAt: now, workerId: 'old-worker', projectDigest: firstDigest, report: { ...report, checks: report.checks.map(check => check.id === 'source' ? { ...check, status: 'failed', code: 'source_missing' } : check) } };
      data = state;
    } else if (path === `/rooms/${roomId}/verification-policy` && method === 'PUT') {
      policies++; assert.equal(body.expectedDigest, null); state.room.verificationPolicy = { policy: body.policy, digest: 'e'.repeat(64) }; data = state;
    } else if (path === `/rooms/${roomId}/worker-token` && method === 'POST') {
      mints++; data = { token, expiresAt: now, roomId };
    } else if (path === `/rooms/${roomId}/tasks` && method === 'POST') {
      goals++; assert.equal(body.description, 'Preserve this first goal draft'); assert.equal(body.budget.maxRuns, 24);
      state.goals = [{ id: randomUUID(), roomId, title: body.title, description: body.description, workflow: 'serial', protocolVersion: 2, status: 'queued', reason: null, attempt: 1, budget: body.budget, usage: { runs: 0, reviewRounds: 0, elapsedSeconds: 0 }, activeRuns: 0, canRetry: false, canCancel: false, createdAt: now, startedAt: null, completedAt: null }];
      state.setup.projectMutable = false; state.roomBusy = true; data = state;
    } else throw new Error(`Unexpected setup fixture request: ${method} ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${channelId}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
  await panel.getByRole('textbox', { name: 'Project name', exact: true }).fill('onboarding-project');
  await panel.getByRole('textbox', { name: /^Project folder on the worker/ }).fill('/missing/source');
  await panel.locator('form button[type=submit]').click();
  const guide = panel.getByTestId('camp-room-setup'); await guide.waitFor({ state: 'visible' });
  const goalInput = panel.locator(`#camp-goal-${channelId}`); await goalInput.fill('Preserve this first goal draft');
  assert.equal(await goalInput.locator('xpath=ancestor::form').locator('button[type=submit]').isDisabled(), true);
  const project = guide.getByTestId('camp-project-config'); await project.getByRole('button', { name: 'Edit project' }).click();
  await project.getByRole('textbox', { name: 'Project folder on the worker', exact: true }).fill('/workspaces/corrected-source');
  await project.getByRole('button', { name: 'Save project', exact: true }).click();
  await project.getByTestId('camp-project-form').waitFor({ state: 'detached' });
  await guide.getByText(/This report describes older project settings/).waitFor({ state: 'visible' });
  await guide.getByTestId('camp-policy-configure').click(); await guide.getByTestId('camp-policy-form').getByRole('button', { name: 'Save project checks' }).click();
  await guide.getByTestId('camp-policy-form').waitFor({ state: 'detached' });
  const connection = guide.getByTestId('camp-worker-connection');
  assert.equal(await connection.getByTestId('camp-worker-api').inputValue(), '');
  await connection.getByTestId('camp-worker-api').fill('https://api.worker-host.example.test');
  await connection.getByTestId('camp-worker-id').fill('stable-onboarding-worker'); await connection.getByTestId('camp-worker-home').fill('/var/lib/camp/state');
  await connection.getByTestId('camp-worker-image').fill(imageId); await connection.getByTestId('camp-worker-bundle').fill('/opt/camp/toolchain-bundle');
  await connection.getByRole('button', { name: 'Issue worker credential' }).click();
  const downloaded = page.waitForEvent('download'); await connection.getByTestId('camp-worker-env-download').click();
  const download = await downloaded, downloadPath = resolve(folder, download.suggestedFilename()); await download.saveAs(downloadPath);
  const environment = parseEnv(await readFile(downloadPath, 'utf8'));
  assert.equal(environment.CAMP_WORKER_TOKEN, token); assert.equal(environment.CAMP_API_URL, 'https://api.worker-host.example.test'); assert.equal(environment.CAMP_RUNTIME_HOME, '/var/lib/camp/state'); assert.equal(environment.CAMP_RUNTIME_IMAGE, imageId); assert.equal(environment.CAMP_TOOLCHAIN_BUNDLE, '/opt/camp/toolchain-bundle'); assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.match(await connection.innerText(), /Browser downloads do not set private permissions/);
  await connection.getByRole('button', { name: 'Copy: Check and report setup' }).click();
  const copied = await page.evaluate(() => globalThis.campFixtureClipboard); assert.match(copied, /--report --require-agent/); assert.equal(copied.includes(token), false);
  assert.equal(await page.evaluate(credential => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(credential)), token), false);
  state.setup.readiness = { selfReported: true, observedAt: now, workerId: 'stable-onboarding-worker', projectDigest, report };
  await panel.getByRole('button', { name: 'Refresh room', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=camp-setup-step-worker]')?.getAttribute('data-complete') === 'true');
  assert.equal(await connection.getByTestId('camp-worker-api').inputValue(), 'https://api.worker-host.example.test'); assert.equal(mints, 1); assert.equal(await goalInput.inputValue(), 'Preserve this first goal draft');
  assert.match(await guide.getByTestId('camp-preflight-report').innerText(), /not live presence/);
  await goalInput.locator('xpath=ancestor::form').locator('button[type=submit]').click();
  await guide.getByText(/Project settings are locked/).waitFor({ state: 'visible' }); assert.equal(await project.getByRole('button', { name: 'Edit project' }).count(), 0);
  assert.deepEqual([saves, policies, mints, goals], [1, 1, 1, 1]); assert.deepEqual(errors, []); assert.equal(await panel.getByTestId('camp-room-error').count(), 0);
  await panel.evaluate(element => { element.scrollTop = 0; });
  await guide.getByRole('heading', { name: 'Start this room', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(folder, 'setup.png'), fullPage: true });
  const result = { event: 'setup_ui_fixture_passed', url, realBrowser: true, realHttpAuth: true, campApiIntercepted: true, campDatabaseMutations: 0, modelCalls: 0, sandboxLaunches: 0, projectCas: true, policyConfigured: true, configDownloaded: true, credentialNotPersistedInBrowser: true, commandsExcludeCredential: true, staleProjectReportDisclosed: true, draftPreserved: true, selfReportNotPresence: true, projectLockedAfterGoal: true };
  await writeFile('.camp/setup-ui-latest.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
