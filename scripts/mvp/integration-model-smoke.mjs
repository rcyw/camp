// Explicit paid-model acceptance in a new Room and private runtime home.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { superviseOwnedChild } from './owned-child.mjs';
import { checkPairExport } from './check-pair-export.mjs';

if (!process.argv.includes('--real-model')) throw new Error('Use --real-model to authorize this real DSH acceptance with configured provider credentials');
const parallel = process.argv.includes('--parallel');
const planMode = parallel ? 'parallel_pair' : 'same_baseline_pair';
const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const image = JSON.parse(await readFile(process.env.CAMP_IMAGE_RECEIPT ?? `packages/camp-runtime/.local/${parallel ? 'parallel' : 'integration'}-image.json`, 'utf8'));
const bundle = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? `packages/camp-runtime/.local/toolchain-bundle-${parallel ? '0.6.0' : '0.5.0'}`);
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const name = `camp-${parallel ? 'parallel' : 'pair'}-` + Date.now().toString(36), folder = resolve('.camp/integration-model', name), source = join(folder, 'project'), runtimeHome = join(folder, 'runtime');
const receiptPrefix = parallel ? 'parallel-model' : 'integration-model';
await mkdir(folder, { recursive: true, mode: 0o700 }); await cp('examples/camp-pair/project', source, { recursive: true });
const harnessPath = join(folder, 'verify-pair.mjs'); await cp('examples/camp-pair/verify-pair.mjs', harnessPath);
const harness = { id: 'pair-contract', sha256: createHash('sha256').update(await readFile(harnessPath)).digest('hex') };
const mappings = join(folder, 'harnesses.json'); await writeFile(mappings, JSON.stringify([{ id: harness.id, path: harnessPath }]), { mode: 0o600 });
const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), signal: AbortSignal.timeout(10000), redirect: 'error' });
assert.equal(login.status, 200); const auth = await login.json();
async function human(path, body, method) {
  const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.ok(response.ok, `Model acceptance API rejected ${path} (${response.status})`); return response.json();
}
let room, goal, child, owner, descriptor, success = false;
try {
  const channel = await human('/channels/', { name, visibility: 'public', description: 'Real DSH roles; two immutable same-baseline candidates, trusted integration, external checks and delivery.' });
  const channelId = channel.channel?.id ?? channel.id;
  room = await human('/camp/rooms', { channelId, name, project: { name, repoPath: source } });
  await human('/camp/rooms/' + room.id + '/verification-policy', { expectedDigest: null, policy: { id: 'pair-example', revision: 1, name: 'Project tests and fixed external contract', maxRepairAttempts: 1, checks: [{ id: 'project', label: 'Full project suite', argv: ['node', '--test'], timeoutMs: 60000 }, { id: 'external', label: 'Both module contracts', argv: ['node', '/camp-checks/pair-contract'], harness, timeoutMs: 30000 }] } }, 'PUT');
  const token = (await human('/camp/rooms/' + room.id + '/worker-token', {})).token;
  const workerEnvPath = join(folder, 'worker.env');
  const environment = { CAMP_API_URL: apiUrl, CAMP_WORKER_ID: name, CAMP_WORKER_TOKEN: token, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_VERIFICATION_HARNESSES: mappings, CAMP_WORKER_ONCE: '1' };
  // Node dotenv quoting, never shell interpolation or credentials in argv.
  const value = raw => { if (!/[\r\n"'`]/.test(raw)) return '"' + raw + '"'; if (!/[\r\n'`]/.test(raw)) return "'" + raw + "'"; if (!/[\r\n`]/.test(raw)) return '`' + raw + '`'; throw new Error('Acceptance configuration has unsupported quote characters'); };
  await writeFile(workerEnvPath, Object.entries(environment).map(([key, raw]) => key + '=' + value(raw)).join('\n') + '\n', { mode: 0o600 });
  const title = 'Implement the name normalizer and item count formatter as two independent candidates';
  const description = [
    'Use exactly two plan items, one for normalizer/index.js and one for formatter/index.js. Each builder may modify only its assigned index.js. Preserve all provided tests, package.json and the other subtree.',
    'normalizeName(value): require a string (otherwise TypeError); trim, collapse every whitespace sequence to one space and lowercase. Empty or whitespace-only strings become empty.',
    'formatCount(value): require a nonnegative finite integer number (otherwise RangeError); return "1 item" for one, and "N items" for every other valid count.',
    'IMPORTANT: Both items start independently from the same original baseline. Review the normalizer with node --test normalizer/index.test.js and the formatter with node --test formatter/index.test.js. The other component is intentionally unfinished in each isolated candidate; do not fix it and do not require the full suite to pass at item review. The platform merges both approved candidates and then runs the full suite plus an external immutable contract.',
    'Do not install dependencies, edit tests, update shared files, add metadata or publish anything. Submit the two-item plan, build, review, integrate, verify and finalize the complete outcome through the platform workflow.',
  ].join('\n\n');
  const snapshot = await human('/camp/rooms/' + room.id + '/tasks', { title, description, planMode, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 1800 } });
  goal = snapshot.goals.find(row => row.title === title); assert.equal(goal.protocolVersion, parallel ? 4 : 3);
  const context = { name, planMode, roomId: room.id, goalId: goal.id, channelId, webUrl: `http://localhost:15190/s/dev/channel/${channelId}?tab=camp`, folder, runtimeHome, workerEnvPath, imageId: image.imageId, toolchainDigest: image.toolchainDigest };
  await writeFile(`.camp/${receiptPrefix}-pending.json`, JSON.stringify(context, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'integration_model_started', ...context }));
  descriptor = await open(join(folder, 'worker.log'), 'a', 0o600);
  child = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=' + workerEnvPath, '--import', '@oxc-node/core/register', `packages/camp-runtime/src/${parallel ? 'worker-pool' : 'worker'}.mjs`], { stdio: ['ignore', descriptor.fd, descriptor.fd], env: { ...process.env, CAMP_WORKER_ONCE: '0' } });
  owner = superviseOwnedChild(child, { group: false, handleSignals: true });
  const until = Date.now() + 25 * 60 * 1000; let previous, observedParallelBuilds = false;
  let state;
  while (Date.now() < until) {
    state = await human('/camp/rooms/' + room.id);
    const liveBuilds = state.runs.filter(run => run.goalId === goal.id && run.taskKind === 'build' && run.status === 'running' && run.leaseValid !== false);
    if (parallel && liveBuilds.length === 2) {
      assert.equal(liveBuilds[0].agentId, liveBuilds[1].agentId, 'Both builders must retain the same logical role');
      assert.notEqual(liveBuilds[0].workerId, liveBuilds[1].workerId, 'Parallel attempts require distinct lanes');
      assert.equal(liveBuilds[0].inputCandidate.refId, liveBuilds[1].inputCandidate.refId);
      observedParallelBuilds = true;
    }
    const current = state.goals.find(row => row.id === goal.id), status = { status: current.status, runs: current.usage.runs, reviews: current.usage.reviewRounds, integration: current.integration.status, verification: current.verification.status, reason: current.reason };
    if (JSON.stringify(status) !== previous) { console.log(JSON.stringify({ event: 'integration_model_progress', ...status })); previous = JSON.stringify(status); }
    if (current.status === 'completed') break;
    assert.ok(!['needs_attention', 'cancelled', 'waiting_question'].includes(current.status), 'Real model acceptance requires attention: ' + current.reason);
    owner.assertRunning('Real DSH worker exited before delivery');
    await delay(1500);
  }
  assert.equal(state.goals.find(row => row.id === goal.id).status, 'completed', 'Real DSH acceptance deadline exceeded');
  if (parallel) assert.equal(observedParallelBuilds, true, 'The real provider run never showed two simultaneous builder leases');
  const manifest = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`); assert.equal(manifest.resultReady, true); assert.equal(manifest.integration.receipt.status, 'merged'); assert.equal(manifest.verification.receipt.status, 'passed');
  assert.equal(manifest.metrics.humanAnswers, 0); assert.equal(manifest.metrics.manualRetries, 0); assert.equal(state.runs.filter(run => run.executor === 'integration').length, 1);
  const input = manifest.integration.input;
  const builds = state.runs.filter(run => run.executor === 'agent' && run.taskKind === 'build' && run.status === 'completed' && run.planItemKey);
  assert.equal(new Set(builds.map(run => run.planItemKey)).size, 2); for (const key of new Set(builds.map(run => run.planItemKey))) assert.ok(builds.some(run => run.planItemKey === key && run.inputCandidate.refId === input.base.refId));
  // Export uses its own helpers: release the production manager before maintenance.
  await owner.stop({ graceMs: 30000 });
  const runtime = await new CampRuntime({ home: runtimeHome, imageId: image.imageId, toolchainBundle: bundle }).ready();
  const output = join(folder, 'export'); await exportCandidate({ runtime, candidate: manifest.candidate, roomId: room.id, goalId: goal.id, output });
  const exportedChecks = await checkPairExport({ runtime, imageId: image.imageId, output, harnessPath });
  await writeFile(join(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const receipt = { event: parallel ? 'bounded_pair_real_model_passed' : 'trusted_integration_real_model_passed', at: new Date().toISOString(), ...context, realDsh: true, roleOutputs: 'real_model', modelRuns: state.runs.filter(run => run.executor === 'agent').length, systemRuns: state.runs.filter(run => run.executor !== 'agent').length, ...(parallel ? { observedParallelBuilds, executionPool: state.goals.find(row => row.id === goal.id).executionPool } : {}), sameBaseline: true, bothParentsPreserved: true, integrationRuns: 1, externalVerificationPassed: true, resultReady: true, metrics: manifest.metrics, output, exportedChecks };
  await writeFile(`.camp/${receiptPrefix}-latest.json`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  success = true; console.log(JSON.stringify(receipt));
} finally {
  if (!success && room && goal) await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
  await owner?.stop({ graceMs: 30000 }); await descriptor?.close();
  if (!success && room) await human('/channels/' + room.channelId + '/archive', {}).catch(() => {});
}
