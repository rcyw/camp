// Explicit real-provider upgrade acceptance against the existing serial demo.
// Uncompatible workers must leave one goal untouched; a compatible worker then
// delivers it from the same accepted LayerFS version and exports the result.
import assert from 'node:assert/strict';
import { superviseOwnedChild } from './owned-child.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkerDeclaration, parseServerProtocol } from '../../packages/camp-protocol/src/index.js';

if (!process.argv.includes('--real')) throw new Error('Use --real for this explicit DSH/model and Docker acceptance');
const execute = promisify(execFile);
const demo = JSON.parse(await readFile('.camp/serial-latest.json', 'utf8'));
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const workerEnvPath = demo.workerEnvPath ?? '.camp/worker.env';
const env = parseEnv(await readFile(workerEnvPath, 'utf8'));
assert.equal(env.CAMP_RUNTIME_HOME, demo.runtimeHome, 'Use the proven demo runtime home and worker identity');
const api = env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const auth = await login.json();
async function request(path, body, worker = false, method) {
  const response = await fetch(api + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + (worker ? env.CAMP_WORKER_TOKEN : auth.accessToken), 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, path + ': HTTP ' + response.status);
  return response.json();
}
const snapshot = () => request('/camp/rooms/' + demo.roomId);
const before = await snapshot();
assert.equal(before.runs.filter(run => run.status === 'running').length, 0);
assert.equal(before.roomBusy, false);
if (!before.room.verificationPolicy) await request('/camp/rooms/' + demo.roomId + '/verification-policy', { policy: { id: 'protocol-node-tests', revision: 1, name: 'Node project tests', maxRepairAttempts: 1, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 60000 }] } }, false, 'PUT');
const discovery = parseServerProtocol(await request('/camp/worker/protocol', undefined, true));
const label = 'camp-protocol-' + Date.now().toString(36);
const folder = resolve('.camp/protocol', label);
await mkdir(folder, { recursive: true, mode: 0o700 });
const title = 'Record Worker protocol validation in delivery notes';
const submitted = await request('/camp/rooms/' + demo.roomId + '/tasks', { title, description: 'Submit exactly one ordered implementation item with key protocol-notes. Add a concise section headed "Worker protocol validation" to DELIVERY.md that documents running the existing dependency-free node --test suite and notes that the inherited catalog behavior is unchanged. Preserve all search, HTTP and accessible result count behavior. Run node --test. The reviewer must independently verify the delivery notes and existing tests, followed by final acceptance and a concise coordinator summary. Do not publish or alter the original source checkout.' });
const goal = submitted.goals.find(value => value.title === title && value.status === 'queued');
assert.ok(goal); assert.equal(goal.protocolVersion, 2);
assert.equal(goal.baseHeadRevision, before.room.acceptedRevision);
const declaration = createWorkerDeclaration();
const probes = [
  { name: 'undeclared', protocol: undefined, code: 'protocol_required' },
  { name: 'future-only', protocol: { ...declaration, protocolVersions: [99] }, code: 'protocol_unsupported' },
  { name: 'missing-questions', protocol: { ...declaration, capabilities: declaration.capabilities.filter(value => value !== 'questions.v1') }, code: 'capability_missing' },
  { name: 'missing-task', protocol: { ...declaration, taskKinds: ['build'] }, code: 'capability_missing' },
  { name: 'missing-ref', protocol: { ...declaration, refKinds: [] }, code: 'capability_missing' },
];
const diagnostics = [];
for (const probe of probes) {
  const workerId = label + '-' + probe.name;
  const result = await request('/camp/worker/claim', { workerId, ...(probe.protocol === undefined ? {} : { protocol: probe.protocol }) }, true);
  assert.equal(result.run, null); assert.equal(result.compatibility.code, probe.code);
  const current = await snapshot();
  const queued = current.goals.find(value => value.id === goal.id);
  assert.equal(queued.status, 'queued'); assert.equal(queued.usage.runs, 0); assert.equal(queued.startedAt, null);
  assert.equal(current.runs.filter(run => run.goalId === goal.id).length, 0);
  assert.deepEqual(current.room.acceptedHead, before.room.acceptedHead);
  assert.ok(current.workers.some(worker => worker.workerId === workerId && worker.compatibility?.code === probe.code));
  diagnostics.push({ workerId, compatibility: result.compatibility });
}
console.log(JSON.stringify({ event: 'incompatible_workers_fenced', goalId: goal.id, probes: diagnostics, runsAllocated: 0 }));

