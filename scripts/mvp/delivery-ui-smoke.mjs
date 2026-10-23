// Authenticated browser shell with explicit Camp response fixtures; no models,
// Worker, candidate execution or real verification is invoked by this test.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_BUDGETS } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' };
const name = `camp-delivery-ui-${Date.now().toString(36)}`;
const created = await fetch(`${api}/api/channels/`, { method: 'POST', headers, body: JSON.stringify({ name, description: 'Browser-only trusted delivery presentation fixture', visibility: 'public' }) });
assert.equal(created.ok, true); const channelBody = await created.json(), channel = channelBody.channel ?? channelBody;
const roomId = randomUUID(), goalId = randomUUID(), producerId = randomUUID(), repairId = randomUUID();
const now = new Date().toISOString();
const base = { type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'b'.repeat(64), rootId: 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64) };
const first = { ...base, refKind: 'commit', refId: '12' + 'e'.repeat(64), rootId: 'f'.repeat(64) }, final = { ...first, refId: '12' + '0'.repeat(64), rootId: '1'.repeat(64) };
const policy = { digest: '2'.repeat(64), policy: { id: 'acceptance', revision: 1, name: 'Operator acceptance', maxRepairAttempts: 1, checks: [{ id: 'contract', label: 'External catalog contract', argv: ['node', '/camp-checks/catalog-contract'], timeoutMs: 120000, harness: { id: 'catalog-contract', sha256: '3'.repeat(64) } }] } };
const receipt = (candidate, passed) => ({ schemaVersion: 1, candidate, policyDigest: policy.digest, status: passed ? 'passed' : 'failed', runId: passed ? 'verification-pass' : 'verification-fail', operationId: passed ? 'op-pass' : 'op-fail', verifiedAt: now, checks: [{ id: 'contract', argv: policy.policy.checks[0].argv, exitCode: passed ? 0 : 1, signal: null, timedOut: false, oomKilled: false, durationMs: 20, stdout: passed ? 'External catalog contract passed' : '', stderr: passed ? '' : 'Missing documentation\n<img onerror=alert(1)>', outputTruncated: !passed }] });
const operations = [first, final].map((candidate, index) => ({ id: index ? 'op-pass' : 'op-fail', goalId, goalAttempt: 1, kind: 'verification', inputCandidate: candidate, policyDigest: policy.digest, status: index ? 'completed' : 'failed', attempt: 1, infrastructureFailures: 0, createdAt: now, latestRunId: index ? 'verification-pass' : 'verification-fail', receipt: { ...receipt(candidate, index === 1), checks: receipt(candidate, index === 1).checks.map(({ argv: _argv, stdout: _stdout, stderr: _stderr, ...summary }) => summary) } }));
const goal = { id: goalId, roomId, title: 'Deliver a catalog with documented limits', description: null, workflow: 'serial', protocolVersion: 2, status: 'completed', reason: null, attempt: 1, budget: DEFAULT_BUDGETS.serial, usage: { runs: 7, reviewRounds: 2, elapsedSeconds: 60 }, activeRuns: 0, canRetry: false, canCancel: false, createdAt: now, startedAt: now, completedAt: now, currentCandidate: final, finalCandidate: final, resultReady: true, summary: { summary: 'Independent checks passed after repairing the documentation.', evidence: 'External catalog contract passed', remaining: [] }, verificationPolicy: policy, verification: { required: true, policyDigest: policy.digest, status: 'passed', repairsUsed: 1, maxRepairAttempts: 1, operations }, items: [], questions: [] };
const state = { room: { id: roomId, channelId: channel.id, name, project: { name }, roles: ['planner', 'builder', 'reviewer'].map(role => ({ role, agentId: randomUUID() })), verificationPolicy: null, acceptedHead: { revision: 1, goalId, candidate: final } }, goals: [goal], tasks: [], runs: operations.map(operation => ({ id: operation.latestRunId, goalId, goalAttempt: 1, executor: 'verification', operationId: operation.id, taskId: null, role: null, taskKind: 'verification', epoch: 1, status: operation.status, summary: null, error: null, sessionId: null, artifacts: [] })), events: [], questions: [], operations, canSubmit: true, canManage: true, roomBusy: false, defaultBudget: DEFAULT_BUDGETS };
const versions = [{ id: 'baseline', runId: null, kind: 'baseline', candidate: base, taskKind: null, planItemKey: null, goalAttempt: 1, createdAt: now, status: 'completed', changeSetAvailable: false }, ...[[producerId, first], [repairId, final]].map(([id, candidate]) => ({ id, runId: id, kind: 'run', candidate, taskKind: 'build', planItemKey: null, goalAttempt: 1, createdAt: now, status: 'completed', changeSetAvailable: true }))];
const side = { type: 'file', mode: 0o644, size: 10, sha256: '4'.repeat(64) };
const changes = candidate => ({ schemaVersion: 1, base, target: candidate, entries: [
  { path: 'README.md', change: 'modified', before: side, after: { ...side, mode: 0o755 }, binary: false, modeChanged: true, patch: '@@ -1 +1 @@\n-old docs\n+documented limit\n+<script>globalThis.campUnsafe=true</script>', patchTruncated: true, previewReason: null },
  { path: 'image.bin', change: 'added', before: null, after: side, binary: true, modeChanged: false, patch: null, patchTruncated: false, previewReason: 'binary' },
  { path: 'removed.txt', change: 'deleted', before: side, after: null, binary: false, modeChanged: false, patch: '-obsolete', patchTruncated: false, previewReason: null },
], truncated: true, stats: { added: 1, modified: 1, deleted: 1, typeChanged: 0 } });
const browser = await chromium.launch({ headless: true });
const folder = resolve('.camp/delivery-ui', name); await mkdir(folder, { recursive: true, mode: 0o700 });
const writes = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
  await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, auth);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length);
    assert.equal(request.headers().authorization, `Bearer ${auth.accessToken}`); assert.equal(request.headers()['x-server-id'], seed.server.id);
    let body, data;
    if (['PUT', 'POST'].includes(request.method())) { body = request.postDataJSON(); writes.push({ path, body }); }
    if (path === '/rooms') data = { rooms: [state.room] };
    else if (path === `/rooms/${roomId}`) data = state;
    else if (path === `/rooms/${roomId}/verification-policy` && request.method() === 'PUT') { assert.equal(body.expectedDigest, null); assert.deepEqual(body.policy.checks[0].argv, ['/bin/sh', '-c', 'node --test catalog.test.mjs']); state.room.verificationPolicy = { policy: body.policy, digest: '5'.repeat(64) }; data = state; }
    else if (path === `/rooms/${roomId}/goals/${goalId}/versions`) data = { versions, reason: null };
    else if (path.endsWith('/changes')) { const candidate = path.includes(producerId) ? first : final; data = { available: true, reason: null, runId: path.includes(producerId) ? producerId : repairId, candidate, changeSet: changes(candidate) }; }
    else if (path.endsWith('/verification')) { const passed = path.includes(repairId); data = { status: passed ? 'passed' : 'failed', operationId: passed ? 'op-pass' : 'op-fail', receipt: receipt(passed ? final : first, passed) }; }
    else throw new Error(`Unexpected Camp fixture request: ${request.method()} ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${channel.id}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
  const input = page.locator(`#camp-goal-${channel.id}`); await input.fill('Continue the catalog');
  assert.equal(await input.locator('xpath=ancestor::form').locator('button[type=submit]').isDisabled(), true);
  await panel.getByTestId('camp-policy-configure').click();
  const form = panel.getByTestId('camp-policy-form'); await form.getByRole('combobox').selectOption('shell');
  await form.getByRole('textbox', { name: 'Check command', exact: true }).fill('node --test catalog.test.mjs');
  await form.getByRole('button', { name: 'Save project checks' }).click();
  await form.waitFor({ state: 'detached' });
  await page.waitForFunction(id => !document.getElementById(id)?.closest('form')?.querySelector('button[type=submit]')?.disabled, `camp-goal-${channel.id}`);
  assert.equal(await input.inputValue(), 'Continue the catalog'); assert.equal(writes.length, 1);
  await panel.getByTestId('camp-policy-configure').click();
  const policyName = form.getByRole('textbox', { name: 'Check policy name' });
  await policyName.fill('Keep my unsaved policy draft');
  state.room.verificationPolicy = { digest: '6'.repeat(64), policy: { ...state.room.verificationPolicy.policy, revision: 2, name: 'Updated by another operator' } };
  await panel.getByRole('button', { name: 'Refresh room', exact: true }).click();
  await form.getByText(/Project checks changed while you were editing/).waitFor({ state: 'visible' });
  assert.equal(await policyName.inputValue(), 'Keep my unsaved policy draft');
  assert.equal(await form.getByRole('button', { name: 'Save project checks' }).isDisabled(), true);
  assert.equal(writes.length, 1);
  await form.getByRole('button', { name: 'Close editor' }).click();
  await panel.getByTestId('camp-policy-configure').click();
  assert.equal(await policyName.inputValue(), 'Updated by another operator');
  await form.getByRole('button', { name: 'Close editor' }).click();
  for (const role of ['planner', 'builder', 'reviewer']) assert.match(await panel.getByTestId(`camp-role-${role}`).innerText(), /Ready for work/);
  const history = panel.getByTestId(`camp-versions-${goalId}`); await history.locator('summary').first().click();
  const select = history.getByTestId('camp-version-select'); await select.waitFor({ state: 'visible' });
  await select.selectOption(producerId);
  const report = history.getByTestId('camp-verification-report');
  await page.waitForFunction(ref => document.querySelector('[data-testid=camp-verification-report]')?.getAttribute('data-candidate-ref') === ref, first.refId);
  assert.equal(await report.getAttribute('data-status'), 'failed'); await report.getByTestId('camp-verification-check-log').locator('summary').click();
  assert.match(await report.innerText(), /Missing documentation/); assert.match(await report.innerText(), /Only part/);
  await select.selectOption(repairId);
  await page.waitForFunction(ref => document.querySelector('[data-testid=camp-verification-report]')?.getAttribute('data-candidate-ref') === ref, final.refId);
  assert.equal(await report.getAttribute('data-status'), 'passed');
  await history.getByTestId('camp-change-entry').filter({ hasText: 'README.md' }).getByRole('button').click();
  assert.match(await history.innerText(), /patch is truncated/); assert.match(await history.innerText(), /Permissions/);
  assert.equal(await history.locator('script,img').count(), 0); assert.equal(await page.evaluate(() => Boolean(globalThis.campUnsafe)), false);
  await history.getByTestId('camp-change-entry').filter({ hasText: 'image.bin' }).getByRole('button').click(); assert.match(await history.innerText(), /Binary content changed/);
  await history.getByTestId('camp-change-entry').filter({ hasText: 'removed.txt' }).getByRole('button').click(); assert.match(await history.innerText(), /Does not exist/);
  assert.equal(writes.length, 1); assert.deepEqual(errors, []); assert.equal(await panel.getByTestId('camp-room-error').count(), 0);
  await page.screenshot({ path: resolve(folder, 'delivery-ui.png'), fullPage: true });
  const result = { event: 'delivery_ui_fixture_passed', url, realBrowser: true, realHttpAuthAndChannel: true, campApiIntercepted: true, modelCalls: 0, sandboxLaunches: 0, configuredPolicyWrites: 1, draftPreserved: true, concurrentPolicyDraftPreserved: true, stalePolicySaveBlocked: true, rolelessVerification: true, failedAndPassedReceipts: true, candidateBoundReports: true, textBinaryDeletedAndPermissions: true, truncationVisible: true, htmlInert: true };
  await writeFile('.camp/delivery-ui-latest.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
