// Actual browser/authentication with isolated Camp HTTP fixtures. This script
// neither allocates a real Run nor launches a model, sandbox or pool manager.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_BUDGETS, parseCandidate, parseExecutionPool } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const origin = new URL(web).origin, seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const roomId = randomUUID(), goalId = randomUUID(), channelId = seed.channel.id, now = new Date().toISOString();
const base = parseCandidate({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'a'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64) });
const output = hex => parseCandidate({ ...base, refKind: 'commit', refId: '12' + hex.repeat(64), rootId: hex.repeat(64), baseRef: base.refId, layerId: undefined });
const pool = parseExecutionPool({ poolId: randomUUID(), storageId: 'e'.repeat(64), maxParallel: 2, workerIds: ['ui-pool.lane-1', 'ui-pool.lane-2'], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8589934592, pidsLimit: 1024 } });
const longSummary = Array.from({ length: 12 }, (_, index) => `Detailed checkpoint ${index + 1}: retain this complete run evidence in expanded history.`).join('\n');
const planItems = ['parser', 'docs'].map(key => ({ key, title: 'Implement ' + key, description: 'Independent ' + key + ' changes', acceptance: key + ' works', verification: 'node --test ' + key }));
const makeRun = (key, overrides = {}) => ({ id: 'run-' + key, goalId, goalAttempt: 1, taskId: 'build-' + key, role: 'builder', executor: 'agent', taskKind: 'build', planItemKey: key, workerId: pool.workerIds[key === 'parser' ? 0 : 1], epoch: 1, status: 'running', leaseValid: true, leaseExpiresAt: '2000-01-01T00:00:00Z', cleanupState: 'pending', summary: null, error: null, sessionId: null, artifacts: [], inputCandidate: base, ...overrides });
const policy = { digest: 'd'.repeat(64), policy: { id: 'tests', revision: 1, name: 'Independent checks', maxRepairAttempts: 1, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 1000 }] } };
const state = { room: { id: roomId, channelId, name: 'Parallel UI fixture', project: { name: 'parallel-ui' }, roles: [], storageId: pool.storageId, verificationPolicy: policy, acceptedHead: { revision: 0, goalId: null, candidate: null } }, goals: [], tasks: [], runs: [], operations: [], questions: [], workers: [], events: [], canManage: true, canSubmit: true, roomBusy: false, defaultBudget: DEFAULT_BUDGETS, supportedPlanModes: ['sequential', 'same_baseline_pair', 'parallel_pair'] };
let submissions = 0, answers = 0; const cancellations = [];
function startGoal(body) {
  state.roomBusy = true;
  state.goals = [{ id: goalId, roomId, title: body.title, description: body.description, status: 'running', workflow: 'serial', planMode: 'parallel_pair', protocolVersion: 4, reason: null, attempt: 1, budget: body.budget, usage: { runs: 3, reviewRounds: 0, elapsedSeconds: 12 }, activeRuns: 2, canRetry: false, canCancel: true, createdAt: now, startedAt: now, completedAt: null, resultReady: false, baseCandidate: base, executionPool: pool, verificationPolicy: policy, plan: { revision: 1, summary: 'Two independent candidates from one baseline', tasks: planItems }, items: planItems.map((item, index) => ({ ...item, index, status: 'building', reworkCount: 0, candidate: null, reviews: [], scheduling: { state: 'running', reason: null } })), integration: { required: true, status: 'pending', operations: [] } }];
  state.tasks = planItems.map(item => ({ id: 'build-' + item.key, goalId, goalAttempt: 1, role: 'builder', title: item.title, kind: 'build', planItemKey: item.key, executionStatus: 'running', dependsOn: [] }));
  state.runs = planItems.map(item => makeRun(item.key));
  state.runs[1].summary = longSummary;
}
const folder = resolve('.camp/parallel-ui', Date.now().toString(36)); await mkdir(folder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
  await context.addInitScript(({ accessToken, refreshToken, origin }) => { if (location.origin !== origin) return; localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, { ...auth, origin });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length), method = request.method();
    assert.ok(request.headers().authorization === 'Bearer ' + auth.accessToken, 'Fixture requests must use the authenticated session');
    assert.equal(request.headers()['x-server-id'], seed.server.id);
    let data;
    if (path === '/rooms' && method === 'GET') data = { rooms: [state.room] };
    else if (path === '/rooms/' + roomId && method === 'GET') data = state;
    else if (path === `/rooms/${roomId}/tasks` && method === 'POST') {
      const body = request.postDataJSON(); assert.equal(body.planMode, 'parallel_pair'); assert.equal(body.description, 'Deliver both independent changes'); submissions++; startGoal(body); data = state;
    } else if (path === `/rooms/${roomId}/questions/human-question/answer` && method === 'POST') {
      assert.equal(request.postDataJSON().answer, 'Return an empty list.'); answers++;
      state.questions[0] = { ...state.questions[0], status: 'answered', answer: 'Return an empty list.', canAnswer: false, answeredAt: now };
      state.goals[0].items[0].scheduling = { state: 'ready', reason: null }; data = { question: state.questions[0] };
    } else if (path === `/rooms/${roomId}/runs/run-docs/cancel` && method === 'POST') {
      cancellations.push(path); state.goals[0].status = 'cancelling'; state.goals[0].canCancel = false;
      state.runs = state.runs.map(run => ({ ...run, cancelRequestedAt: now })); data = { run: state.runs[1] };
    } else throw new Error('Unexpected parallel fixture request: ' + method + ' ' + path);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${channelId}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
  const refresh = () => panel.getByRole('button', { name: 'Refresh room', exact: true }).click();
  const connection = panel.getByTestId('camp-worker-connection'); await connection.locator('summary').click();
  await connection.getByTestId('camp-worker-launch-mode').selectOption('pool');
  assert.ok((await connection.getByTestId('camp-worker-command-poolStart').innerText()).includes('packages/camp-runtime/scripts/worker-pool.mjs'));
  assert.equal(await connection.getByTestId('camp-worker-command-start').count(), 0);
  await connection.getByText(/Stop the existing worker before starting the pool/).waitFor();
  await connection.getByTestId('camp-worker-command-poolStart').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'pool-start.png'), fullPage: true });
  await panel.getByTestId('camp-plan-mode').selectOption('parallel_pair');
  await panel.getByRole('textbox', { name: 'Give the team a goal' }).fill('Deliver both independent changes');
  await panel.getByRole('button', { name: 'Start team', exact: true }).click();
  const card = panel.getByTestId('camp-goal-' + goalId), builder = panel.getByTestId('camp-role-builder');
  await builder.locator('[data-run-id="run-docs"]').waitFor();
  assert.equal(await builder.getByTestId('camp-run-execution').count(), 2);
  await card.getByTestId('camp-execution-pool').getByText(pool.poolId, { exact: true }).waitFor();
  assert.equal(await panel.getByText('Heartbeat expired; awaiting recovery', { exact: true }).count(), 0);
  await builder.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'two-runs.png'), fullPage: true });
  await card.getByTestId('camp-execution-pool').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'pool-limits.png'), fullPage: true });
  const runHistory = card.getByTestId('camp-goal-history'); await runHistory.locator('summary').first().click();
  const detailedSummary = runHistory.locator('[data-testid=camp-run-history-execution][data-run-id=run-docs]').getByTestId('camp-run-summary');
  assert.equal(await detailedSummary.innerText(), longSummary);
  assert.ok(await detailedSummary.evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'Expanded run history must expose the full summary without clipping');
  await runHistory.locator('summary').first().click();

  state.runs[0] = makeRun('parser', { status: 'suspended', candidate: output('b'), cleanupState: 'confirmed', leaseValid: false });
  state.tasks[0].executionStatus = 'waiting_question';
  state.goals[0].items[0].scheduling = { state: 'waiting_question', reason: 'question_pending' };
  state.questions = [{ id: 'human-question', goalId, goalAttempt: 1, taskId: 'build-parser', originRunId: 'run-parser', fromRole: 'builder', toRole: 'planner', needsHuman: true, status: 'awaiting_human', content: 'Which empty-input result is required?', answer: null, answerByRole: null, canAnswer: true, createdAt: now, answeredAt: null }];
  await refresh(); await card.getByTestId('camp-plan-item-parser').getByText(/other item can continue/).waitFor();
  assert.equal(await builder.getByTestId('camp-run-execution').count(), 1);
  await panel.getByRole('textbox', { name: 'Your answer' }).fill('Return an empty list.');
  await panel.getByRole('button', { name: 'Send answer', exact: true }).click();
  await card.getByTestId('camp-plan-item-parser').locator('[data-state=ready]').waitFor(); assert.equal(answers, 1);

  state.runs = [makeRun('parser', { id: 'review-parser', role: 'reviewer', taskKind: 'review', taskId: 'review-parser', inputCandidate: output('b') }), makeRun('docs', { status: 'completed', cleanupState: 'confirmed', candidate: output('c') })];
  state.goals[0].items[1] = { ...state.goals[0].items[1], candidate: output('c'), status: 'reviewing', scheduling: { state: 'waiting_review', reason: 'reviewer_queue' } };
  await refresh(); await card.getByTestId('camp-plan-item-docs').getByText('Waiting for the serial reviewer', { exact: true }).waitFor();
  assert.equal(await panel.getByTestId('camp-role-reviewer').getByTestId('camp-run-execution').count(), 1);
  assert.equal(await card.getByTestId('camp-integration-receipt').count(), 0);
  await card.getByTestId('camp-plan-item-docs').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'review-queue.png'), fullPage: true });

  state.runs = [makeRun('parser'), makeRun('docs')]; await refresh();
  await builder.locator('[data-run-id="run-docs"]').getByRole('button', { name: 'Stop entire goal', exact: true }).click();
  const cleanup = card.getByTestId('camp-parallel-cleanup'); await cleanup.waitFor();
  assert.equal(await cleanup.getByTestId('camp-run-execution').count(), 2); assert.equal(cancellations.length, 1);
  state.runs = state.runs.map((run, index) => ({ ...run, status: 'cancelled', leaseValid: false, cleanupState: index === 0 ? 'confirmed' : 'unknown' }));
  Object.assign(state.goals[0], { status: 'cancelled', reason: 'cancelled_by_human', activeRuns: 0, canRetry: false, integration: { required: true, status: 'not_run', operations: [] }, verification: { required: true, policyDigest: policy.digest, status: 'not_run', repairsUsed: 0, maxRepairAttempts: 1, operations: [] } });
  state.workers = [{ workerId: 'foreign-lane', declaration: { protocolVersions: [1, 2, 3, 4], workerVersion: '0.6.0', taskKinds: ['build'], refKinds: ['layer', 'commit'], capabilities: [], executionPool: { ...pool, poolId: randomUUID() } }, compatibility: { status: 'incompatible', code: 'pool_mismatch', protocolVersion: 4, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [], missingHarnesses: [] }, requirements: null, lastSeenAt: now, lastClaimAt: null, lastRunId: null }];
  await refresh(); await cleanup.getByText('Sandbox cleanup confirmed.', { exact: true }).waitFor();
  await cleanup.getByText('This attempt can no longer submit results. Its sandbox cleanup has not been confirmed.', { exact: true }).waitFor();
  await card.getByText('No checks allocated', { exact: true }).waitFor();
  await card.getByText('No integration allocated', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Retry goal', exact: true }).count(), 0);
  await panel.getByTestId('camp-worker-report').getByText(/differs from the goal’s frozen pool/).waitFor();
  await cleanup.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'cancel-cleanup.png'), fullPage: true });
  assert.equal(await panel.getByTestId('camp-room-error').count(), 0); assert.deepEqual(errors, []); assert.equal(submissions, 1);
  const receipt = { event: 'parallel_ui_fixture_passed', url, realBrowser: true, realHttpAuth: true, campApiIntercepted: true, roleOutputs: 'synthetic', campDatabaseMutations: 0, modelCalls: 0, sandboxLaunches: 0, poolLaunches: 0, explicitPoolStartCommand: true, dualRunsVisible: true, fullRunHistoryReadable: true, databaseLeaseStateUsed: true, scopedQuestionAndOtherItemContinues: true, serialReviewerQueue: true, exactRunCancellationPath: cancellations[0], bothRunCleanupRetained: true, poolMismatchExplained: true, folder };
  await writeFile('.camp/parallel-ui-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
