// Real browser/API workflow test with a protocol-only worker fixture.
// No model or sandbox is started by this check.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const auth = await login.json();
async function request(path, body, token = auth.accessToken) {
  const response = await fetch(`${api}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const name = `camp-goal-ui-${Date.now().toString(36)}`;
const directory = resolve('.camp/goal-ui', name);
await mkdir(directory, { recursive: true, mode: 0o700 });
const created = await request('/channels/', { name, description: 'Protocol-only goal budget/retry/cancel browser verification', visibility: 'public' });
const channel = created.channel ?? created;
const room = await request('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: directory } });
const { token } = await request(`/camp/rooms/${room.id}/worker-token`, {});
let state = await request(`/camp/rooms/${room.id}/tasks`, { workflow: 'legacy', title: 'Protocol fixture: one-run budget, explicit retry and cancellation', description: 'Browser/API verification fixture only; no DSH or sandbox is executed.', budget: { maxRuns: 1, maxReviewRounds: 1, maxDurationSeconds: 300 } });
const goal = state.goals.find(goal => goal.title.startsWith('Protocol fixture:'));
assert.ok(goal);
await writeFile(resolve(directory, 'context.json'), JSON.stringify({ roomId: room.id, goalId: goal.id, name }, null, 2) + '\n');
const workerId = name;
const claim = async () => {
  const claimId = randomUUID();
  const runToken = `camp_run_${createHmac('sha256', token).update(claimId).digest('hex')}`;
  return request('/camp/worker/claim', { workerId, claimId, runToken }, token);
};
const { run } = await claim();
assert.equal(run.role, 'planner');
await request(`/camp/worker/runs/${run.id}/complete`, { workerId, epoch: run.epoch, status: 'completed', summary: 'Protocol fixture acknowledgement; no model or sandbox was executed.' }, token);
assert.equal((await claim()).run, null, 'The second stage cannot exceed the one-run budget');
state = await request(`/camp/rooms/${room.id}`);
const stopped = state.goals.find(item => item.id === goal.id);
assert.equal(stopped.status, 'needs_attention');
assert.equal(stopped.reason, 'run_budget_exhausted');
assert.equal(state.tasks.filter(task => task.goalId === goal.id && task.executionStatus === 'blocked').length, 2);
const browser = await chromium.launch({ headless: true });
let passed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); }, auth);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://localhost:15190/s/${seed.server.slug}/channel/${channel.id}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId(`camp-goal-${goal.id}`);
  const retry = card.getByRole('button', { name: /重试目标|Retry goal/ });
  await retry.waitFor({ state: 'visible', timeout: 45_000 });
  assert.match(await card.innerText(), /执行次数已用尽|run limit/i);
  const retryResponse = page.waitForResponse(response => response.url().endsWith(`/goals/${goal.id}/retry`) && response.request().method() === 'POST');
  await retry.click();
  assert.equal((await retryResponse).status(), 200);
  const cancel = card.getByRole('button', { name: /停止目标|Stop goal/ });
  await cancel.waitFor({ state: 'visible' });
  state = await request(`/camp/rooms/${room.id}`);
  const retried = state.goals.find(item => item.id === goal.id);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.attemptHistory.length, 1);
  assert.equal(retried.attemptHistory[0].reason, 'run_budget_exhausted');
  assert.equal(state.tasks.filter(task => task.goalId === goal.id).length, 6, 'Retry must retain the old task generation');
  const cancelResponse = page.waitForResponse(response => response.url().endsWith(`/goals/${goal.id}/cancel`) && response.request().method() === 'POST');
  await cancel.click();
  assert.equal((await cancelResponse).status(), 200);
  state = await request(`/camp/rooms/${room.id}`);
  const final = state.goals.find(item => item.id === goal.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(state.tasks.filter(task => task.goalId === goal.id && task.goalAttempt === 2 && task.executionStatus === 'cancelled').length, 3);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(directory, 'goal-ui.png'), fullPage: true });
  const receipt = { event: 'goal_browser_smoke_passed', at: new Date().toISOString(), roomId: room.id, goalId: goal.id, url, protocolFixture: true, modelCalls: 0, sandboxLaunches: 0, budgetStoppedAtRuns: 1, retainedAttempts: 2, retainedTasks: 6, finalStatus: final.status };
  await writeFile(resolve('.camp/goal-ui-latest.json'), JSON.stringify(receipt, null, 2) + '\n');
  passed = true;
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  if (!passed) await request(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
}
