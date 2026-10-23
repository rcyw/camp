// Explicit infrastructure acceptance: real HTTP/PostgreSQL/Docker/LayerFS,
// synthetic role tool outputs, and a real keyless verification worker.
// This is not a model autonomy test and never loads provider credentials.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { createChangeSet } from '../../packages/camp-runtime/src/change-set.mjs';
import { startWorker } from '../../packages/camp-runtime/src/worker.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';

if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for this explicit local API, Docker and LayerFS acceptance (zero model calls)');
const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const delivered = JSON.parse(await readFile('.camp/delivery-latest.json', 'utf8'));
const image = JSON.parse(await readFile('packages/camp-runtime/.local/baked-image.json', 'utf8'));
const name = 'camp-review-' + Date.now().toString(36), folder = resolve('.camp/review', name);
const source = resolve(folder, 'source'), home = resolve(folder, 'runtime');
await mkdir(folder, { recursive: true, mode: 0o700 });
await cp(delivered.output, source, { recursive: true, force: false, errorOnExist: true });
await mkdir(resolve(source, 'notes'));
for (let index = 0; index < 32; index++) await writeFile(resolve(source, 'notes', index + '.txt'), Array.from({ length: 220 }, (_, line) => `before ${line} sample\n`).join(''));
const login = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.ok(login.ok); const auth = await login.json();
let token;
async function response(path, body, options = {}) {
  return fetch(api + '/api' + path, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + (options.credential ?? (path.startsWith('/camp/worker') ? token : auth.accessToken)), 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
}
async function request(path, body, options) {
  const result = await response(path, body, options);
  assert.ok(result.ok, `${path}: HTTP ${result.status} ${result.ok ? '' : await result.text()}`);
  return result.json();
}
const created = await request('/channels/', { name, visibility: 'public', description: 'Synthetic role outputs; real large Diff, keyless verification and archived completion replay; zero model calls' });
const channel = created.channel ?? created;
const room = await request('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: source } });
const policy = { id: 'review-checks', revision: 1, name: 'Real isolated project tests', maxRepairAttempts: 0, checks: [{ id: 'tests', label: 'Node project tests', argv: ['node', '--test'], timeoutMs: 60000 }] };
const configured = await request('/camp/rooms/' + room.id + '/verification-policy', { policy, expectedDigest: null }, { method: 'PUT' });
const conflict = await response('/camp/rooms/' + room.id + '/verification-policy', { policy: { ...policy, revision: 2 }, expectedDigest: null }, { method: 'PUT' });
assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'verification_policy_changed');
token = (await request('/camp/rooms/' + room.id + '/worker-token', {})).token;
const submitted = await request('/camp/rooms/' + room.id + '/tasks', { title: 'Synthetic large-diff and durable-replay boundary test', description: 'Infrastructure test: update note fixtures and run project tests. Role outputs are synthetic and explicitly do not represent model autonomy.' });
const goal = submitted.goals.find(value => value.title === 'Synthetic large-diff and durable-replay boundary test');
const runtime = await new CampRuntime({ home, imageId: image.imageId }).ready();
const project = await runtime.prepareProject({ projectId: 'room:' + room.id, sourcePath: source });
const workerId = name + '-driver', payloads = [], active = new Set();
let baseline, candidate, changeSet, completed = false;
const workerLog = [];
const tool = (run, path, body) => request(`/camp/worker/runs/${run.id}/${path}`, { workerId, runId: run.id, epoch: run.epoch, ...body }, { credential: run.runToken });
async function drive(kind, produce) {
  const { run } = await request('/camp/worker/claim', { workerId, claimId: randomUUID(), runToken: 'camp_run_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), protocol: createWorkerDeclaration() });
  assert.equal(run?.executor, 'agent'); assert.equal(run.taskKind, kind);
  let heartbeats = Promise.resolve(), heartbeatError;
  const timer = setInterval(() => { heartbeats = heartbeats.then(() => request(`/camp/worker/runs/${run.id}/heartbeat`, { workerId, epoch: run.epoch })).catch(error => { heartbeatError ??= error; }); }, 7000);
  try {
    const extra = await produce(run);
    if (heartbeatError) throw heartbeatError;
    const input = run.inputCandidate ?? baseline;
    const output = kind === 'build' ? candidate : { ...input, baseRef: input.refId };
    const body = { workerId, epoch: run.epoch, status: 'completed', summary: `Synthetic ${kind} tool output; zero model calls`, inputCandidate: input, candidate: output, artifacts: [output], ...extra };
    await request(`/camp/worker/runs/${run.id}/complete`, body);
    payloads.push({ runId: run.id, body });
    return run;
  } finally { clearInterval(timer); await heartbeats; }
}
try {
  await drive('plan', async run => {
    const mounted = await runtime.prepareRun({ project, runId: `${run.id}-e${run.epoch}`, roleId: run.role, baseRef: run.baseRef }); active.add(mounted);
    baseline = await runtime.pinInputCandidate(mounted, null);
    await runtime.releaseRun(mounted); active.delete(mounted);
    await tool(run, 'plan', { planRevision: 1, summary: 'Synthetic one-item infrastructure plan', tasks: [{ key: 'notes', title: 'Update note fixtures', description: 'Change the note fixtures', acceptance: 'All notes updated and project behavior retained', verification: 'Platform runs node --test' }] });
    return {};
  });
  await drive('build', async run => {
    const mounted = await runtime.prepareRun({ project, runId: `${run.id}-e${run.epoch}`, roleId: run.role, baseRef: run.baseRef }); active.add(mounted);
    const input = await runtime.pinInputCandidate(mounted, run.inputCandidate);
    const program = "const fs=require('node:fs');for(let i=0;i<32;i++)fs.writeFileSync('notes/'+i+'.txt',Array.from({length:220},(_,n)=>'after '+n+' sample\\n').join(''));";
    await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', mounted.workspacePath, mounted.containerId, '/usr/local/bin/node', '-e', program]);
    await runtime.quiesceAgent(mounted); candidate = await runtime.commitCandidate(mounted);
    assert.equal(candidate.baseRef, input.refId);
    await runtime.releaseRun(mounted); active.delete(mounted);
    changeSet = await createChangeSet({ runtime, ownerRun: runtime.runIdentity(`${run.id}-e${run.epoch}`), base: run.goalBaseline, target: candidate });
    assert.ok(Buffer.byteLength(JSON.stringify(changeSet)) > 100 * 1024, 'Exercise the former production 100 KiB body-parser failure');
    return { changeSet };
  });
  const review = run => tool(run, 'events', { type: 'artifact', content: 'Synthetic review only; real execution is the independent platform verifier', artifact: { type: 'review', outcome: 'approved', summary: 'Synthetic role verdict for API integration', evidence: 'The immutable candidate will be checked by the real keyless worker', candidate: { projectId: candidate.projectId, refKind: candidate.refKind, refId: candidate.refId } } });
  await drive('review', async run => { await review(run); return { outcome: 'approved' }; });
  // No provider env or plugin is provided. The Worker executes the real frozen
  // candidate and then exits normally when only model work remains.
  await startWorker({ runtime, env: { CAMP_API_URL: api, CAMP_WORKER_TOKEN: token, CAMP_WORKER_ID: name + '-verifier', CAMP_WORKER_ONCE: '1' }, log: entry => workerLog.push(entry) });
  const verified = await request('/camp/rooms/' + room.id);
  assert.equal(verified.operations[0].receipt.status, 'passed');
  assert.equal(verified.operations[0].receipt.candidate.refId, candidate.refId);
  await drive('final_review', async run => { await review(run); return { outcome: 'approved' }; });
  await drive('summary', async run => { await tool(run, 'finalize', { summary: 'Synthetic role outputs; real candidate Diff and independent test execution passed', evidence: 'Large HTTP completion, keyless verification and immutable candidate checked', remaining: ['This is an infrastructure test, not model autonomy evidence'] }); return {}; });
  const manifest = await request(`/camp/rooms/${room.id}/goals/${goal.id}/result`);
  assert.equal(manifest.resultReady, true); assert.equal(manifest.verification.policy.digest, configured.room.verificationPolicy.digest);
  const finished = await request('/camp/rooms/' + room.id);
  const versions = await request(`/camp/rooms/${room.id}/goals/${goal.id}/versions`);
  assert.equal(versions.versions.filter(version => version.runId).length, 1);
  const builder = payloads.find(item => item.body.changeSet);
  assert.ok(builder);
  const reordered = Object.fromEntries(Object.entries(builder.body).reverse());
  reordered.artifacts = builder.body.artifacts.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal((await request(`/camp/worker/runs/${builder.runId}/complete`, reordered)).replayed, true);
  const rejected = await response(`/camp/worker/runs/${builder.runId}/complete`, { ...builder.body, summary: 'Changed replay must be rejected' });
  assert.equal(rejected.status, 409);
  await request('/channels/' + channel.id + '/archive', {});
  for (const item of payloads) assert.equal((await request(`/camp/worker/runs/${item.runId}/complete`, item.body)).replayed, true);
  const after = await request(`/camp/worker/goals/${goal.id}/result`);
  assert.deepEqual(after, manifest);
  const receipt = { event: 'review_stack_passed', at: new Date().toISOString(), modelCalls: 0, roleOutputs: 'synthetic', roomId: room.id, goalId: goal.id, folder, source, runtimeHome: home, projectId: project.projectId, diffBytes: Buffer.byteLength(JSON.stringify(changeSet)), changedFiles: changeSet.entries.length, keylessWorkerCompleted: workerLog.some(entry => entry.event === 'completed' && entry.executor === 'verification'), verificationStatus: manifest.verification.receipt.status, checks: manifest.verification.receipt.checks.map(check => ({ id: check.id, exitCode: check.exitCode })), policyCasRejected: true, canonicalReplayAccepted: true, changedReplayRejected: true, archivedReplays: payloads.length, runCount: finished.goals.find(value => value.id === goal.id).usage.runs, resultReady: manifest.resultReady };
  await writeFile(resolve(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(folder, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile('.camp/review-stack-latest.json', JSON.stringify(receipt, null, 2) + '\n');
  completed = true; console.log(JSON.stringify(receipt));
} finally {
  const cleaned = await Promise.allSettled([...active].map(run => runtime.abortRun(run, 'review_stack_cleanup')));
  // One failed attempt cleanup must not skip the remaining attempts or the
  // control-side stop request. Report incomplete cleanup alongside the failure.
  const cleanupFailures = cleaned.filter(result => result.status === 'rejected');
  let cancellationStatus;
  if (!completed) {
    try { cancellationStatus = (await response(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {})).status; }
    catch { cancellationStatus = 'transport_failed'; }
  }
  if (cleanupFailures.length || (cancellationStatus !== undefined && cancellationStatus !== 200)) console.error(JSON.stringify({ event: 'review_stack_cleanup_incomplete', failedAttempts: cleanupFailures.length, cancellationStatus }));
}
