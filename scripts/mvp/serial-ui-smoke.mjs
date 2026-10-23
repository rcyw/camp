// Real browser/authenticated HTTP shell with an isolated Camp protocol fixture.
// Camp API responses are intercepted explicitly; this does not run a model,
// Worker or Sandbox, and does not claim to validate backend scheduling.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { checkWorkerCompatibility, createWorkerDeclaration, getTaskRequirements } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const auth = await login.json();
const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' };
const name = `camp-serial-ui-${Date.now().toString(36)}`;
const created = await fetch(`${api}/api/channels/`, { method: 'POST', headers, body: JSON.stringify({ name, description: 'Browser-only serial workflow presentation fixture; no worker or model', visibility: 'public' }) });
assert.equal(created.ok, true);
const channelBody = await created.json();
const channel = channelBody.channel ?? channelBody;
const roomId = randomUUID(), goalId = randomUUID(), questionId = randomUUID();
// A no-op accepted result can remain the initial immutable Layer: no marker Commit.
const candidate = { type: 'layerfs', projectId: 'fixture-project', refKind: 'layer', refId: 'fixture-initial-snapshot', layerId: 'fixture-initial-snapshot', rootId: 'fixture-root', imageId: 'fixture-image' };
const budget = { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 };
const question = { id: questionId, goalId, goalAttempt: 1, taskId: 'fixture-build', originRunId: 'fixture-run', fromRole: 'builder', toRole: 'planner', needsHuman: true, status: 'awaiting_human', content: 'Should empty input return an empty list?', answer: null, answerByRole: null, canAnswer: true, createdAt: new Date().toISOString(), answeredAt: null };
const planItem = { key: 'api', title: 'Handle empty input', description: 'Preserve successful responses.', acceptance: 'Empty input returns an empty list.', verification: 'node --test api.test.mjs' };
const goal = { id: goalId, roomId, workflow: 'serial', title: 'Deliver the API change', description: 'Implement, review and verify the complete outcome.', status: 'waiting_question', reason: null, attempt: 1, budget, usage: { runs: 3, reviewRounds: 0, elapsedSeconds: 60 }, activeRuns: 0, canRetry: false, canCancel: true,
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, baseHeadRevision: 0, fromGoalId: null, currentCandidate: null, finalCandidate: null, summary: null,
  plan: { revision: 1, summary: 'Implement one bounded API change and verify its behavior.', tasks: [planItem] },
  items: [{ ...planItem, index: 0, status: 'building', reworkCount: 0, candidate: null, reviews: [] }], questions: [question],
  metrics: { runs: 3, reviewRounds: 0, elapsedSeconds: 60, itemsTotal: 1, itemsApproved: 0, questionsAsked: 1, questionsAnswered: 0, reworks: 0, humanAnswers: 0, agentAnswers: 0, manualRetries: 0 } };
const state = { room: { id: roomId, channelId: channel.id, name, project: { name }, roles: ['planner', 'builder', 'reviewer'].map(role => ({ role, agentId: randomUUID() })), acceptedHead: { revision: 0, goalId: null, candidate: null } },
  canSubmit: true, roomBusy: true, defaultBudget: { serial: budget, legacy: { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 } }, goals: [goal], questions: [question],
  tasks: [{ id: 'fixture-build', goalId, goalAttempt: 1, kind: 'build', planItemKey: 'api', role: 'builder', title: planItem.title, executionStatus: 'waiting_question', dependsOn: [] }], runs: [], events: [] };
