// Explicit real DSH/LayerFS acceptance of trusted verification failure, bounded
// automatic repair, immutable candidate changes, and independent final export.
import assert from 'node:assert/strict';
import { superviseOwnedChild } from './owned-child.mjs';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';

if (!process.argv.includes('--real')) throw new Error('Use --real: this acceptance uses the configured model, Docker and LayerFS');
const execute = promisify(execFile);
const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const baked = JSON.parse(await readFile('packages/camp-runtime/.local/baked-image.json', 'utf8'));
const previous = JSON.parse(await readFile('.camp/protocol-latest.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const auth = await login.json();
async function request(path, body, method) {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(api + '/api' + path, { method: verb, headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (verb !== 'GET' || attempt >= 20) throw error;
      await delay(1000); continue;
    }
    if (verb === 'GET' && response.status >= 500 && attempt < 20) { await response.arrayBuffer(); await delay(1000); continue; }
    assert.ok(response.ok, path + ': HTTP ' + response.status + (response.ok ? '' : ' ' + await response.text()));
    return response.json();
  }
}
async function prepareScenario() {
const name = 'camp-delivery-' + Date.now().toString(36);
const folder = resolve('.camp/delivery', name);
const source = resolve(folder, 'source');
const runtimeHome = resolve(folder, 'runtime');
await mkdir(folder, { recursive: true, mode: 0o700 });
await cp(previous.output, source, { recursive: true, errorOnExist: true, force: false });
const originalNotes = await readFile(resolve(source, 'DELIVERY.md'), 'utf8');
assert.doesNotMatch(originalNotes, /^#{1,6}\s+Result limits\s*$/m);
const channelResult = await request('/channels/', { name, description: 'Trusted checks reject an incomplete candidate and trigger automatic repair before final acceptance', visibility: 'public' });
const channel = channelResult.channel ?? channelResult;
const room = await request('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: source, baseRef: 'main' }, roles: [
  { role: 'planner', instructions: 'Only for a requirement containing DELIVERY_VERIFICATION_PROBE: this is a deterministic platform validation exercise; submit exactly one implementation item catalog-limit covering functional code and Node tests. The platform separately verifies delivery documentation and no question needs a human answer. For other requirements, coordinate normally with a plan that fits the requested scope.' },
  { role: 'builder', instructions: 'For DELIVERY_VERIFICATION_PROBE, the first implementation build must implement and test the functional code, preserving DELIVERY.md byte-for-byte. This is an explicit verification-boundary exercise: delivery notes are deliberately deferred until the platform reports its check failure. After trusted verification feedback requests whole-goal repair, satisfy every original requirement, including Result limits documentation; run node --test. Do not ask a question or manufacture PASS. Never change the platform harness.' },
  { role: 'reviewer', instructions: 'For DELIVERY_VERIFICATION_PROBE item review, review functional code and Node tests; delivery notes are explicitly deferred to the platform verification checkpoint. Approve correct functional work without asking for deferred docs. For final_review verify the entire original requirement and the platform verification evidence. Keep the project unchanged.' },
] });
const harnessPath = resolve('scripts/mvp/delivery-acceptance.mjs');
const sha256 = createHash('sha256').update(await readFile(harnessPath)).digest('hex');
const policy = { id: 'catalog-delivery', revision: 1, name: 'Catalog tests and fixed delivery contract', maxRepairAttempts: 1, checks: [
  { id: 'project-tests', label: 'Candidate Node test suite', argv: ['node', '--test'], timeoutMs: 60_000 },
  { id: 'catalog-contract', label: 'Operator-owned catalog delivery contract', argv: ['node', '/camp-checks/catalog-contract'], timeoutMs: 30_000, harness: { id: 'catalog-contract', sha256 } },
] };
await request('/camp/rooms/' + room.id + '/verification-policy', { policy }, 'PUT');
const credential = await request('/camp/rooms/' + room.id + '/worker-token', {});
const harnessManifest = resolve(folder, 'harnesses.json');
await writeFile(harnessManifest, JSON.stringify([{ id: 'catalog-contract', path: harnessPath }]) + '\n', { mode: 0o600 });
const workerEnvPath = resolve(folder, 'worker.env');
await writeFile(workerEnvPath, 'CAMP_API_URL=' + api + '\nCAMP_WORKER_TOKEN=' + credential.token + '\nCAMP_WORKER_ID=' + name + '\nCAMP_RUNTIME_HOME=' + runtimeHome + '\nCAMP_RUNTIME_IMAGE=' + baked.imageId + '\nCAMP_VERIFICATION_HARNESSES=' + harnessManifest + '\n', { mode: 0o600 });
await chmod(workerEnvPath, 0o600);
const webUrl = web + '/s/' + seed.server.slug + '/channel/' + channel.id + '?tab=camp';
const requirement = 'DELIVERY_VERIFICATION_PROBE. Continue the inherited searchable catalog in exactly one ordered implementation item with key catalog-limit. Extend listItems(items, query = "", limit = undefined) with an optional nonnegative integer result limit applied after case-insensitive filtering and alphabetical sorting. Omitted or undefined limit preserves existing behavior; zero returns []; a limit exceeding the result count returns all matches. Wrong-type limits throw TypeError; negative, non-finite or fractional numbers throw RangeError. Preserve the input. Extend GET /api/items?limit=N with the same count limit, combined with q; absent limit preserves the full result. Empty, negative, fractional and nonnumeric query limits return HTTP 400. Preserve /health, page behavior and all existing tests. Add meaningful Node tests. DELIVERY.md must include a heading exactly Result limits explaining the API, invalid values and node --test. The first implementation item deliberately defers documentation according to the room role policy so the independent trusted check can reject it; a platform-requested whole-goal repair must complete all requirements. Finish with independent final review and a coordinator summary. No publication and no source checkout modification.';
const submitted = await request('/camp/rooms/' + room.id + '/tasks', { title: 'Deliver result limits through trusted verification and automatic repair', description: requirement });
const goal = submitted.goals.find(value => value.title === 'Deliver result limits through trusted verification and automatic repair');
assert.equal(goal.protocolVersion, 2);
assert.ok(goal.verificationPolicy?.digest);
const context = { name, folder, source, roomId: room.id, channelId: channel.id, goalId: goal.id, webUrl, runtimeHome, workerEnvPath, imageId: baked.imageId, policy, policyDigest: goal.verificationPolicy.digest };
await writeFile(resolve(folder, 'context.json'), JSON.stringify(context, null, 2) + '\n');
await writeFile('.camp/delivery-pending.json', JSON.stringify(context, null, 2) + '\n');
console.log(JSON.stringify({ event: 'delivery_prepared', ...context }));
// A previous-generation worker must not silently bypass the new goal's gate.
const declaration = createWorkerDeclaration();
for (const [label, protocol] of [
  ['v1-only', { ...declaration, protocolVersions: [1] }],
  ['without-diff', { ...declaration, capabilities: declaration.capabilities.filter(value => value !== 'candidate-diff.v1') }],
]) {
  const response = await fetch(api + '/api/camp/worker/claim', { method: 'POST', headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' }, body: JSON.stringify({ workerId: name + '-' + label, protocol }), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok);
  const refused = await response.json();
  assert.equal(refused.run, null); assert.equal(refused.compatibility.status, 'incompatible');
  const unchanged = await request('/camp/rooms/' + room.id);
  assert.equal(unchanged.runs.length, 0); assert.equal(unchanged.goals.find(value => value.id === goal.id).usage.runs, 0);
}
return context;
}
const resumeIndex = process.argv.indexOf('--resume');
const context = resumeIndex < 0 ? await prepareScenario() : JSON.parse(await readFile(process.argv[resumeIndex + 1], 'utf8'));
const { name, folder, source, roomId, goalId, webUrl, workerEnvPath } = context;
const room = { id: roomId }, goal = { id: goalId };
const originalNotes = await readFile(resolve(source, 'DELIVERY.md'), 'utf8');
const harnessPath = resolve('scripts/mvp/delivery-acceptance.mjs');
assert.equal(context.imageId, baked.imageId);
const log = await open(resolve(folder, 'worker.log'), 'a', 0o600);
const worker = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=' + workerEnvPath, '--import', '@oxc-node/core/register', 'packages/camp-runtime/src/worker.mjs'], { env: { ...process.env, CAMP_WORKER_ONCE: '1' }, detached: true, stdio: ['ignore', log.fd, log.fd] });
const ownedWorker = superviseOwnedChild(worker, { handleSignals: true });
const exited = ownedWorker.exited;
try {
  let completed; let signature; let sawRejected = false;
  const deadline = Date.now() + 1_500_000;
  while (Date.now() < deadline) {
    const state = await request('/camp/rooms/' + room.id);
    await writeFile(resolve(folder, 'latest-state.json'), JSON.stringify(state, null, 2) + '\n');
    const current = state.goals.find(value => value.id === goal.id);
    const active = state.runs.filter(run => run.goalId === goal.id && run.status === 'running');
    const progress = JSON.stringify({ event: 'delivery_progress', goalId: goal.id, status: current.status, active: active.map(run => ({ executor: run.executor, kind: run.taskKind })), verification: current.verification, reason: current.reason });
    if (progress !== signature) { console.log(progress); signature = progress; }
    const verification = state.operations?.filter(operation => operation.goalId === goal.id) ?? [];
    if (verification.some(operation => operation.receipt?.status === 'failed')) {
      sawRejected = true;
      if (current.status !== 'completed') assert.equal(state.room.acceptedRevision, 0, 'Failed checks cannot advance the Room head');
    }
    if (current.status === 'completed') { completed = { state, goal: current }; break; }
    assert.ok(!['needs_attention', 'cancelled'].includes(current.status), 'Goal stopped: ' + current.reason);
    ownedWorker.assertRunning('Worker exited early; inspect ' + folder);
    await delay(2000);
  }
  assert.ok(completed, 'Trusted delivery acceptance timed out');
  assert.equal((await Promise.race([exited, delay(30_000, null, { ref: false })]))?.code, 0);
  const runs = completed.state.runs.filter(run => run.goalId === goal.id);
  const systemRuns = runs.filter(run => run.executor === 'verification');
  assert.equal(systemRuns.length, 2, 'Exactly one failed validation and one repaired validation');
  assert.equal(sawRejected, true);
  assert.equal(completed.goal.metrics.humanAnswers, 0);
  assert.equal(completed.goal.metrics.manualRetries, 0);
  assert.equal(completed.state.room.acceptedRevision, 1);
  for (const run of systemRuns) { assert.equal(run.taskId, null); assert.equal(run.role, null); assert.equal(run.agentId, null); assert.ok(run.operationId); }
  const versions = await request('/camp/rooms/' + room.id + '/goals/' + goal.id + '/versions');
  assert.ok(versions.versions.some(value => value.kind === 'baseline' && value.candidate.refKind === 'layer'));
  const evidence = [];
  for (const version of versions.versions.filter(value => value.runId)) {
    const prefix = '/camp/rooms/' + room.id + '/goals/' + goal.id + '/versions/' + version.runId;
    const changes = await request(prefix + '/changes');
    const verification = await request(prefix + '/verification');
    assert.equal(changes.available, true);
    assert.equal(changes.changeSet.base.refKind, 'layer');
    assert.equal(changes.changeSet.target.refId, version.candidate.refId);
    evidence.push({ version, changes, verification });
  }
  const firstFailure = evidence.find(value => value.verification.receipt?.status === 'failed')?.verification.receipt;
  assert.ok(firstFailure);
  assert.equal(firstFailure.checks.find(check => check.id === 'project-tests').exitCode, 0);
  assert.equal(firstFailure.checks.find(check => check.id === 'catalog-contract').exitCode, 1);
  assert.match(firstFailure.checks.find(check => check.id === 'catalog-contract').stderr, /DELIVERY.md must document Result limits/);
  assert.ok(evidence.some(value => value.verification.receipt?.status === 'passed'));
  const manifest = await request('/camp/rooms/' + room.id + '/goals/' + goal.id + '/result');
  assert.equal(manifest.resultReady, true);
  assert.equal(manifest.verification.receipt.status, 'passed');
  assert.equal(manifest.verification.receipt.policyDigest, context.policyDigest);
  assert.equal(manifest.verification.receipt.candidate.refId, manifest.candidate.refId);
  const manifestPath = resolve(folder, 'result.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const output = resolve(folder, 'export');
  await execute(process.execPath, ['--env-file=' + workerEnvPath, 'packages/camp-runtime/scripts/export.mjs', '--manifest', manifestPath, '--output', output], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  const container = name + '-acceptance';
  let verified;
  try {
    verified = await execute('docker', ['run', '--rm', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=256m', '--mount', 'type=bind,source=' + output + ',target=/candidate,readonly', '--mount', 'type=bind,source=' + harnessPath + ',target=/camp-delivery.mjs,readonly', '--workdir', '/workspace', baked.imageId, '/bin/sh', '-c', 'cp -R --preserve=mode --no-preserve=ownership /candidate/. /workspace/ && node /camp-delivery.mjs && node --test'], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  } finally { await execute('docker', ['rm', '-f', container]).catch(() => {}); }
  assert.match(verified.stdout, /CAMP_DELIVERY_ACCEPTANCE=/);
  await writeFile(resolve(folder, 'export-tests.log'), verified.stdout + verified.stderr);
  assert.equal(await readFile(resolve(source, 'DELIVERY.md'), 'utf8'), originalNotes);
  const browser = await chromium.launch({ headless: true });
  let screenshot;
  try {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
    await browserContext.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); }, auth);
    const page = await browserContext.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
    const versionPanel = page.getByTestId('camp-versions-' + goal.id);
    await versionPanel.waitFor({ state: 'visible', timeout: 45_000 });
    await versionPanel.locator('summary').first().click();
    const select = versionPanel.getByTestId('camp-version-select');
    await select.waitFor({ state: 'visible' });
    for (const value of evidence) {
      await select.selectOption(value.version.id);
      await versionPanel.getByTestId('camp-change-entry').first().waitFor({ state: 'visible' });
      const report = versionPanel.getByTestId('camp-verification-report');
      await report.waitFor({ state: 'visible' });
      await page.waitForFunction(({ reference, status }) => [...document.querySelectorAll('[data-testid="camp-verification-report"]')].some(element => element.getAttribute('data-candidate-ref') === reference && element.getAttribute('data-status') === status), { reference: value.version.candidate.refId, status: value.verification.receipt.status });
      assert.match(await report.innerText(), /catalog-contract|Operator-owned/);
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.getByTestId('camp-room-error').count(), 0);
    screenshot = resolve(folder, 'room.png');
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally { await browser.close(); }
  const receipt = { ...context, event: 'trusted_delivery_real_passed', completedAt: new Date().toISOString(), output, screenshot, metrics: completed.goal.metrics, acceptedRevision: completed.state.room.acceptedRevision, runs: runs.map(run => ({ id: run.id, executor: run.executor, taskKind: run.taskKind, status: run.status })), versions: evidence, resultReady: manifest.resultReady, sourceNotesUnchanged: true };
  await writeFile(resolve(folder, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile('.camp/delivery-latest.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ event: receipt.event, folder, roomId: room.id, goalId: goal.id, webUrl, output, screenshot, runs: receipt.runs, metrics: receipt.metrics }));
} finally {
  try { await ownedWorker.stop(); }
  finally { await log.close(); }
}
