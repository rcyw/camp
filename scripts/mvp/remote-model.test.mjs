import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, readdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';
import { modelFixture, modelContract, modelGoal, modelHarnessMode, hash, validateModelDelivery, validateModelUsage, standardModelWorkerCommand } from './remote-model-fixture.mjs';
import { remoteModelOptions, remoteModelArguments, remoteModelBootstrap, remoteModelChannelName, remoteModelTargetArguments, validateRemoteModelDeployment } from './remote-model-smoke.mjs';

const execute = promisify(execFile);
test('paid submission requires an explicit separate command; preparing and verifying do not imply model authorization', () => {
  assert.deepEqual(remoteModelArguments(['prepare']), { action: 'prepare' });
  assert.equal(remoteModelArguments(['submit', '--real-model', '--context', '/private/context']).action, 'submit');
  assert.equal(remoteModelArguments(['verify', '--context', '/private/context']).action, 'verify');
  for (const args of [[], ['submit', '--context', '/private/context'], ['prepare', '--real-model'], ['verify', '--context', 'file', '--real-model']]) assert.throws(() => remoteModelArguments(args));
});
test('remote execution pins a reviewed release and stable HTTPS origin with no URL credentials', () => {
  const env = { CAMP_REMOTE_SSH: 'my-host', CAMP_REMOTE_ROOT: '/srv/camp/releases/commit', CAMP_REMOTE_TOOLCHAIN_BUNDLE: '/srv/camp/toolchains/digest', CAMP_REMOTE_RELEASE_SHA256: 'a'.repeat(64), CAMP_REMOTE_MODEL_API_URL: 'https://camp.example.test' };
  const options = remoteModelOptions(env, 'remote-model-one'); assert.equal(options.workerApiUrl, 'https://camp.example.test'); assert.equal(options.serviceName, 'remote-model-one.service');
  for (const workerApi of ['http://127.0.0.1:41318', 'https://127.0.0.1', 'https://user:secret@example.test', 'https://example.test/api', 'https://example.test?token=secret']) assert.throws(() => remoteModelOptions({ ...env, CAMP_REMOTE_MODEL_API_URL: workerApi }, 'one'));
  assert.throws(() => remoteModelOptions({ ...env, CAMP_REMOTE_RELEASE_SHA256: undefined }, 'one'));
  assert.throws(() => remoteModelOptions({ ...env, CAMP_REMOTE_MODEL_SERVICE: 'name;touch-file.service' }, 'one'));
});
test('service provenance rejects inline evaluators, injected loaders and once-mode even if argv contains the real entry path', () => {
  const release = '/srv/camp/releases/reviewed', entry = release + '/packages/camp-runtime/scripts/worker-pool.mjs';
  assert.equal(standardModelWorkerCommand(['node', '--env-file=/private/model.env', '--env-file=/private/worker.env', entry], release), true);
  for (const flag of ['-e', '-eprocess.exit()', '-p', '-pJSON.stringify({})', '--print', '--print=process.exit()', '--eval=process.exit()', '--require=/private/injected.cjs', '--import=/private/injected.mjs', '--loader=/private/loader.mjs', '--once', '--test', '--inspect', '--env-file-if-exists=/private/missing.env', '--env-file=/private/../other.env', '--env-file=relative', '--env-file=/private/model env', '--env-file=/private/$HOME']) assert.equal(standardModelWorkerCommand(['node', flag, entry], release), false, flag);
  for (const node of ['/bin/sh', '/usr/bin/../bin/node', '-p', '/private/other']) assert.equal(standardModelWorkerCommand([node, entry], release), false);
  assert.equal(standardModelWorkerCommand(['/usr/bin/node', '--env-file=/private/model.env', '--env-file=/private/worker.env', entry], release), true);
  assert.equal(standardModelWorkerCommand(['/usr/bin/node', '--env-file=/private/model.env', '--env-file=/private/model.env', entry], release), false);
  assert.equal(standardModelWorkerCommand(['node', entry, '--once'], release), false);
});
test('a stale local context cannot attest another live release or service before paid submission or verification', () => {
  const context = { releaseDigest: 'a'.repeat(64), serviceName: 'camp-worker-my.service' };
  const evidence = { releaseDigest: context.releaseDigest, service: { name: context.serviceName, active: true, standardWorkerCommand: true } };
  validateRemoteModelDeployment(context, evidence);
  assert.throws(() => validateRemoteModelDeployment(context, { ...evidence, releaseDigest: 'b'.repeat(64) }));
  assert.throws(() => validateRemoteModelDeployment(context, { ...evidence, service: { ...evidence.service, name: 'camp-worker-other.service' } }));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'camp-remote-model-test-')), folder = join(root, 'project'), fixture = modelFixture('test-remote-model');
  await mkdir(folder); for (const directory of ['foundation', 'left', 'right']) await mkdir(join(folder, directory));
  const files = { ...fixture.files,
    'foundation/index.js': 'export function normalizeName(value){if(typeof value!=="string")throw new TypeError("string required");return value.trim().replace(/\\s+/g," ").toLowerCase();}\n',
    'left/index.js': 'import{normalizeName}from"../foundation/index.js";export function greetName(v){return "Hello, "+(normalizeName(v)||"stranger")+"!";}\n',
    'right/index.js': 'import{normalizeName}from"../foundation/index.js";export function slugName(v){return normalizeName(v).replaceAll(" ","-");}\n',
  };
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(folder, path), bytes);
  const contract = join(root, 'contract.mjs'); await writeFile(contract, modelContract(fixture, folder));
  return { root, folder, contract, fixture, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
test('fixed acceptance passes the correct three-node implementation and all six provided tests', async () => {
  const p = await project(); try {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const suite = await execute(process.execPath, ['--test'], { cwd: p.folder, env: childEnv }); assert.match(suite.stdout, /(?:#|ℹ) pass 6\b/);
    const checked = await execute(process.execPath, [p.contract]); assert.match(checked.stdout, /CAMP_REMOTE_MODEL_CONTRACT_PASSED/);
    assert.deepEqual(modelGoal().budget, { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 1800 });
  } finally { await p.cleanup(); }
});
test('protected tests and metadata cannot be changed even when project tests still pass', async () => {
  for (const path of ['package.json', 'foundation/index.test.js']) {
    const p = await project(); try {
      if (path === 'package.json') await writeFile(join(p.folder, path), JSON.stringify({ name: 'tampered', type: 'module' }));
      else await writeFile(join(p.folder, path), p.fixture.files[path] + '// weaken the protected input\n');
      await assert.rejects(execute(process.execPath, [p.contract]));
    } finally { await p.cleanup(); }
  }
});
test('external contract refuses added files, links and incorrect behavior', async () => {
  for (const kind of ['extra', 'link', 'behavior']) {
    const p = await project(); try {
      if (kind === 'extra') await writeFile(join(p.folder, 'added.txt'), 'unexpected');
      else if (kind === 'link') await symlink('foundation/index.js', join(p.folder, 'added-link'));
      else await writeFile(join(p.folder, 'right/index.js'), 'export function slugName(){return "wrong";}');
      await assert.rejects(execute(process.execPath, [p.contract]));
    } finally { await p.cleanup(); }
  }
});

test('candidate success-marker exits, empty exits and trailing output cannot forge a trusted outer verdict', async () => {
  const correct = 'export function normalizeName(value){if(typeof value!=="string")throw new TypeError("string required");return value.trim().replace(/\\s+/g," ").toLowerCase();}\n';
  for (const candidate of [
    'process.stdout.write("CAMP_REMOTE_MODEL_CONTRACT_PASSED\\n");process.exit(0);' + correct,
    'process.exit(0);' + correct,
    'process.on("exit",()=>process.stdout.write("CAMP_REMOTE_MODEL_CONTRACT_PASSED\\n"));' + correct,
  ]) {
    const p = await project(); try {
      await writeFile(join(p.folder, 'foundation/index.js'), candidate);
      await assert.rejects(execute(process.execPath, [p.contract], { timeout: 10000 }), error => error.code === 1 && !error.stdout.includes('CAMP_REMOTE_MODEL_CONTRACT_PASSED'));
    } finally { await p.cleanup(); }
  }
});

test('patching candidate-process assertions cannot bless incorrect observed function values', async () => {
  const p = await project(); try {
    await writeFile(join(p.folder, 'foundation/index.js'), 'import assert from"node:assert/strict";for(const name of["equal","deepEqual","throws","ok"])assert[name]=()=>{};export function normalizeName(){return"forged";}\n');
    await assert.rejects(execute(process.execPath, [p.contract], { timeout: 10000 }), error => error.code === 1 && !error.stdout.includes('CAMP_REMOTE_MODEL_CONTRACT_PASSED'));
  } finally { await p.cleanup(); }
});

test('the trusted parent rechecks protected bytes and complete inventory after candidate execution', async () => {
  const correct = 'export function normalizeName(value){if(typeof value!=="string")throw new TypeError("string required");return value.trim().replace(/\\s+/g," ").toLowerCase();}\n';
  for (const name of ['index.test.js', 'unexpected.txt']) {
    const p = await project(); try {
      await writeFile(join(p.folder, 'foundation/index.js'), 'import{writeFileSync}from"node:fs";writeFileSync(new URL(' + JSON.stringify(name) + ',import.meta.url),"changed during behavior checks");' + correct);
      await assert.rejects(execute(process.execPath, [p.contract], { timeout: 10000 }), error => error.code === 1 && !error.stdout.includes('CAMP_REMOTE_MODEL_CONTRACT_PASSED'));
    } finally { await p.cleanup(); }
  }
});

test('missing completion and excessive candidate output have hard bounds before the outer process can accept', async () => {
  for (const candidate of ['export function normalizeName(){while(true){}}', 'process.stdout.write("x".repeat(100000));export function normalizeName(){return"wrong";}']) {
    const p = await project(); try {
      await writeFile(join(p.folder, 'foundation/index.js'), candidate);
      const started = Date.now();
      await assert.rejects(execute(process.execPath, [p.contract], { timeout: 10000 }), error => error.code === 1 && !error.killed && !error.stdout.includes('CAMP_REMOTE_MODEL_CONTRACT_PASSED'));
      assert.ok(Date.now() - started < 10000);
    } finally { await p.cleanup(); }
  }
});
function delivery() {
  const projectId = 'p-' + 'a'.repeat(16), imageId = 'sha256:' + 'b'.repeat(64), candidate = n => ({ type: 'layerfs', projectId, imageId, refKind: 'commit', refId: '12' + String(n).padStart(64, '0'), commitId: '12' + String(n).padStart(64, '0'), rootId: String(n).padStart(64, '0') });
  const base = candidate(1), foundation = candidate(2), left = candidate(3), right = candidate(4), merged = candidate(5), goalId = randomUUID();
  const run = (taskKind, role, inputCandidate, output, planItemKey = null) => ({ id: randomUUID(), executor: 'agent', goalId, goalAttempt: 1, epoch: 1, taskKind, role, inputCandidate, candidate: output, planItemKey, status: 'completed', sessionId: randomUUID(), cleanupState: 'confirmed', outcome: taskKind.includes('review') ? 'approved' : undefined });
  const plan = run('plan', 'planner', base, base), bf = run('build', 'builder', base, foundation, 'foundation'), rf = run('review', 'reviewer', foundation, foundation, 'foundation'), bl = run('build', 'builder', foundation, left, 'left'), rl = run('review', 'reviewer', left, left, 'left'), br = run('build', 'builder', foundation, right, 'right'), rr = run('review', 'reviewer', right, right, 'right'), fr = run('final_review', 'reviewer', merged, merged), summary = run('summary', 'planner', merged, merged);
  const runs = [plan, bf, rf, bl, rl, br, rr, fr, summary];
  const input = { schemaVersion: 1, algorithm: 'layerfs-three-way-v2', policy: 'reject-overlap-v1', base: foundation, parents: [{ key: 'left', runId: bl.id, epoch: 1, candidate: left }, { key: 'right', runId: br.id, epoch: 1, candidate: right }] }, operationId = randomUUID(), nativeRunId = randomUUID(), inputDigest = hash(serializeIntegrationInput(input));
  const report = { status: 'merged', candidate: merged, inputDigest, operationId, runId: nativeRunId };
  const item = (key, output, review, sources) => ({ key, status: 'approved', candidate: output, reviews: [{ outcome: 'approved', candidate: output, runId: review.id }], ...(sources ? { inputResolution: 'single_parent', inputCandidate: foundation, inputSources: [{ key: 'foundation', runId: bf.id, epoch: 1, candidate: foundation }] } : {}) });
  const goal = { id: goalId, status: 'completed', attempt: 1, protocolVersion: 5, planMode: 'bounded_dag', plan: { revision: 2, tasks: ['foundation', 'left', 'right'].map(key => ({ key, dependsOnKeys: key === 'foundation' ? [] : ['foundation'] })) }, metrics: { humanAnswers: 0, manualRetries: 0 }, finalCandidate: merged, verificationPolicy: { digest: 'c'.repeat(64) }, items: [item('foundation', foundation, rf), item('left', left, rl, true), item('right', right, rr, true)], integration: { operations: [{ id: operationId, scope: 'goal', status: 'completed', integrationInput: input, inputDigest, latestRunId: nativeRunId, integrationReport: report }] }, graph: { sinkKeys: ['left', 'right'], delivery: { status: 'ready', candidate: merged } } };
  const state = { goals: [goal], runs, room: { acceptedHead: { goalId, candidate: merged } } }, manifest = { goalId, resultReady: true, candidate: merged, verification: { receipt: { status: 'passed', candidate: merged, policyDigest: goal.verificationPolicy.digest, checks: [{ id: 'external', exitCode: 0, stdout: 'CAMP_REMOTE_MODEL_CONTRACT_PASSED' }] } } };
  const progressEvents = [plan, bf, rf].map(row => ({ id: randomUUID(), type: 'progress', runId: row.id }));
  const evidence = { service: { active: true, standardWorkerCommand: true }, runs: runs.map(row => ({ runId: row.id, epoch: 1, role: row.role, executor: 'agent', phase: 'settled', cleanupKnown: true, modelUsage: { requests: 2, inputBytes: 100, responseBytes: 200 } })) };
  return { state, manifest, goalId, progressEvents, evidence };
}
test('delivery and journal evidence distinguish model requests from model Run count', () => {
  const v = delivery(); const result = validateModelDelivery(v); assert.equal(result.agentRuns, 9); assert.equal(result.approvedDependencyShared, true);
  const usage = validateModelUsage(v.state.runs, v.evidence); assert.equal(usage.agentRuns, 9); assert.equal(usage.proxyRequestAttempts, 18); assert.equal(usage.providerTokens, null);
});
test('a resolved automatic role question may retain its suspended real model session without faking an all-completed ledger', () => {
  const v = delivery(), questionId = randomUUID();
  const suspended = { ...v.state.runs[1], id: randomUUID(), status: 'suspended', questionId };
  v.state.runs.push(suspended); v.state.goals[0].questions = [{ id: questionId, status: 'answered', resumedAt: new Date().toISOString() }];
  assert.equal(validateModelDelivery(v).agentRuns, 10);
  v.state.goals[0].questions[0].status = 'pending'; assert.throws(() => validateModelDelivery(v));
});
test('final repair must retain a single explicit chain from the trusted joined candidate', () => {
  const v = delivery(), joined = v.manifest.candidate, repaired = { ...joined, refId: '12' + '6'.repeat(64), commitId: '12' + '6'.repeat(64), rootId: '6'.repeat(64) };
  const run = { ...v.state.runs[1], id: randomUUID(), planItemKey: null, inputCandidate: joined, candidate: repaired };
  for (const model of v.state.runs.filter(value => ['final_review', 'summary'].includes(value.taskKind))) { model.inputCandidate = repaired; model.candidate = repaired; }
  v.manifest.candidate = repaired; v.manifest.verification.receipt.candidate = repaired; v.state.goals[0].finalCandidate = repaired; v.state.room.acceptedHead.candidate = repaired;
  assert.throws(() => validateModelDelivery(v));
  v.state.runs.push(run); assert.equal(validateModelDelivery(v).wholeGoalRepairRuns, 1);
});
test('acceptance rejects missing real sessions/progress, stale approval and wrong dependency input', () => {
  for (const kind of ['session', 'progress', 'review', 'parent', 'candidate', 'readonly', 'digest', 'human']) {
    const v = delivery();
    if (kind === 'session') v.state.runs[0].sessionId = null;
    if (kind === 'progress') v.progressEvents = [];
    if (kind === 'review') v.state.goals[0].items[1].reviews = [];
    if (kind === 'parent') v.state.runs.find(run => run.taskKind === 'build' && run.planItemKey === 'left').inputCandidate = v.state.runs[0].inputCandidate;
    if (kind === 'candidate') v.manifest.verification.receipt.candidate = v.state.runs[0].inputCandidate;
    if (kind === 'readonly') v.state.runs[0].candidate = v.state.runs[1].candidate;
    if (kind === 'digest') v.state.goals[0].integration.operations[0].inputDigest = 'f'.repeat(64);
    if (kind === 'human') v.state.goals[0].metrics.humanAnswers = 1;
    assert.throws(() => validateModelDelivery(v), 'Must reject ' + kind);
  }
});
test('journal counters require the exact settled run/epoch, live standard service and positive actual proxy counters', () => {
  for (const kind of ['zero', 'missing', 'duplicate', 'epoch', 'phase', 'cleanup', 'service']) {
    const v = delivery();
    if (kind === 'zero') v.evidence.runs[0].modelUsage.requests = 0;
    if (kind === 'missing') v.evidence.runs.pop();
    if (kind === 'duplicate') v.evidence.runs.push(v.evidence.runs[0]);
    if (kind === 'epoch') v.evidence.runs[0].epoch = 2;
    if (kind === 'phase') v.evidence.runs[0].phase = 'completion_pending';
    if (kind === 'cleanup') v.evidence.runs[0].cleanupKnown = false;
    if (kind === 'service') v.evidence.service.standardWorkerCommand = false;
    assert.throws(() => validateModelUsage(v.state.runs, v.evidence), 'Must reject ' + kind);
  }
});
test('remote preparation leaves the pristine release untouched and writes only a private Room credential, never a model key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-model-bootstrap-'));
  try {
    const release = join(root, 'release'), operation = join(root, 'operations', 'one'); await mkdir(join(release, 'packages'), { recursive: true });
    const roomId = randomUUID(), credential = { schemaVersion: 1, token: 'camp_worker_' + 'a'.repeat(43), tokenId: randomUUID(), roomId, expiresAt: '2026-11-01T00:00:00.000Z', renewUntil: '2026-12-01T00:00:00.000Z' };
    const payload = { config: { roomId }, credential, files: { 'remote-model-target.mjs': Buffer.from('// probe').toString('base64'), 'remote-model-fixture.mjs': Buffer.from('// data').toString('base64') }, workerEnv: { CAMP_API_URL: 'https://camp.example.test', CAMP_WORKER_ID: 'worker-one', CAMP_WORKER_ROOM_ID: roomId, CAMP_WORKER_CREDENTIAL_FILE: operation + '/credential.json', CAMP_RUNTIME_HOME: operation + '/runtime', CAMP_RUNTIME_IMAGE: 'sha256:' + 'b'.repeat(64), CAMP_TOOLCHAIN_BUNDLE: '/srv/toolchain', CAMP_VERIFICATION_HARNESSES: operation + '/harnesses.json' } };
    const result = await bootstrap(release, operation, payload); assert.equal(result.code, 0); assert.ok(!result.output.includes(credential.token));
    assert.deepEqual(await readdir(release), ['packages']); assert.equal((await stat(join(operation, 'worker.env'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(operation, 'credential.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(operation, 'credential.json'), 'utf8')), credential);
    const workerFile = await readFile(join(operation, 'worker.env'), 'utf8'); assert.ok(workerFile.includes('CAMP_WORKER_CREDENTIAL_FILE=')); assert.ok(!workerFile.includes('CAMP_WORKER_TOKEN=') && !workerFile.includes(credential.token)); assert.ok(!workerFile.includes('DEEPSEEK'));
    payload.workerEnv.DEEPSEEK_API_KEY = 'must-not-write'; const other = join(root, 'operations', 'two'); payload.workerEnv.CAMP_WORKER_CREDENTIAL_FILE = other + '/credential.json'; assert.notEqual((await bootstrap(release, other, payload)).code, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('fresh probe names satisfy the ordinary channel limit without shortening operation UUIDs', () => {
  const id = 'remote-model-' + randomUUID(), name = remoteModelChannelName(id);
  assert.match(name, /^model-[a-f0-9]{24}$/); assert.ok(name.length <= 32);
  assert.equal(remoteModelChannelName(id), name); assert.notEqual(remoteModelChannelName('remote-model-' + randomUUID()), name);
  assert.throws(() => remoteModelChannelName('not-a-fresh-operation'));
});
test('read-only service probes use system CA trust and a hard remote deadline without loading a model environment', () => {
  const operation = '/srv/camp/operations/model-one';
  const args = remoteModelTargetArguments(operation, 'service');
  assert.deepEqual(args, ['timeout', '--signal=TERM', '--kill-after=15s', '120s', 'node', '--use-system-ca', operation + '/probe/scripts/mvp/remote-model-target.mjs', 'service', operation]);
  assert.ok(!args.some(value => value.includes('--env-file') || value.includes('model.env')));
  assert.throws(() => remoteModelTargetArguments('/srv/../unsafe', 'service'));
  assert.throws(() => remoteModelTargetArguments(operation, 'start'));
});
test('the immutable host contract remains readable by the actual unprivileged verifier identity', { skip: process.getuid?.() !== 0 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'camp-model-contract-permission-')); t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const file = join(root, 'contract.mjs'), bytes = 'console.log("protected acceptance");\n';
  await writeFile(file, bytes, { mode: 0o400 });
  await assert.rejects(execute('/usr/bin/cat', [file], { uid: 501, gid: 20 }));
  await chmod(file, modelHarnessMode);
  assert.equal((await execute('/usr/bin/cat', [file], { uid: 501, gid: 20 })).stdout, bytes);
  assert.equal((await stat(file)).mode & 0o222, 0); assert.equal(hash(await readFile(file)), hash(bytes));
});
test('fixture contract publication explicitly restores read permissions under a private operator umask', async t => {
  const root = await mkdtemp(join(tmpdir(), 'camp-model-contract-umask-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'contract.mjs'), moduleUrl = new URL('remote-model-target.mjs', import.meta.url).href;
  const script = 'process.umask(0o077);const {writeModelContract}=await import(process.argv[1]);await writeModelContract(process.argv[2],"protected acceptance\\n");';
  await execute(process.execPath, ['--input-type=module', '-e', script, moduleUrl, file]);
  assert.equal((await stat(file)).mode & 0o777, modelHarnessMode);
  assert.equal(await readFile(file, 'utf8'), 'protected acceptance\n');
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', script, moduleUrl, file]));
});
function bootstrap(release, operation, payload) {
  return new Promise(resolveResult => { const child = spawn(process.execPath, ['--input-type=module', '-e', remoteModelBootstrap, release, operation], { stdio: ['pipe', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume(); child.once('close', code => resolveResult({ code, output })); child.stdin.end(JSON.stringify(payload)); });
}