const declaration = createWorkerDeclaration();
const requirements = getTaskRequirements({ protocolVersion: 1, workflow: 'serial', taskKind: 'final_review', inputCandidate: candidate });
const incompleteDeclaration = { ...declaration, taskKinds: declaration.taskKinds.filter(kind => kind !== 'final_review'), refKinds: ['commit'], capabilities: declaration.capabilities.filter(capability => capability !== 'questions.v1') };
const rejectedWorker = { workerId: 'fixture-worker-missing-capabilities', declaration: incompleteDeclaration, compatibility: checkWorkerCompatibility(incompleteDeclaration, requirements), requirements, lastSeenAt: new Date().toISOString(), lastClaimAt: null, lastRunId: null };
const idleWorker = { workerId: 'fixture-worker-idle', declaration, compatibility: null, requirements: null, lastSeenAt: new Date().toISOString(), lastClaimAt: null, lastRunId: null };
const browser = await chromium.launch({ headless: true });
const folder = resolve('.camp/serial-ui', name);
await mkdir(folder, { recursive: true, mode: 0o700 });
const writes = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, auth);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/camp/**', async route => {
    const req = route.request();
    assert.equal(req.headers().authorization, `Bearer ${auth.accessToken}`);
    assert.equal(req.headers()['x-server-id'], seed.server.id);
    const path = new URL(req.url()).pathname.slice('/api/camp'.length);
    let body;
    if (req.method() === 'POST') { body = req.postDataJSON(); writes.push({ path, body }); }
    let data;
    if (path === '/rooms') data = { rooms: [state.room] };
    else if (path === `/rooms/${roomId}`) data = state;
    else if (path === `/rooms/${roomId}/questions/${questionId}/answer`) {
      assert.deepEqual(body, { answer: 'Yes, return an empty list.' });
      Object.assign(question, { status: 'answered', answer: body.answer, answerByRole: 'human', answeredAt: new Date().toISOString(), canAnswer: false });
      goal.status = 'running'; goal.metrics.humanAnswers = 1; goal.metrics.questionsAnswered = 1;
      state.tasks[0].executionStatus = 'running';
      data = { question };
    } else if (path === `/rooms/${roomId}/goals/${goalId}/result`) data = { schemaVersion: 1, roomId, goalId, status: 'completed', resultReady: true, candidate, summary: goal.summary.summary, evidence: goal.summary.evidence, remaining: [], metrics: goal.metrics };
    else if (path === `/rooms/${roomId}/tasks`) {
      assert.equal(body.fromGoalId, goalId); assert.equal(body.description, 'Continue with stricter validation');
      data = state;
    } else throw new Error(`Unexpected Camp fixture request: ${req.method()} ${path}`);
    await route.fulfill({ status: req.method() === 'POST' ? 201 : 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${channel.id}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel');
  await panel.waitFor({ state: 'visible', timeout: 45_000 });
  const item = panel.getByTestId('camp-plan-item-api');
  await item.waitFor({ state: 'visible' });
  assert.match(await item.innerText(), /node --test api.test.mjs/);
  assert.equal(await panel.getByTestId('camp-worker-diagnostics').count(), 0, 'Older snapshots must preserve the room interface');
  const writesBeforeReports = writes.length;
  state.workers = [rejectedWorker, idleWorker];
  await panel.locator('header button').first().click();
  const reports = panel.getByTestId('camp-worker-diagnostics');
  await reports.getByText('fixture-worker-missing-capabilities').waitFor({ state: 'visible' });
  const rejected = reports.getByTestId('camp-worker-report').filter({ hasText: rejectedWorker.workerId });
  assert.match(await rejected.innerText(), /Cannot run the last checked task/);
  assert.match(await rejected.innerText(), /final_review/);
  assert.match(await rejected.innerText(), /questions\.v1/);
  assert.equal(await rejected.locator('time').getAttribute('datetime'), rejectedWorker.lastSeenAt);
  assert.match(await reports.getByTestId('camp-worker-report').filter({ hasText: idleWorker.workerId }).innerText(), /No task compatibility check yet/);
  assert.equal(await reports.getByRole('button').count(), 0, 'Viewing reports must not offer hidden work or worker restarts');
  assert.equal(writes.length, writesBeforeReports, 'Viewing compatibility reports must not mutate the room');
  const answer = page.locator(`#camp-answer-${questionId}`);
  await answer.fill('Yes, return an empty list.');
  await page.getByTestId(`camp-question-${questionId}`).locator('button[type="submit"]').click();
  await answer.waitFor({ state: 'detached' });
  assert.equal(writes.filter(write => write.path.includes('/answer')).length, 1);
  Object.assign(goal, { status: 'completed', completedAt: new Date().toISOString(), finalCandidate: candidate, currentCandidate: candidate, summary: { summary: 'Final acceptance passed and the result is ready.', evidence: 'node --test acceptance.test.mjs passed', remaining: [] } });
  goal.items[0].status = 'approved'; goal.items[0].candidate = candidate; goal.items[0].reworkCount = 1;
  goal.items[0].reviews = [{ runId: 'review-rejected', outcome: 'changes_requested', summary: 'Handle the missing empty-input case.', evidence: 'Empty-input test failed.', candidate: { projectId: candidate.projectId, refKind: 'commit', refId: 'rejected-candidate', commitId: 'rejected-candidate' }, createdAt: new Date().toISOString() }, { runId: 'review-approved', outcome: 'approved', summary: 'All checks passed.', evidence: 'node --test api.test.mjs passed', candidate, createdAt: new Date().toISOString() }];
  goal.metrics.itemsApproved = 1; goal.metrics.reworks = 1; state.roomBusy = false;
  Object.assign(rejectedWorker, { declaration, compatibility: checkWorkerCompatibility(declaration, requirements), lastSeenAt: new Date().toISOString() });
  state.room.acceptedHead = { revision: 1, goalId, candidate }; state.tasks[0].executionStatus = 'completed';
  await panel.locator('header button').first().click();
  const card = page.getByTestId(`camp-goal-${goalId}`);
  await card.getByText('Final acceptance passed and the result is ready.').waitFor({ state: 'visible' });
  await rejected.getByText('Passed the last task check').waitFor({ state: 'visible' });
  assert.match(await card.innerText(), /Initial file snapshot|初始文件快照/);
  assert.match(await panel.innerText(), /fixture-initial-snapshot/);
  const input = page.locator(`#camp-goal-${channel.id}`);
  await input.fill('Continue with stricter validation');
  const taskWritesBefore = writes.filter(write => write.path.endsWith('/tasks')).length;
  await card.getByRole('button', { name: /Continue from this result|基于此成果继续/ }).click();
  assert.equal(await input.inputValue(), 'Continue with stricter validation');
  assert.equal(writes.filter(write => write.path.endsWith('/tasks')).length, taskWritesBefore);
  await panel.getByTestId('camp-continuation-base').waitFor({ state: 'visible' });
  const downloadEvent = page.waitForEvent('download');
  await card.getByRole('button', { name: /Download result manifest|下载成果清单/ }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), `camp-result-${goalId}.json`);
  const downloaded = resolve(folder, download.suggestedFilename()); await download.saveAs(downloaded);
  const manifest = JSON.parse(await readFile(downloaded, 'utf8')); assert.equal(manifest.candidate.refId, candidate.refId);
  assert.equal(manifest.candidate.refKind, 'layer'); assert.equal(manifest.candidate.commitId, undefined);
  assert.equal(JSON.stringify(manifest).includes(auth.accessToken), false);
  await input.locator('xpath=ancestor::form').locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="camp-continuation-base"]') === null);
  assert.equal(writes.filter(write => write.path.endsWith('/tasks')).length, 1);
  assert.deepEqual(errors, []); assert.equal(await panel.getByTestId('camp-room-error').count(), 0);
  await page.screenshot({ path: resolve(folder, 'serial-ui.png'), fullPage: true });
  const receipt = { event: 'serial_ui_fixture_passed', url, roomId, realBrowser: true, realHttpAuthAndChannel: true, campApiIntercepted: true, modelCalls: 0, sandboxLaunches: 0, humanAnswerWrites: 1, submittedContinuation: true, manifestDownloaded: true, workerDiagnostics: { oldSnapshot: true, capabilityMismatch: true, uncheckedIdle: true, compatibleAfterUpdate: true, noImplicitWrites: true } };
  await writeFile(resolve('.camp/serial-ui-latest.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