async function capture(name, workerId) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
    await context.addInitScript(({ accessToken, refreshToken }) => { localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); }, auth);
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(demo.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('camp-worker-diagnostics').waitFor({ state: 'visible', timeout: 45_000 });
    await page.getByTestId('camp-worker-report').filter({ hasText: workerId }).waitFor({ state: 'visible' });
    if (name === 'incompatible') assert.match(await page.getByTestId('camp-worker-diagnostics').innerText(), /questions\.v1/);
    assert.equal(await page.getByTestId('camp-room-error').count(), 0); assert.deepEqual(errors, []);
    const path = resolve(folder, name + '.png'); await page.screenshot({ path, fullPage: true }); return path;
  } finally { await browser.close(); }
}
const screenshots = [await capture('incompatible', label + '-missing-questions')];
const log = await open(resolve(folder, 'worker.log'), 'w', 0o600);
const worker = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=' + workerEnvPath, '--import', '@oxc-node/core/register', 'packages/camp-runtime/src/worker.mjs'], { env: { ...process.env, CAMP_WORKER_ONCE: '1' }, detached: true, stdio: ['ignore', log.fd, log.fd] });
const ownedWorker = superviseOwnedChild(worker, { handleSignals: true });
const exited = ownedWorker.exited;
let completed;
try {
  const deadline = Date.now() + 1_000_000; let signature; let runningCaptured = false;
  while (Date.now() < deadline) {
    const state = await snapshot(); const current = state.goals.find(value => value.id === goal.id);
    const active = state.runs.filter(run => run.goalId === goal.id && run.status === 'running');
    const progress = JSON.stringify({ event: 'protocol_real_progress', goalId: goal.id, status: current.status, active: active.map(run => run.taskKind), reason: current.reason });
    if (progress !== signature) { console.log(progress); signature = progress; }
    if (active.length && !runningCaptured) { screenshots.push(await capture('compatible-running', env.CAMP_WORKER_ID)); runningCaptured = true; }
    if (current.status === 'completed') { completed = { state, goal: current }; break; }
    assert.ok(!['needs_attention', 'cancelled'].includes(current.status), 'Goal stopped: ' + current.reason);
    ownedWorker.assertRunning('Worker exited before goal completion; inspect ' + folder);
    await delay(2000);
  }
  assert.ok(completed, 'Real goal timed out');
  const ended = await Promise.race([exited, delay(30_000, null, { ref: false })]); assert.equal(ended?.code, 0);
  const runs = completed.state.runs.filter(run => run.goalId === goal.id);
  assert.ok(runs.length >= 5);
  for (const run of runs) { assert.equal(run.workerProtocol.version, 2); assert.equal(run.workerProtocol.declaration.workerVersion, declaration.workerVersion); assert.equal(run.workerProtocol.requirements.protocolVersion, 2); }
  assert.equal(completed.goal.metrics.humanAnswers, 0); assert.equal(completed.goal.metrics.manualRetries, 0);
  assert.equal(completed.state.room.acceptedRevision, before.room.acceptedRevision + 1);
  const manifest = await request('/camp/rooms/' + demo.roomId + '/goals/' + goal.id + '/result');
  const manifestPath = resolve(folder, 'result.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const output = resolve(folder, 'export');
  await execute(process.execPath, ['--env-file=' + workerEnvPath, 'packages/camp-runtime/scripts/export.mjs', '--manifest', manifestPath, '--output', output], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  assert.match(await readFile(resolve(output, 'DELIVERY.md'), 'utf8'), /Worker protocol validation/i);
  const container = label + '-acceptance';
  let verified;
  try {
    verified = await execute('docker', ['run', '--rm', '--name', container, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=256m', '--mount', 'type=bind,source=' + output + ',target=/candidate,readonly', '--mount', 'type=bind,source=' + resolve('scripts/mvp/serial-acceptance.mjs') + ',target=/opt/camp-acceptance.mjs,readonly', '--workdir', '/workspace', env.CAMP_RUNTIME_IMAGE, '/bin/sh', '-c', 'cp -R --preserve=mode --no-preserve=ownership /candidate/. /workspace/ && node /opt/camp-acceptance.mjs && node --test'], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  } finally { await execute('docker', ['rm', '-f', container]).catch(() => {}); }
  await writeFile(resolve(folder, 'export-tests.log'), verified.stdout + verified.stderr);
  assert.match(verified.stdout, /CAMP_ACCEPTANCE=/);
  screenshots.push(await capture('completed', env.CAMP_WORKER_ID));
  const receipt = { event: 'protocol_real_passed', at: new Date().toISOString(), folder, roomId: demo.roomId, goalId: goal.id, webUrl: demo.webUrl, discovery, diagnostics, runsAllocatedByIncompatibleWorkers: 0, metrics: completed.goal.metrics, acceptedRevision: completed.state.room.acceptedRevision, negotiatedRuns: runs.map(run => ({ runId: run.id, version: run.workerProtocol.version, taskKind: run.taskKind })), output, screenshots };
  await writeFile(resolve(folder, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile('.camp/protocol-latest.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  try { await ownedWorker.stop(); }
  finally { await log.close(); }
}
