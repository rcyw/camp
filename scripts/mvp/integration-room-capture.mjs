// Capture actual Camp projections. There are no fixture responses, task
// submissions, worker launches or model calls. Login may create an auth session.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { candidateIdentity, selectCapturedDelivery } from './capture-delivery.mjs';
import { captureDagRoom } from './capture-dag.mjs';

const args = process.argv.slice(2), options = new Map(), knownCases = ['complete', 'conflict', 'uncertain', 'uncertain_cancel', 'cancel', 'crash'];
for (let index = 0; index < args.length; index++) {
  const arg = args[index], key = arg.startsWith('--case=') ? '--case' : arg;
  if (!['--receipt', '--output-receipt', '--case'].includes(key) || options.has(key)) throw new Error('Choose --receipt <path>, optional --output-receipt <path> and --case=<kind>');
  const value = key === '--case' ? arg.slice(7) : args[++index];
  if (!value || value.startsWith('--')) throw new Error('Capture options require a value');
  options.set(key, value);
}
if (!options.has('--receipt')) throw new Error('A source receipt is required');
const sourcePath = resolve(options.get('--receipt')), source = JSON.parse(await readFile(sourcePath, 'utf8'));
const outputReceipt = resolve(options.get('--output-receipt') ?? '.camp/integration-ui-real-latest.json');
assert.notEqual(outputReceipt, sourcePath, 'The capture must not replace its source execution receipt');
const selectedCase = options.get('--case') ?? 'all';
if (!['all', ...knownCases].includes(selectedCase)) throw new Error('Unknown capture case');
const records = (Array.isArray(source.cases) ? source.cases : [{ ...source, kind: 'complete' }]).filter(record => selectedCase === 'all' || record.kind === selectedCase);
assert.ok(records.length > 0, 'The supplied receipt has no requested cases');
const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const trustedOrigin = new URL(web).origin;
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 200); const auth = await login.json();
async function readCamp(path) {
  const response = await fetch(api + '/api/camp' + path, { redirect: 'error', headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id }, signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `Read-only Camp request rejected (${response.status})`); return response.json();
}
const folder = resolve('.camp/integration-room-capture', Date.now().toString(36)); await mkdir(folder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
  await context.addInitScript(({ accessToken, refreshToken, origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en');
  }, { ...auth, origin: trustedOrigin });
  const page = await context.newPage(), errors = [], writes = [], captures = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    // GETs reach the real server unchanged. Mutating Camp requests are always
    // rejected, including accidental interactions added by a future UI change.
    const request = route.request();
    if (request.method() !== 'GET') { writes.push(request.method() + ' ' + new URL(request.url()).pathname); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  for (const record of records) {
    assert.ok(knownCases.includes(record.kind), 'Receipt cases require a known capture kind');
    assert.match(record.roomId ?? '', /^[a-f0-9-]{36}$/i); assert.match(record.goalId ?? '', /^[a-f0-9-]{36}$/i);
    const snapshot = await readCamp('/rooms/' + record.roomId), goal = snapshot.goals.find(value => value.id === record.goalId);
    assert.ok(goal, 'Goal from the receipt must remain readable'); assert.ok(['same_baseline_pair', 'parallel_pair', 'bounded_dag'].includes(goal.planMode));
    if (goal.planMode === 'bounded_dag') {
      const url = record.webUrl ?? `${web}/s/${seed.server.slug}/channel/${record.channelId ?? snapshot.room.channelId}?tab=camp`;
      assert.equal(new URL(url).origin, trustedOrigin, 'Set CAMP_WEB_URL explicitly when selecting another trusted UI origin');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
      const card = panel.getByTestId('camp-goal-' + goal.id);
      captures.push({ ...await captureDagRoom({ page, panel, card, snapshot, goal, record, folder, readCamp }), url });
      continue;
    }
    if (record.kind === 'uncertain_cancel') {
      assert.equal(goal.status, 'cancelled'); assert.equal(goal.reason, 'cancelled_by_human');
      assert.equal(goal.integrationInspectionRequired, true); assert.equal(goal.canRetry, false);
      assert.equal(snapshot.room.acceptedHead.revision, 0); assert.equal(goal.verification.operations.length, 0);
      assert.equal(goal.verification.status, 'not_run');
    }
    const operation = goal.integration?.operations.find(value => value.goalAttempt === goal.attempt);
    assert.ok(operation?.integrationInput?.parents.length === 2 || (goal.planMode === 'parallel_pair' && ['cancel', 'crash'].includes(record.kind) && !goal.resultReady), 'A delivered goal needs both frozen integration parents');
    const integrationNotAllocated = !operation && ['completed', 'cancelled', 'needs_attention'].includes(goal.status);
    if (integrationNotAllocated) assert.equal(goal.integration.status, 'not_run');
    const url = record.webUrl ?? `${web}/s/${seed.server.slug}/channel/${record.channelId ?? snapshot.room.channelId}?tab=camp`;
    assert.equal(new URL(url).origin, trustedOrigin, 'Set CAMP_WEB_URL explicitly when selecting another trusted UI origin');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
    const card = panel.getByTestId('camp-goal-' + goal.id), integration = card.getByTestId('camp-goal-integration');
    await integration.waitFor({ state: 'visible', timeout: 15000 });
    if (integrationNotAllocated) {
      await integration.getByText('No integration allocated', { exact: true }).waitFor();
      assert.equal(await integration.getByText('Waiting for both reviewed candidates', { exact: true }).count(), 0);
      assert.equal(await integration.getByText('Integration starts after both tasks have approved candidates.', { exact: true }).count(), 0);
    }
    if (goal.executionPool) {
      const pool = card.getByTestId('camp-execution-pool');
      assert.equal(await pool.getAttribute('data-pool-id'), goal.executionPool.poolId);
      for (const workerId of goal.executionPool.workerIds) assert.ok((await pool.innerText()).includes(workerId));
    }
    if (record.kind === 'uncertain_cancel') {
      const verification = card.getByTestId('camp-goal-verification');
      await verification.getByText('No checks allocated', { exact: true }).waitFor();
      assert.equal(await verification.getByText('Waiting to run checks', { exact: true }).count(), 0);
      assert.equal(await verification.getByTestId('camp-verification-operation').count(), 0);
    }
    const selected = operation ? integration.locator(`[data-testid=camp-integration-operation][data-operation-id="${operation.id}"]`) : integration;
    const inputs = operation ? selected.getByTestId('camp-integration-inputs') : null;
    if (inputs) {
    await inputs.locator('summary').click();
    const parents = inputs.getByTestId('camp-integration-parent'); assert.equal(await parents.count(), 2);
    assert.ok((await inputs.getByTestId('camp-integration-base').innerText()).includes(operation.integrationInput.base.refId));
    for (const [index, parent] of operation.integrationInput.parents.entries()) {
      assert.equal(await parents.nth(index).getAttribute('data-parent-key'), parent.key);
      assert.ok((await parents.nth(index).innerText()).includes(parent.candidate.refId));
    }
    await inputs.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, record.kind + '-inputs.png'), fullPage: true });
    await inputs.locator('summary').click();
    }
    const report = operation?.integrationReport;
    let delivery = null;
    if (goal.resultReady) {
      assert.equal(report?.status, 'merged');
      await selected.locator(`[data-testid=camp-integration-receipt][data-status=merged][data-candidate-ref="${report.candidate.refId}"]`).waitFor();
      const manifest = await readCamp(`/rooms/${record.roomId}/goals/${record.goalId}/result`);
      assert.equal(manifest.resultReady, true); assert.equal(manifest.integration.receipt.inputDigest, operation.inputDigest);
      assert.equal(manifest.integration.receipt.runId, report.runId); assert.equal(manifest.integration.input.parents.length, 2);
      assert.equal(candidateIdentity(manifest.integration.receipt.candidate), candidateIdentity(report.candidate));
      const versions = await readCamp(`/rooms/${record.roomId}/goals/${record.goalId}/versions`);
      assert.ok(versions.versions.some(value => value.kind === 'integration' && value.runId === report.runId), 'The integrated producer must appear in actual version history');
      delivery = selectCapturedDelivery({ goal, manifest, versions: versions.versions, acceptedHead: snapshot.room.acceptedHead });
      const version = delivery.version;
      const recorded = await readCamp(`/rooms/${record.roomId}/goals/${record.goalId}/versions/${version.runId}/changes`);
      assert.equal(recorded.available, true); assert.equal(candidateIdentity(recorded.changeSet.target), candidateIdentity(delivery.candidate));
      const verification = await readCamp(`/rooms/${record.roomId}/goals/${record.goalId}/versions/${version.runId}/verification`);
      assert.equal(verification.status, 'passed'); assert.equal(verification.receipt?.status, 'passed');
      assert.equal(candidateIdentity(verification.receipt.candidate), candidateIdentity(delivery.candidate));
      assert.equal(verification.receipt.policyDigest, goal.verificationPolicy.digest);
      const history = card.getByTestId('camp-versions-' + goal.id); await history.locator('summary').click();
      await history.getByTestId('camp-version-select').selectOption(version.id);
      await history.locator(`[data-testid=camp-verification-report][data-candidate-ref="${version.candidate.refId}"][data-status=passed]`).waitFor();
      assert.deepEqual(await history.getByTestId('camp-change-entry').evaluateAll(elements => elements.map(element => element.getAttribute('data-path'))), recorded.changeSet.entries.map(entry => entry.path));
      assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 1);
      await history.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, record.kind + '-versions.png'), fullPage: true });
    } else {
      assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 0);
      if (goal.integrationInspectionRequired || goal.reason === 'integration_inspection_required') {
        assert.equal(goal.canRetry, false); assert.equal(await card.getByRole('button', { name: 'Retry goal', exact: true }).count(), 0);
        await card.getByText(/no action to confirm that inspection and resume this goal/).waitFor();
      } else if (!['cancel', 'crash'].includes(record.kind)) {
        assert.ok(['conflict', 'rejected'].includes(report?.status));
        await selected.getByTestId('camp-integration-conflict').first().waitFor();
      }
    }
    await selected.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, record.kind + '-result.png'), fullPage: true });
    if (!goal.resultReady) {
      await card.locator('header').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(folder, record.kind + '-status.png'), fullPage: true });
    }
    assert.equal(await panel.getByTestId('camp-room-error').count(), 0);
    captures.push({ kind: record.kind, planMode: goal.planMode, executionPool: goal.executionPool ?? null, runs: snapshot.runs.filter(run => run.goalId === goal.id && run.goalAttempt === goal.attempt).map(run => ({ id: run.id, workerId: run.workerId, taskKind: run.taskKind, planItemKey: run.planItemKey, status: run.status, leaseValid: run.leaseValid, cleanupState: run.cleanupState })), roomId: record.roomId, goalId: record.goalId, url, resultReady: goal.resultReady, goalStatus: goal.status, goalReason: goal.reason, integrationInspectionRequired: goal.integrationInspectionRequired ?? null, canRetry: goal.canRetry, acceptedHeadRevision: snapshot.room.acceptedHead?.revision ?? null, verificationOperations: goal.verification?.operations.length ?? null, verificationStatus: goal.verification?.status ?? null, integrationStatus: goal.integration.status, integrationCandidate: report?.candidate?.refId ?? null, deliveredCandidate: delivery?.candidate ?? null, deliveredProducerRunId: delivery?.version.runId ?? null, candidate: delivery?.candidate.refId ?? null, parentCount: operation?.integrationInput.parents.length ?? 0 });
  }
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  const result = { event: 'integration_room_capture_passed', sourceReceipt: sourcePath, roleOutputs: source.roleOutputs ?? 'unspecified', realBrowser: true, realHttp: true, campResponsesMocked: false, campMutations: 0, modelCallsByCapture: 0, folder, captures };
  await writeFile(outputReceipt, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
