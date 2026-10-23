// Explicit real-provider acceptance: three items, a routed question, rework,
// final acceptance, an exported deliverable, and a second goal on that result.
// Only isolated channels, projects and files belonging to this probe are used.
import assert from 'node:assert/strict';
import { superviseOwnedChild } from './owned-child.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, open, chmod, realpath } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

if (!process.argv.includes('--real') && !process.argv.includes('--prepare-only')) throw new Error('Use --real for the explicit DSH/model test or --prepare-only to create an isolated project without running a model');
const execute = promisify(execFile);
const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const baked = JSON.parse(await readFile(resolve('packages/camp-runtime/.local/baked-image.json'), 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200, 'The local development account must be available');
const auth = await login.json();
const { accessToken } = auth;
async function request(path, body) {
  const response = await fetch(api + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, path + ': HTTP ' + response.status);
  return response.json();
}

const name = 'camp-serial-' + Date.now().toString(36);
const folder = resolve('.camp/serial', name);
const source = resolve(folder, 'source');
await mkdir(resolve(source, 'src'), { recursive: true, mode: 0o700 });
await mkdir(resolve(source, 'public'), { recursive: true });
await mkdir(resolve(source, 'test'), { recursive: true });
const originalFiles = {
  'package.json': JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/catalog.mjs': 'export function listItems(items) { return items.slice(); }\n',
  'src/server.mjs': 'import { createServer } from "node:http";\nexport function makeServer() { return createServer((req, res) => { res.setHeader("content-type", "application/json"); if (req.url === "/health") { res.end(JSON.stringify({ ok: true })); } else { res.statusCode = 404; res.end(JSON.stringify({ error: "not_found" })); } }); }\n',
  'public/index.html': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Catalog</title><main><h1>Catalog</h1><p>Search is coming soon.</p></main></html>\n',
  'test/baseline.test.mjs': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { listItems } from "../src/catalog.mjs";\ntest("listItems keeps its input unchanged", () => { const input = [{ name: "Apple" }]; assert.deepEqual(listItems(input), input); assert.notEqual(listItems(input), input); });\n',
};
for (const [path, content] of Object.entries(originalFiles)) await writeFile(resolve(source, path), content);
const created = await request('/channels/', { name, description: 'Real serial DSH plan, routed question, rework, final acceptance and continuation', visibility: 'public' });
const channel = created.channel ?? created;
const builderInstructions = 'For the first implementation item of a serial goal, before editing, read camp_read_context. If this goal has no answered question about case sensitivity, ask the planner with camp_ask_question whether filtering must be case-insensitive, then finish your turn immediately. On the resumed task read the answer and continue; do not ask the same question again. This routing exercise applies only to a goal whose requirement includes the phrase ROUTING_PROBE. Implement only the current item and preserve already accepted work.';
const reviewerInstructions = 'In addition to the task acceptance criteria, require a DELIVERY.md file that describes how to run node --test before approving any item. If it is missing, record changes_requested with this precise requirement; do not create or edit it yourself. This deliberate additional review policy exercises automatic rework. For final_review verify the entire original requirement. Keep all project files unchanged; temporary checks belong under /tmp.';
const room = await request('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: source, baseRef: 'main' }, roles: [{ role: 'planner' }, { role: 'builder', instructions: builderInstructions }, { role: 'reviewer', instructions: reviewerInstructions }] });
const configured = await fetch(api + '/api/camp/rooms/' + room.id + '/verification-policy', { method: 'PUT', headers: { authorization: 'Bearer ' + accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, body: JSON.stringify({ policy: { id: 'serial-node-tests', revision: 1, name: 'Node project tests', maxRepairAttempts: 1, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 60000 }] } }) });
assert.ok(configured.ok, 'Configure the frozen v2 verification policy before submitting a goal');
const credential = await request('/camp/rooms/' + room.id + '/worker-token', {});
const workerEnv = resolve(folder, 'worker.env');
const runtimeHome = resolve(folder, 'runtime');
await writeFile(workerEnv, 'CAMP_API_URL=' + api + '\nCAMP_WORKER_TOKEN=' + credential.token + '\nCAMP_WORKER_ID=' + name + '\nCAMP_WORKER_ONCE=1\nCAMP_RUNTIME_HOME=' + runtimeHome + '\nCAMP_RUNTIME_IMAGE=' + baked.imageId + '\n', { mode: 0o600 });
await chmod(workerEnv, 0o600);
const webUrl = web + '/s/' + seed.server.slug + '/channel/' + channel.id + '?tab=camp';
const requirement = 'ROUTING_PROBE. Deliver a working searchable catalog in exactly three ordered implementation items with keys search, http, page. Item search: extend listItems(items, query = "") in src/catalog.mjs with case-insensitive substring filtering by name and alphabetical name ordering, without mutating the input; cover empty, mixed-case and no-match queries in Node tests. Item http: extend makeServer() in src/server.mjs with GET /api/items?q=... using listItems and a small fixed sample catalog, preserving GET /health; test the real HTTP endpoint with node:http or fetch and close servers in tests. Item page: replace public/index.html with an accessible labelled search input and results area that fetches /api/items?q=..., renders names safely with textContent, handles errors, and shows the empty state; serve the page at GET /, and cover its delivery and important UI markup in tests. Keep the project dependency-free and verify with node --test. The coordinator must submit an accepted structured plan; developers work one item at a time. After all item reviews, perform final acceptance against this whole requirement and finalize the result. Do not publish or alter the source checkout.';
const receipt = { at: new Date().toISOString(), name, folder, sourcePath: source, roomId: room.id, channelId: channel.id, webUrl, runtimeHome, workerEnvPath: workerEnv, imageId: baked.imageId, requirement };
await writeFile(resolve(folder, 'context.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ event: 'serial_project_prepared', ...receipt }));

if (!process.argv.includes('--prepare-only')) {
  let worker;
  let workerLog;
  let workerExit;
  let ownedWorker;
  let workerNumber = 0;
  const snapshot = () => request('/camp/rooms/' + room.id);
  async function startWorker() {
    workerLog = await open(resolve(folder, 'worker-' + (++workerNumber) + '.log'), 'w', 0o600);
    worker = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=' + workerEnv, '--import', '@oxc-node/core/register', 'packages/camp-runtime/src/worker.mjs'], { detached: true, stdio: ['ignore', workerLog.fd, workerLog.fd], env: { ...process.env } });
    ownedWorker = superviseOwnedChild(worker, { handleSignals: true });
    workerExit = ownedWorker.exited;
  }
  async function waitForGoal(goalId, seconds = 1500) {
    const deadline = Date.now() + seconds * 1000;
    let lastState = '';
    while (Date.now() < deadline) {
      const state = await snapshot();
      await writeFile(resolve(folder, 'latest-state.json'), JSON.stringify(state, null, 2) + '\n');
      const goal = state.goals.find(item => item.id === goalId);
      assert.ok(goal);
      const active = state.runs.filter(run => run.goalId === goalId && run.status === 'running');
      const progress = { event: 'serial_progress', goalId, status: goal.status, approved: goal.metrics?.itemsApproved, total: goal.metrics?.itemsTotal, active: active.map(run => ({ role: run.role, kind: run.taskKind, item: run.planItemKey, epoch: run.epoch })), reason: goal.reason };
      const signature = JSON.stringify(progress);
      if (signature !== lastState) { console.log(signature); lastState = signature; }
      if (goal.status === 'completed') return { state, goal };
      if (['needs_attention', 'cancelled'].includes(goal.status)) throw new Error('Goal stopped: ' + goal.reason + '; inspect ' + folder);
      ownedWorker.assertRunning('Worker exited before final delivery; inspect ' + folder);
      await delay(2000);
    }
    throw new Error('Timed out waiting for serial delivery; inspect ' + folder);
  }
  async function finishWorker() {
    const ended = await Promise.race([workerExit, delay(30_000, null, { ref: false })]);
    assert.equal(ended?.code, 0, 'Worker must settle its outbox and exit with no ready work');
    await workerLog.close(); workerLog = null;
  }
  async function exportAndTest(goalId, label) {
    const manifest = await request('/camp/rooms/' + room.id + '/goals/' + goalId + '/result');
    assert.equal(manifest.resultReady, true);
    const manifestPath = resolve(folder, label + '-manifest.json');
    const output = resolve(folder, label + '-export');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await execute(process.execPath, ['packages/camp-runtime/scripts/export.mjs', '--manifest', manifestPath, '--output', output], { cwd: process.cwd(), env: { ...process.env, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: baked.imageId }, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const container = name + '-acceptance-' + label;
    let verified;
    try {
      verified = await execute('docker', ['run', '--rm', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=256m', '--mount', 'type=bind,source=' + output + ',target=/candidate,readonly', '--mount', 'type=bind,source=' + resolve('scripts/mvp/serial-acceptance.mjs') + ',target=/opt/camp-acceptance.mjs,readonly', '--workdir', '/workspace', baked.imageId, '/bin/sh', '-c', 'cp -R --preserve=mode --no-preserve=ownership /candidate/. /workspace/ && node /opt/camp-acceptance.mjs && node --test'], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    } finally { await execute('docker', ['rm', '-f', container]).catch(() => {}); }
    await writeFile(resolve(folder, label + '-export-tests.log'), verified.stdout + verified.stderr);
    assert.match(await readFile(resolve(output, 'DELIVERY.md'), 'utf8'), /node --test/);
    const fixed = verified.stdout.split('\n').find(line => line.startsWith('CAMP_ACCEPTANCE='));
    assert.ok(fixed, 'The independent acceptance harness must finish');
    const acceptance = JSON.parse(fixed.slice('CAMP_ACCEPTANCE='.length));
    await verifyCatalogPage(output, acceptance.catalogResponse, label === 'second');
    return { manifest, output, acceptance };
  }
  async function verifyCatalogPage(output, envelope, requireCount) {
    const browser = await chromium.launch({ headless: true });
    const injectedName = '<img src=x onerror="globalThis.campUnsafeHtml=true">';
    const original = Array.isArray(envelope) ? envelope : envelope.items;
    const items = [...original, { name: injectedName }];
    const queries = [];
    let apiFailure = false;
    const html = await readFile(resolve(output, 'public/index.html'), 'utf8');
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://camp-catalog.test') return route.abort();
        if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (url.pathname === '/api/items') {
          const query = url.searchParams.get('q') ?? ''; queries.push(query);
          if (apiFailure) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'injected_catalog_unavailable' }) });
          const filtered = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(envelope) ? filtered : { ...envelope, items: filtered, count: filtered.length, total: filtered.length }) });
        }
        try {
          const file = await realpath(resolve(output, 'public', '.' + decodeURIComponent(url.pathname)));
          const within = relative(await realpath(resolve(output, 'public')), file);
          if (within.startsWith('..') || within.startsWith('/')) return route.abort();
          return route.fulfill({ status: 200, contentType: extname(file) === '.css' ? 'text/css' : 'application/javascript', body: await readFile(file) });
        } catch { return route.fulfill({ status: 404, body: 'Not found' }); }
      });
      await page.goto('http://camp-catalog.test/', { waitUntil: 'networkidle' });
      const search = page.getByRole('searchbox', { name: /.+/ }).or(page.getByRole('textbox', { name: /.+/ })).first();
      await search.waitFor({ state: 'visible' });
      assert.ok(queries.length, 'The page must fetch the API');
      await page.waitForFunction(name => document.body.textContent.includes(name), injectedName);
      assert.equal(await page.locator('img').count(), 0, 'Catalog names must render as text');
      const query = original[0].name.toUpperCase();
      await search.fill(query); await search.press('Enter');
      const submit = page.getByRole('button', { name: /search|filter|搜索|筛选/i }).first();
      if (await submit.count()) await submit.click();
      await page.waitForFunction(query => document.body.textContent.includes(query), original[0].name);
      const expected = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
      for (const item of items.filter(item => !expected.includes(item))) await page.getByText(item.name, { exact: true }).waitFor({ state: 'hidden' });
      if (requireCount) {
        const status = page.locator('[role="status"], [aria-live]');
        assert.ok(await status.count(), 'Continuation must add an accessible result count');
        await page.waitForFunction(count => [...document.querySelectorAll('[role="status"], [aria-live]')].some(element => new RegExp('\\b' + count + '\\b').test(element.textContent)), expected.length);
        assert.match(await status.allTextContents().then(values => values.join(' ')), new RegExp('\\b' + expected.length + '\\b'));
      }
      await search.fill('camp-no-such-fruit'); await search.press('Enter');
      if (await submit.count()) await submit.click();
      for (const item of items) await page.getByText(item.name, { exact: true }).waitFor({ state: 'hidden' });
      assert.ok(queries.includes('camp-no-such-fruit'), 'The empty search must reach the API');
      assert.match(await page.locator('body').innerText(), /empty|no\b|0|没有|暂无|未找到/i, 'The page must show an empty state');
      apiFailure = true;
      await search.fill('camp-error-probe'); await search.press('Enter');
      if (await submit.count()) await submit.click();
      await page.getByRole('alert').or(page.getByText(/error|failed|unable|could not|错误|失败/i)).first().waitFor({ state: 'visible' });
      assert.ok(queries.includes('camp-error-probe'), 'The page must handle a real rejected API response');
      apiFailure = false;
      await search.fill(''); await search.press('Enter');
      if (await submit.count()) await submit.click();
      await page.waitForFunction(name => document.body.textContent.includes(name), injectedName);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(folder, (requireCount ? 'second' : 'first') + '-catalog.png'), fullPage: true });
    } finally { await browser.close(); }
  }
  async function verifyBrowser(firstId, secondId) {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
      await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); }, auth);
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('camp-room-panel').waitFor({ state: 'visible', timeout: 45_000 });
      const firstCard = page.getByTestId('camp-goal-' + firstId);
      const secondCard = page.getByTestId('camp-goal-' + secondId);
      await firstCard.waitFor({ state: 'visible' }); await secondCard.waitFor({ state: 'visible' });
      for (const key of ['search', 'http', 'page']) await firstCard.getByTestId('camp-plan-item-' + key).waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('camp-room-error').count(), 0);
      assert.deepEqual(errors, []);
      const screenshot = resolve(folder, 'room.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      return { screenshot, realApi: true, browserErrors: errors };
    } finally { await browser.close(); }
  }
  try {
    const initial = await request('/camp/rooms/' + room.id + '/tasks', { title: 'Deliver searchable catalog through three reviewed tasks', description: requirement });
    const firstGoal = initial.goals.find(goal => goal.title === 'Deliver searchable catalog through three reviewed tasks');
    assert.equal(firstGoal.workflow, 'serial');
    await startWorker();
    const first = await waitForGoal(firstGoal.id);
    await finishWorker();
    assert.deepEqual(first.goal.plan.tasks.map(item => item.key), ['search', 'http', 'page']);
    assert.equal(first.goal.metrics.itemsApproved, 3);
    assert.ok(first.goal.metrics.reworks >= 1, 'The extra reviewer delivery policy must trigger automatic rework');
    assert.ok(first.goal.questions.some(question => question.status === 'answered' && question.answerByRole === 'planner'), 'A real coordinator must answer the routed blocking question');
    assert.equal(first.goal.questions.some(question => question.needsHuman), false, 'The requirement already answers this routing probe');
    assert.equal(first.goal.metrics.humanAnswers, 0, 'The workflow must not require a human to forward the answer');
    assert.ok(first.goal.metrics.agentAnswers >= 1);
    assert.equal(first.goal.metrics.manualRetries, 0, 'Review rework must not require an explicit human retry');
    assert.ok(first.state.runs.some(run => run.goalId === firstGoal.id && run.status === 'suspended'));
    assert.ok(first.state.runs.some(run => run.goalId === firstGoal.id && run.taskKind === 'final_review' && run.outcome === 'approved'));
    assert.equal(first.state.room.acceptedHead.candidate.refId, first.goal.finalCandidate.refId);
    assert.equal(first.goal.finalCandidate.refKind, 'commit', 'This fixture changes source files and must produce a real Commit');
    const firstResult = await exportAndTest(firstGoal.id, 'first');
    const continued = await request('/camp/rooms/' + room.id + '/tasks', { title: 'Continue catalog with a visible result count', description: 'Continue from the accepted searchable catalog. Keep all existing search, HTTP, page and delivery documentation behavior. Add a visible results count to the page that updates after each search, with a descriptive accessible status. Add or update tests and run node --test. Use one implementation plan item and complete its review, final acceptance and summary.', fromGoalId: firstGoal.id });
    const secondGoal = continued.goals.find(goal => goal.title === 'Continue catalog with a visible result count');
    assert.equal(secondGoal.baseHeadRevision, first.state.room.acceptedHead.revision);
    assert.equal(secondGoal.currentCandidate.refId, first.goal.finalCandidate.refId);
    await startWorker();
    const second = await waitForGoal(secondGoal.id);
    await finishWorker();
    const secondResult = await exportAndTest(secondGoal.id, 'second');
    assert.equal(second.state.room.acceptedHead.revision, first.state.room.acceptedHead.revision + 1);
    for (const [path, content] of Object.entries(originalFiles)) assert.equal(await readFile(resolve(source, path), 'utf8'), content, 'The source checkout must remain unchanged: ' + path);
    const browser = await verifyBrowser(first.goal.id, second.goal.id);
    const completed = { ...receipt, event: 'real_serial_workflow_passed', completedAt: new Date().toISOString(), goals: [first.goal.id, second.goal.id], finalCandidate: second.goal.finalCandidate, firstMetrics: first.goal.metrics, secondMetrics: second.goal.metrics, humanAnswers: first.goal.metrics.humanAnswers + second.goal.metrics.humanAnswers, exports: [firstResult.output, secondResult.output], sourceUnchanged: true, browser };
    await writeFile(resolve(folder, 'receipt.json'), JSON.stringify(completed, null, 2) + '\n');
    await writeFile(resolve('.camp/serial-latest.json'), JSON.stringify(completed, null, 2) + '\n');
    console.log(JSON.stringify(completed, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ event: 'real_serial_workflow_failed', reason: error.message, folder, roomId: room.id }));
    process.exitCode = 1;
  } finally {
    try { await ownedWorker?.stop(); }
    finally { await workerLog?.close().catch(() => {}); }
  }
}
