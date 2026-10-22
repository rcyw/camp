// Explicit real-provider probe: cancel a running DSH through the actual UI.
import assert from 'node:assert/strict';
import { readFile, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const receipt = JSON.parse(await readFile(resolve('.camp/mvp-receipt.json'), 'utf8'));
const login = await fetch(`${receipt.apiUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const auth = await login.json();
async function request(path, body) {
  const response = await fetch(`${receipt.apiUrl}/api/camp${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const before = await request(`/rooms/${receipt.roomId}`);
assert.ok(!before.runs.some(run => run.status === 'running'), 'Finish existing work before starting this probe');
const marker = `Cancellation probe ready ${Date.now()}`;
const state = await request(`/rooms/${receipt.roomId}/tasks`, { title: marker, role: 'planner', description: `This is an explicit cancellation test. First read context. Then call camp_progress with exactly "${marker}". Next execute node -e 'setTimeout(() => {}, 120000)' in the workspace and wait. Do not implement changes or finish early. A human will cancel this execution.` });
const task = state.tasks.find(task => task.title.includes(marker));
assert.ok(task);
const log = await open(resolve('.camp/mvp-cancel-worker.log'), 'w', 0o600);
const worker = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=.camp/mvp-worker.env', '--import', '@oxc-node/core/register', 'packages/camp-runtime/src/worker.mjs'], { stdio: ['ignore', log.fd, log.fd], env: { ...process.env } });
const workerExited = new Promise(resolveExit => worker.once('exit', (code, signal) => resolveExit({ code, signal })));
let browser;
try {
  let run, milestoneReached = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const snapshot = await request(`/rooms/${receipt.roomId}`);
    run = snapshot.runs.find(run => run.taskId === task.id);
    if (run && snapshot.events.some(event => event.runId === run.id && event.type === 'progress' && event.content === marker)) { milestoneReached = true; break; }
    if (run && run.status !== 'running') throw new Error(`Probe ended before cancellation: ${run.status}`);
    await delay(1000);
  }
  assert.ok(milestoneReached && run?.status === 'running', 'A real DSH must reach the cancellation milestone');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); }, auth);
  const page = await context.newPage();
  await page.goto(`${receipt.webUrl}?tab=camp`, { waitUntil: 'domcontentloaded' });
  const stop = page.getByTestId('camp-role-planner').getByRole('button', { name: /停止执行|Stop run/ });
  await stop.waitFor({ state: 'visible', timeout: 45_000 });
  const cancelled = page.waitForResponse(response => response.url().endsWith(`/runs/${run.id}/cancel`) && response.request().method() === 'POST');
  await stop.click();
  assert.equal((await cancelled).status(), 200);
  let final;
  const stopDeadline = Date.now() + 45_000;
  while (Date.now() < stopDeadline) {
    final = (await request(`/rooms/${receipt.roomId}`)).runs.find(item => item.id === run.id);
    if (final.status !== 'running') break;
    await delay(500);
  }
  assert.equal(final.status, 'cancelled', 'Cancellation must be acknowledged after cleanup');
  assert.ok(final.cancelRequestedAt);
  const outcome = await Promise.race([workerExited, delay(15_000).then(() => { throw new Error('Worker did not exit after cancellation'); })]);
  // Worker reports an intentionally cancelled run with a nonzero exit code.
  assert.equal(outcome.signal, null);
  const result = { event: 'cancel_smoke_passed', runId: run.id, status: final.status, worker: outcome, cancelledAt: new Date().toISOString() };
  await writeFile(resolve('.camp/mvp-cancel-receipt.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (worker.exitCode === null) worker.kill('SIGTERM');
  await log.close();
}
