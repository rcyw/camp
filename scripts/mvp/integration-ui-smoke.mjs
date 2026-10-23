// Authenticated real browser; Camp HTTP responses are isolated fixtures.
// This exercises UI contracts, never allocates a real goal, sandbox or model call.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_BUDGETS, parseCandidate, parseChangeSet, parseIntegrationInput, parseIntegrationReport, serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const roomId = randomUUID(), goalId = randomUUID(), channelId = seed.channel.id, now = new Date().toISOString();
const imageId = 'sha256:' + 'f'.repeat(64), folder = resolve('.camp/integration-ui', Date.now().toString(36));
await mkdir(folder, { recursive: true, mode: 0o700 });
const base = parseCandidate({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'a'.repeat(64), imageId });
const candidate = hex => parseCandidate({ type: 'layerfs', projectId: base.projectId, refKind: 'commit', refId: '12' + hex.repeat(64), rootId: hex.repeat(64), imageId, baseRef: base.refId });
const left = candidate('b'), right = candidate('c'), combined = candidate('d');
const frozen = () => parseIntegrationInput({ schemaVersion: 1, algorithm: 'layerfs-three-way-v1', policy: 'reject-overlap-v1', base, parents: [{ key: 'parser', runId: randomUUID(), epoch: 1, candidate: left }, { key: 'docs', runId: randomUUID(), epoch: 1, candidate: right }] });
const digest = input => createHash('sha256').update(serializeIntegrationInput(input)).digest('hex');
const policy = { digest: 'e'.repeat(64), policy: { id: 'acceptance', revision: 1, name: 'Independent Node checks', maxRepairAttempts: 1, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 120000 }] } };
const state = { room: { id: roomId, channelId, name: 'Pair fixture', project: { name: 'pair-fixture', repoPath: '/operator/source' }, roles: ['planner', 'builder', 'reviewer'].map(role => ({ role, agentId: randomUUID() })), verificationPolicy: policy, acceptedHead: { revision: 0, goalId: null, candidate: null } }, canManage: true, canSubmit: true, roomBusy: false, goals: [], tasks: [], runs: [], events: [], questions: [], operations: [], workers: [], defaultBudget: DEFAULT_BUDGETS };
let input = frozen(), inputDigest = digest(input), operationId = randomUUID(), producingRunId = randomUUID(), submits = 0, retries = 0, requestPaths = [];
const tasks = ['parser', 'docs'].map(key => ({ key, title: `Implement ${key}`, description: `Independent ${key} change`, acceptance: `${key} works from the shared baseline`, verification: `node --test ${key}.test.mjs` }));
const makeOperation = (status, integrationReport = null, goalAttempt = 1) => ({ id: operationId, goalId, goalAttempt, kind: 'integration', status, attempt: 1, infrastructureFailures: 0, createdAt: now, latestRunId: producingRunId, integrationInput: input, inputDigest, integrationReport });
const makeReport = (status, conflicts = [], truncated = false) => ({ ...parseIntegrationReport({ schemaVersion: 1, inputDigest, algorithm: input.algorithm, policy: input.policy, status, candidate: status === 'merged' ? combined : null, conflicts, truncated }), operationId, runId: producingRunId, integratedAt: now });
const changes = (target, paths) => parseChangeSet({ schemaVersion: 1, base, target, entries: paths.map(path => ({ path, change: 'added', before: null, after: { type: 'file', mode: 0o644, size: 4, sha256: '1'.repeat(64) }, binary: false, modeChanged: false, patch: '+safe text', patchTruncated: false, previewReason: null })), truncated: false, stats: { added: paths.length, modified: 0, deleted: 0, typeChanged: 0 } });
const verification = { schemaVersion: 1, status: 'passed', runId: randomUUID(), operationId: randomUUID(), verifiedAt: now, candidate: combined, policyDigest: policy.digest, checks: [{ id: 'tests', argv: ['node', '--test'], exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 12, stdout: 'Both integrated changes passed', stderr: '', outputTruncated: false }] };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, auth);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length), method = request.method();
    assert.equal(request.headers().authorization, 'Bearer ' + auth.accessToken); assert.equal(request.headers()['x-server-id'], seed.server.id);
    requestPaths.push(method + ' ' + path); let data;
    if (path === '/rooms' && method === 'GET') data = { rooms: [state.room] };
    else if (path === '/rooms/' + roomId && method === 'GET') data = state;
    else if (path === `/rooms/${roomId}/tasks` && method === 'POST') {
      const body = request.postDataJSON(); submits++; assert.equal(body.planMode, 'same_baseline_pair'); assert.equal(body.description, 'Deliver both independent changes');
      state.roomBusy = true;
      state.goals = [{ id: goalId, roomId, title: body.title, description: body.description, workflow: 'serial', planMode: body.planMode, protocolVersion: 3, status: 'running', reason: null, attempt: 1, budget: body.budget, usage: { runs: 5, reviewRounds: 2, elapsedSeconds: 42 }, activeRuns: 0, canRetry: false, canCancel: true, createdAt: now, startedAt: now, completedAt: null, baseHeadRevision: 0, baseCandidate: base, currentCandidate: right, finalCandidate: null, resultReady: false, verificationPolicy: policy, plan: { revision: 1, summary: 'Build two independent candidates from one baseline', tasks }, items: tasks.map((task, index) => ({ ...task, index, status: 'approved', candidate: index === 0 ? left : right, reworkCount: 0, reviews: [] })), integration: { required: true, status: 'running', operations: [makeOperation('running')] } }]; data = state;
    } else if (path === `/rooms/${roomId}/goals/${goalId}/retry` && method === 'POST') {
      const body = request.postDataJSON(); assert.equal(body.expectedAttempt, 1); retries++;
      state.operations = state.goals[0].integration.operations;
      input = frozen(); inputDigest = digest(input); operationId = randomUUID(); producingRunId = randomUUID();
      const active = makeOperation('running', null, 2); state.operations.push(active);
      Object.assign(state.goals[0], { attempt: 2, status: 'running', reason: null, canRetry: false, canCancel: true, integration: { required: true, status: 'running', operations: [active] } }); state.roomBusy = true; data = state;
    } else if (path === `/rooms/${roomId}/goals/${goalId}/versions`) {
      const version = (id, kind, selected, taskKind, planItemKey = null) => ({ id, runId: kind === 'baseline' ? null : id, kind, candidate: selected, taskKind, planItemKey, operationId: kind === 'integration' ? operationId : null, goalAttempt: 2, createdAt: now, status: 'completed', changeSetAvailable: kind !== 'baseline' });
      data = { versions: [version('baseline', 'baseline', base, null), version(input.parents[0].runId, 'run', left, 'build', 'parser'), version(input.parents[1].runId, 'run', right, 'build', 'docs'), version(producingRunId, 'integration', combined, 'integration')], reason: null };
    } else if (path.endsWith('/changes')) {
      const runId = path.split('/').at(-2); const selected = runId === producingRunId ? combined : runId === input.parents[0].runId ? left : right;
      assert.ok([producingRunId, ...input.parents.map(parent => parent.runId)].includes(runId));
      data = { available: true, reason: null, runId, candidate: selected, changeSet: changes(selected, selected === combined ? ['src/parser.mjs', 'docs/usage.md'] : selected === left ? ['src/parser.mjs'] : ['docs/usage.md']) };
    } else if (path.endsWith('/verification')) data = path.includes(producingRunId) ? { status: 'passed', operationId: verification.operationId, receipt: verification } : { status: 'unavailable', operationId: null, receipt: null };
    else if (path === `/rooms/${roomId}/goals/${goalId}/result`) data = { schemaVersion: 1, roomId, goalId, goalAttempt: 2, workflow: 'serial', planMode: 'same_baseline_pair', status: 'completed', resultReady: true, candidate: combined, summary: 'Both changes integrated and checked', evidence: 'Independent fixed checks passed', remaining: [], metrics: { runs: 9, reviewRounds: 3, elapsedSeconds: 60, itemsTotal: 2, itemsApproved: 2, questionsAsked: 0, questionsAnswered: 0, reworks: 0, humanAnswers: 0, agentAnswers: 0, manualRetries: 1 }, verification: { policy, receipt: verification }, integration: { input, receipt: makeReport('merged') } };
    else throw new Error(`Unexpected integration fixture request: ${method} ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${channelId}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' }); const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
  const refresh = async () => { await panel.getByRole('button', { name: 'Refresh room', exact: true }).click(); };
  assert.equal(await panel.getByTestId('camp-plan-mode').count(), 0);
  state.supportedPlanModes = ['sequential', 'same_baseline_pair']; await refresh();
  const mode = panel.getByTestId('camp-plan-mode'); await mode.waitFor({ state: 'visible' }); assert.equal(await mode.inputValue(), 'sequential'); await mode.selectOption('same_baseline_pair');
  const field = panel.getByRole('textbox', { name: 'Give the team a goal' }); await field.fill('Deliver both independent changes'); await field.locator('xpath=ancestor::form').locator('button[type=submit]').click();
  const card = panel.getByTestId('camp-goal-' + goalId), integration = card.getByTestId('camp-goal-integration');
  await integration.locator('[data-testid=camp-integration-operation][data-status=running]').waitFor();
  assert.equal(submits, 1); assert.equal(await mode.inputValue(), 'sequential');
  for (const parent of input.parents) assert.ok((await card.getByTestId('camp-plan-item-' + parent.key).getByTestId('camp-item-shared-baseline').textContent()).includes(base.refId));
  assert.equal(await card.getByRole('button', { name: 'Download result manifest' }).count(), 0);
  const conflictReceipt = makeReport('conflict', [{ path: '<img onerror=alert(1)>.mjs', reason: 'overlap' }, { path: 'hidden\u202e.mjs', reason: 'structural' }], true);
  Object.assign(state.goals[0], { status: 'needs_attention', reason: 'integration_conflict', canRetry: true, canCancel: false, integration: { required: true, status: 'conflict', operations: [makeOperation('completed', conflictReceipt)] } }); state.roomBusy = false; await refresh();
  await integration.locator('[data-testid=camp-integration-receipt][data-status=conflict]').waitFor();
  assert.equal(await integration.locator('img').count(), 0); assert.ok((await integration.innerText()).includes('hidden\\u202e.mjs')); assert.ok((await integration.innerText()).includes('list is incomplete'));
  await page.screenshot({ path: resolve(folder, 'conflict.png'), fullPage: true });
  await card.getByRole('button', { name: 'Retry goal', exact: true }).click(); await integration.locator('[data-testid=camp-integration-operation][data-status=running]').waitFor(); assert.equal(retries, 1);
  const successReceipt = makeReport('merged');
  const { checks, ...verificationSummary } = verification;
  Object.assign(state.goals[0], { status: 'completed', completedAt: now, currentCandidate: combined, finalCandidate: combined, resultReady: true, canCancel: false, canRetry: false, summary: { summary: 'Both changes integrated and checked', evidence: 'Independent fixed checks passed', remaining: [] }, integration: { required: true, status: 'merged', operations: [makeOperation('completed', successReceipt, 2)] }, verification: { required: true, policyDigest: policy.digest, status: 'passed', repairsUsed: 0, maxRepairAttempts: 1, operations: [{ id: verification.operationId, goalId, goalAttempt: 2, kind: 'verification', inputCandidate: combined, policyDigest: policy.digest, status: 'completed', attempt: 1, infrastructureFailures: 0, createdAt: now, latestRunId: verification.runId, receipt: { ...verificationSummary, checks: checks.map(({ argv: _argv, stdout: _stdout, stderr: _stderr, ...facts }) => facts) } }] } });
  state.operations = [...state.operations.filter(operation => operation.goalAttempt !== 2), ...state.goals[0].integration.operations];
  state.room.acceptedHead = { revision: 1, goalId, candidate: combined }; state.roomBusy = false; await refresh();
  await integration.locator(`[data-testid=camp-integration-receipt][data-candidate-ref="${combined.refId}"]`).waitFor();
  const earlier = integration.getByTestId('camp-integration-history'); await earlier.locator('summary').first().click();
  await earlier.locator('[data-testid=camp-integration-receipt][data-status=conflict]').waitFor();
  await earlier.locator('summary').first().click();
  const versions = card.getByTestId('camp-versions-' + goalId); await versions.locator('summary').click(); const select = versions.getByTestId('camp-version-select'); await select.waitFor();
  for (const [id, selected, expectedFiles] of [[input.parents[0].runId, left, ['src/parser.mjs']], [input.parents[1].runId, right, ['docs/usage.md']], [producingRunId, combined, ['src/parser.mjs', 'docs/usage.md']]]) {
    await select.selectOption(id); await versions.locator(`[data-testid=camp-verification-report][data-candidate-ref="${selected.refId}"]`).waitFor();
    const files = versions.getByTestId('camp-change-entry');
    assert.deepEqual(await files.evaluateAll(elements => elements.map(element => element.getAttribute('data-path'))), expectedFiles);
  }
  await versions.locator(`[data-testid=camp-verification-report][data-candidate-ref="${combined.refId}"][data-status=passed]`).waitFor();
  const downloading = page.waitForEvent('download'); await card.getByRole('button', { name: 'Download result manifest', exact: true }).click(); const download = await downloading;
  const downloaded = resolve(folder, download.suggestedFilename()); await download.saveAs(downloaded); const manifest = JSON.parse(await readFile(downloaded, 'utf8'));
  assert.equal(manifest.planMode, 'same_baseline_pair'); assert.equal(manifest.integration.receipt.inputDigest, inputDigest); assert.equal(manifest.integration.receipt.candidate.refId, combined.refId); assert.equal(manifest.integration.input.parents.length, 2);
  await field.fill('Continue from the combined result'); await card.getByRole('button', { name: 'Continue from this result', exact: true }).click();
  assert.equal(await field.inputValue(), 'Continue from the combined result'); assert.equal(await mode.inputValue(), 'sequential');
  assert.equal(await panel.getByTestId('camp-continuation-base').count(), 1); assert.equal(await panel.getByTestId('camp-room-error').count(), 0); assert.deepEqual(errors, []);
  await integration.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'integration.png'), fullPage: true });
  const result = { event: 'integration_ui_fixture_passed', url, realBrowser: true, realHttpAuth: true, campApiIntercepted: true, campDatabaseMutations: 0, modelCalls: 0, sandboxLaunches: 0, oldServerModeHidden: true, pairIntentSubmitted: submits === 1, sharedBaselineShown: true, conflictsInert: true, retryExpectedAttempt: retries === 1, originalConflictRetained: true, producerVersionApi: requestPaths.some(path => path.endsWith(producingRunId + '/changes')), combinedDiffHasBothChanges: true, receiptCandidateBound: true, manifestDownloaded: true, continuationDraftPreserved: true };
  await writeFile('.camp/integration-ui-latest.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
