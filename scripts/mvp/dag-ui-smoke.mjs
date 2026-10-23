// Real browser and authentication, with isolated Camp HTTP projections. This
// does not allocate a real Run, call a model or mutate the Camp database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_BUDGETS, parseCandidate, parseExecutionPool, serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';
import { captureDagRoom } from './capture-dag.mjs';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const origin = new URL(web).origin, seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const roomId = randomUUID(), goalId = randomUUID(), channelId = seed.channel.id, now = new Date().toISOString();
const base = parseCandidate({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'a'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64) });
const output = (hex, parent = base) => parseCandidate({ ...base, layerId: undefined, refKind: 'commit', refId: '12' + hex.repeat(64), rootId: hex.repeat(64), baseRef: parent.refId });
const foundation = output('b'), left = output('c', foundation), right = output('d', foundation), combined = output('e', foundation), delivered = output('0', combined);
const pool = parseExecutionPool({ poolId: randomUUID(), storageId: 'e'.repeat(64), maxParallel: 2, workerIds: ['dag.lane-1', 'dag.lane-2'], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8589934592, pidsLimit: 1024 } });
const nodeDefinitions = [
  { key: 'foundation', title: 'Shared foundation', dependsOnKeys: [] },
  { key: 'left', title: 'Left feature <img onerror=alert(1)>', dependsOnKeys: ['foundation'] },
  { key: 'right', title: 'Right feature', dependsOnKeys: ['foundation'] },
  { key: 'consumer', title: 'Verify combined behavior', dependsOnKeys: ['left', 'right'] },
].map(value => ({ ...value, description: 'Implement ' + value.key, acceptance: value.key + ' works', verification: 'node --test ' + value.key }));
const producerIds = Object.fromEntries(nodeDefinitions.map(node => [node.key, randomUUID()]));
const policy = { digest: 'd'.repeat(64), policy: { id: 'tests', revision: 1, name: 'Independent checks', maxRepairAttempts: 1, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 1000 }] } };
const state = { room: { id: roomId, channelId, name: 'DAG UI fixture', project: { name: 'dag-ui' }, roles: [], storageId: pool.storageId, verificationPolicy: policy, acceptedHead: { revision: 0, goalId: null, candidate: null } }, goals: [], tasks: [], runs: [], operations: [], questions: [], workers: [], events: [], canManage: true, canSubmit: true, roomBusy: false, defaultBudget: DEFAULT_BUDGETS, supportedPlanModes: ['sequential', 'same_baseline_pair', 'parallel_pair', 'bounded_dag'] };
let submissions = 0;
const cancellations = [];
function makeRun(key, overrides = {}) { return { id: producerIds[key], goalId, goalAttempt: 1, taskId: 'build-' + key, role: 'builder', executor: 'agent', taskKind: 'build', planItemKey: key, workerId: pool.workerIds[key === 'left' ? 0 : 1], epoch: 1, status: 'running', leaseValid: true, cleanupState: 'pending', summary: null, error: null, sessionId: null, artifacts: [], inputCandidate: foundation, ...overrides }; }
function startGoal(body) {
  state.roomBusy = true;
  state.goals = [{ id: goalId, roomId, title: body.title, description: body.description, workflow: 'serial', planMode: 'bounded_dag', protocolVersion: 5, status: 'running', reason: null, attempt: 1, budget: body.budget, usage: { runs: 5, reviewRounds: 1, elapsedSeconds: 15 }, activeRuns: 2, canRetry: false, canCancel: true, createdAt: now, startedAt: now, completedAt: null, resultReady: false, baseCandidate: base, currentCandidate: base, executionPool: pool, verificationPolicy: policy,
    plan: { revision: 2, summary: 'A foundation branches into two features, then one consumer.', tasks: nodeDefinitions },
    items: nodeDefinitions.map((node, index) => ({ ...node, index, status: index === 0 ? 'approved' : index === 3 ? 'pending' : 'building', reworkCount: 0, candidate: index === 0 ? foundation : null, reviews: [], inputSources: index === 1 || index === 2 ? [{ key: 'foundation', runId: producerIds.foundation, epoch: 1, candidate: foundation }] : [], inputCandidate: index === 0 ? base : index === 3 ? null : foundation, inputResolution: index === 0 ? 'baseline' : index === 3 ? null : 'single_parent', scopedIntegrationOperationId: null, scheduling: { state: index === 0 ? 'approved' : index === 3 ? 'waiting_dependencies' : 'running', reason: index === 3 ? 'dependencies_pending' : null, blockedByKeys: index === 3 ? ['left', 'right'] : [] } })),
    integration: { required: true, status: 'pending', operations: [] }, graph: { schemaVersion: 1, sinkKeys: ['consumer'], delivery: { status: 'waiting_nodes', candidate: null, sourceRunId: null, operationId: null } }, questions: [] }];
  state.tasks = nodeDefinitions.map(node => ({ id: 'build-' + node.key, goalId, goalAttempt: 1, role: 'builder', kind: 'build', planItemKey: node.key, title: node.title, executionStatus: node.key === 'foundation' ? 'completed' : node.key === 'consumer' ? 'queued' : 'running', dependsOn: [] }));
  state.runs = [makeRun('left'), makeRun('right')];
}
const folder = resolve('.camp/dag-ui', Date.now().toString(36)); await mkdir(folder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
let activePage;
const errors = [], campRequests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
  await context.addInitScript(({ accessToken, refreshToken, origin }) => { if (location.origin !== origin) return; localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, { ...auth, origin });
  const page = await context.newPage(); activePage = page; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length), method = request.method();
    campRequests.push(method + ' ' + path);
    assert.ok(request.headers().authorization === 'Bearer ' + auth.accessToken, 'Fixture requests require the authenticated session'); assert.equal(request.headers()['x-server-id'], seed.server.id);
    let data;
    if (path === '/rooms' && method === 'GET') data = { rooms: [state.room] };
    else if (path === '/rooms/' + roomId && method === 'GET') data = state;
    else if (path === `/rooms/${roomId}/tasks` && method === 'POST') {
      const body = request.postDataJSON(); assert.equal(body.planMode, 'bounded_dag'); assert.equal(body.description, 'Deliver both features and their consumer'); submissions++; startGoal(body); data = state;
    } else if (path === `/rooms/${roomId}/runs/${producerIds.right}/cancel` && method === 'POST') {
      cancellations.push(producerIds.right); state.goals[0].status = 'cancelling'; state.goals[0].canCancel = false; state.runs = state.runs.map(run => ({ ...run, cancelRequestedAt: now })); data = { run: state.runs[1] };
    } else throw new Error('Unexpected DAG fixture request: ' + method + ' ' + path);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`${web}/s/${seed.server.slug}/channel/${channelId}?tab=camp`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel'); await panel.waitFor({ state: 'visible', timeout: 45000 });
  const refresh = () => panel.getByRole('button', { name: 'Refresh room', exact: true }).click();
  await panel.getByTestId('camp-plan-mode').selectOption('bounded_dag');
  await panel.getByRole('textbox', { name: 'Give the team a goal' }).fill('Deliver both features and their consumer');
  await panel.getByRole('button', { name: 'Start team', exact: true }).click();
  const card = panel.getByTestId('camp-goal-' + goalId), graph = card.getByTestId('camp-dependency-graph'), consumer = card.getByTestId('camp-plan-item-consumer');
  await graph.waitFor(); assert.equal(await graph.locator('[data-graph-layer]').count(), 3); assert.equal(await graph.locator('img').count(), 0);
  assert.deepEqual(await graph.locator('[data-graph-layer]').evaluateAll(layers => layers.map(layer => [...layer.querySelectorAll('[data-testid^=camp-plan-item-]')].map(item => item.getAttribute('data-testid')))), [['camp-plan-item-foundation'], ['camp-plan-item-left', 'camp-plan-item-right'], ['camp-plan-item-consumer']]);
  assert.equal(await panel.getByTestId('camp-role-builder').getByTestId('camp-run-execution').count(), 2);
  assert.equal(await consumer.getByTestId('camp-node-blockers').getByRole('link').count(), 2);
  await consumer.getByText('Waiting for direct dependencies to be approved', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 0);
  await graph.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'dependencies.png'), fullPage: true });

  const current = state.goals[0];
  state.runs[0] = makeRun('left', { status: 'suspended', cleanupState: 'confirmed', leaseValid: false });
  current.items[1].scheduling = { state: 'waiting_question', reason: 'question_pending', blockedByKeys: [] };
  current.questions = [{ id: 'question', goalId, goalAttempt: 1, taskId: 'build-left', originRunId: producerIds.left, fromRole: 'builder', toRole: 'planner', needsHuman: true, status: 'awaiting_human', content: 'Which left behavior should be selected?', answer: null, answerByRole: null, canAnswer: false, createdAt: now, answeredAt: null }];
  state.questions = current.questions; await refresh();
  await card.getByTestId('camp-plan-item-left').getByText('Which left behavior should be selected?', { exact: true }).waitFor();
  assert.equal(await panel.getByTestId('camp-role-builder').getByTestId('camp-run-execution').count(), 1);
  assert.equal(await card.getByTestId('camp-plan-item-right').getByTestId('camp-run-execution').count(), 1);

  current.questions = []; state.questions = []; state.runs = [];
  for (const [index, value] of [[1, left], [2, right]]) current.items[index] = { ...current.items[index], status: 'approved', candidate: value, scheduling: { state: 'approved', reason: null, blockedByKeys: [] } };
  const integrationInput = { schemaVersion: 1, algorithm: 'layerfs-three-way-v2', policy: 'reject-overlap-v1', base: foundation, parents: [{ key: 'left', runId: producerIds.left, epoch: 1, candidate: left }, { key: 'right', runId: producerIds.right, epoch: 1, candidate: right }] };
  const inputDigest = createHash('sha256').update(serializeIntegrationInput(integrationInput)).digest('hex');
  const operation = { id: randomUUID(), goalId, goalAttempt: 1, kind: 'integration', scope: 'node_input', planItemKey: 'consumer', status: 'running', attempt: 1, infrastructureFailures: 0, createdAt: now, latestRunId: randomUUID(), integrationInput, inputDigest, integrationReport: null };
  current.integration = { required: true, status: 'running', operations: [operation] }; state.operations = [operation];
  current.items[3] = { ...current.items[3], inputSources: integrationInput.parents, scopedIntegrationOperationId: operation.id, scheduling: { state: 'waiting_integration', reason: 'node_integration_pending', blockedByKeys: [] } };
  await refresh(); await consumer.getByText('Waiting for approved parent inputs to be integrated', { exact: true }).waitFor();
  assert.equal(await card.getByTestId('camp-goal-integration').count(), 0);
  const opView = consumer.getByTestId('camp-integration-operation'), inputs = opView.getByTestId('camp-integration-inputs'); await inputs.locator('summary').click();
  assert.ok((await inputs.getByTestId('camp-integration-base').innerText()).includes(foundation.refId));
  assert.equal(await inputs.getByTestId('camp-integration-parent').count(), 2);
  await inputs.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'node-integration.png'), fullPage: true });
  await inputs.locator('summary').click();
  operation.status = 'completed'; operation.integrationReport = { schemaVersion: 1, inputDigest, algorithm: integrationInput.algorithm, policy: integrationInput.policy, status: 'merged', candidate: combined, conflicts: [], truncated: false, operationId: operation.id, runId: operation.latestRunId, integratedAt: now };
  current.integration.status = 'merged'; current.items[3] = { ...current.items[3], inputCandidate: combined, inputResolution: 'integration', status: 'building', scheduling: { state: 'running', reason: null, blockedByKeys: [] } };
  state.runs = [makeRun('consumer', { inputCandidate: combined })]; await refresh();
  await consumer.getByTestId('camp-integration-receipt').waitFor();
  await consumer.getByTestId('camp-node-effective-input').getByText(combined.refId, { exact: true }).waitFor();
  assert.equal(await card.getByTestId('camp-graph-delivery').getAttribute('data-status'), 'waiting_nodes');
  assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 0);
  current.graph.delivery = { status: 'ready', candidate: delivered, sourceRunId: producerIds.consumer, operationId: null };
  current.items[3] = { ...current.items[3], status: 'approved', candidate: delivered, scheduling: { state: 'approved', reason: null, blockedByKeys: [] } };
  current.currentCandidate = delivered; state.runs = [];
  await refresh(); await card.getByTestId('camp-graph-delivery').getByText(delivered.refId, { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 0);
  await card.getByTestId('camp-graph-delivery').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'graph-before-acceptance.png'), fullPage: true });
  const captured = await captureDagRoom({ page, panel, card, snapshot: state, goal: current, record: { kind: 'complete', roomId, goalId }, folder, readCamp: async () => { throw new Error('An unfinished graph must not request a delivered result'); } });
  assert.equal(captured.nodeCount, 4); assert.equal(captured.scopedIntegrationCount, 1); assert.equal(captured.resultReady, false);

  state.runs = [makeRun('left'), makeRun('right')]; await refresh();
  await panel.getByTestId('camp-role-builder').locator(`[data-run-id="${producerIds.right}"]`).getByRole('button', { name: 'Stop entire goal', exact: true }).click();
  await card.getByTestId('camp-parallel-cleanup').waitFor(); assert.equal(await card.getByTestId('camp-parallel-cleanup').getByTestId('camp-run-execution').count(), 2);
  assert.deepEqual(cancellations, [producerIds.right]); assert.equal(submissions, 1);
  assert.equal(await panel.getByTestId('camp-room-error').count(), 0); assert.deepEqual(errors, []);
  const result = { event: 'dag_ui_fixture_passed', realBrowser: true, realHttp: true, campResponsesMocked: true, campMutations: 0, fixtureMutations: submissions + cancellations.length, modelCalls: 0, dependencies: 4, topologicalLayers: 3, nodeScopedIntegration: true, exactBranchPointBase: true, intermediateOutputDoesNotDeliver: true, scopedQuestion: true, cancellationStopsWholeGoal: true, folder };
  await writeFile('.camp/dag-ui-latest.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await activePage?.screenshot({ path: resolve(folder, 'failed.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(folder, 'failure.json'), JSON.stringify({ errors, campRequests }, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify({ event: 'dag_ui_fixture_failed', folder, pageErrors: errors, campRequests }));
  throw error;
} finally { await browser.close(); }
