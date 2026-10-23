// Real API/PostgreSQL/Docker/LayerFS acceptance. Role outputs are synthetic;
// the independent verifier and offline recovery are real. No provider config.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { WorkerJournal, acquireWorkerLock } from '../../packages/camp-runtime/src/durable-state.mjs';
import { inspectWorker, workerApiRequest } from '../../packages/camp-runtime/src/worker-preflight.mjs';
import { reapWorker } from '../../packages/camp-runtime/src/worker-ops.mjs';
import { recoverWorker } from '../../packages/camp-runtime/src/worker-recovery.mjs';
import { createChangeSet } from '../../packages/camp-runtime/src/change-set.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';
import { startWorker } from '../../packages/camp-runtime/src/worker.mjs';

const childMode = process.argv[2] === '--child';
if (childMode) {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = await new CampRuntime(input.runtimeOptions).ready();
  const journal = await new WorkerJournal({ home: runtime.home, apiUrl: input.apiUrl, workerId: input.workerId }).ready();
  const lock = await acquireWorkerLock(input.workerId);
  process.once('SIGTERM', () => { void lock.release().finally(() => process.exit(143)); });
  const request = workerApiRequest({ CAMP_API_URL: input.apiUrl, CAMP_WORKER_TOKEN: process.env.CAMP_WORKER_TOKEN });
  const controller = new AbortController();
  setInterval(() => { void request(`/runs/${input.run.id}/heartbeat`, { workerId: input.workerId, epoch: input.run.epoch }).then(value => { if (value.cancelRequested) controller.abort(); }).catch(() => controller.abort()); }, 7000);
  const record = await journal.recordClaim(input.run, { runtime: runtime.runIdentity(`${input.run.id}-e${input.run.epoch}`) });
  const project = await runtime.loadProject(input.projectId);
  const mounted = await runtime.prepareRun({ project, runId: record.runtime.runId, roleId: 'planner', baseRef: input.run.baseRef, owner: { workerId: input.workerId, apiUrl: input.apiUrl, runId: input.run.id, epoch: input.run.epoch }, signal: controller.signal });
  await journal.update(record, { phase: 'executing', runtime: { ...record.runtime, containerId: mounted.containerId } });
  const baseline = await runtime.pinInputCandidate(mounted, null, { signal: controller.signal });
  const planned = await fetch(input.apiUrl + `/api/camp/worker/runs/${input.run.id}/plan`, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.CAMP_PROBE_RUN_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ workerId: input.workerId, epoch: input.run.epoch, planRevision: 1, summary: 'Synthetic deployment acceptance', tasks: [{ key: 'note', title: 'Add delivery note', description: 'Add DELIVERY.md and preserve the counter behavior', acceptance: 'A delivery note and the original counter behavior exist', verification: 'Independent platform Node tests' }] }), signal: AbortSignal.timeout(10000) });
  assert.equal(planned.status, 200);
  const output = { ...baseline, baseRef: baseline.refId };
  const payload = { workerId: input.workerId, epoch: input.run.epoch, status: 'completed', summary: 'Synthetic planner; staged before the intentional SIGKILL', inputCandidate: baseline, candidate: output, artifacts: [output] };
  await journal.stageCompletion(record, payload);
  controller.signal.throwIfAborted();
  console.log(JSON.stringify({ event: 'outbox_staged_with_live_sandbox', containerId: mounted.containerId, digest: record.completion.digest, baseline }));
  // The parent intentionally SIGKILLs this process. No graceful cleanup here.
} else {
  if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for this explicit zero-model local infrastructure acceptance');
  const actualApi = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
  const image = JSON.parse(await readFile('packages/camp-runtime/.local/standard-image.json', 'utf8'));
  const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
  const name = 'camp-deployment-' + Date.now().toString(36), folder = resolve('.camp/deployment', name), source = resolve(folder, 'project');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await cp('examples/camp-counter/project', source, { recursive: true, force: false, errorOnExist: true });
  const runtimeOptions = { home: resolve(folder, 'runtime'), imageId: image.imageId, toolchainBundle: resolve('packages/camp-runtime/.local/toolchain-bundle') };
  const runtime = await new CampRuntime(runtimeOptions).ready();
  const login = await fetch(actualApi + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) }); assert.equal(login.status, 200); const auth = await login.json();
  let workerToken, online = true, proxyCalls = 0;
  const proxy = createServer(async (req, res) => {
    proxyCalls++;
    if (!online) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1048576) throw new Error('Probe request bound'); chunks.push(chunk); }
      const answer = await fetch(actualApi + req.url, { method: req.method, headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' }); res.end(Buffer.from(await answer.arrayBuffer()));
    } catch { res.writeHead(502); res.end('{}'); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const apiUrl = 'http://127.0.0.1:' + proxy.address().port;
  async function human(path, body, method) {
    const result = await fetch(actualApi + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    assert.ok(result.ok, `${path}: ${result.status} ${result.ok ? '' : await result.text()}`); return result.json();
  }
  let room, goal, project, child, foreign, completed = false, candidate;
  const workerId = name + '-planner', active = new Set();
  const request = (path, body) => workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken })(path, body);
  try {
    const channel = await human('/channels/', { name, visibility: 'public', description: 'Synthetic role outputs; real preflight, offline SIGKILL recovery, verification and export. Zero model calls.' });
    const channelId = channel.channel?.id ?? channel.id;
    room = await human('/camp/rooms', { channelId, name, project: { name, repoPath: source + '-missing' } });
    workerToken = (await human('/camp/rooms/' + room.id + '/worker-token', {})).token;
    const environment = { CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken, CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1' };
    const missing = await inspectWorker({ runtime, env: environment, report: true });
    assert.equal(missing.ready, false); assert.equal(missing.report.checks.find(item => item.id === 'source').status, 'failed');
    let state = await human('/camp/rooms/' + room.id); assert.equal(state.runs.length, 0); assert.equal(state.goals.length, 0);
    const oldDigest = state.setup.projectDigest;
    await human('/camp/rooms/' + room.id + '/project', { project: { name, repoPath: source }, expectedDigest: oldDigest }, 'PUT');
    await assert.rejects(request('/preflight', { workerId, projectDigest: oldDigest, report: missing.report }), error => error.status === 409);
    const ready = await inspectWorker({ runtime, env: environment, report: true }); assert.equal(ready.ready, true); assert.equal(ready.report.mode, 'verification');
    const noModel = await inspectWorker({ runtime, env: environment, requireAgent: true }); assert.equal(noModel.ready, false); assert.equal(noModel.report.checks.find(item => item.id === 'model').code, 'model_not_configured');
    const capacity = await inspectWorker({ runtime, env: { ...environment, CAMP_MIN_FREE_MIB: '16777216' }, report: true }); assert.equal(capacity.ready, false); assert.equal(capacity.report.checks.find(item => item.id === 'capacity').code, 'capacity_low');
    await inspectWorker({ runtime, env: environment, report: true });
    await human('/camp/rooms/' + room.id + '/verification-policy', { expectedDigest: null, policy: { id: 'counter', revision: 1, name: 'Counter tests', maxRepairAttempts: 0, checks: [{ id: 'tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 60000 }] } }, 'PUT');
    const title = 'Add a delivery note and retain counter behavior (synthetic deployment test)';
    state = await human('/camp/rooms/' + room.id + '/tasks', { title }); goal = state.goals.find(value => value.title === title);
    assert.equal(state.setup.projectMutable, false);
    project = await runtime.prepareProject({ projectId: 'room:' + room.id, sourcePath: source });
    foreign = await runtime.prepareRun({ project, runId: 'foreign-' + randomUUID(), roleId: 'reviewer' });
    const claimed = await request('/claim', { workerId, protocol: createWorkerDeclaration() }); assert.equal(claimed.run.taskKind, 'plan');
    const { runToken, ...safeRun } = claimed.run;
    const inputPath = resolve(folder, 'child-input.json');
    await writeFile(inputPath, JSON.stringify({ runtimeOptions, apiUrl, workerId, projectId: project.projectId, run: safeRun }), { mode: 0o600 });
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', inputPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_WORKER_TOKEN: workerToken, CAMP_PROBE_RUN_TOKEN: runToken } });
    const staged = await new Promise((resolveReady, reject) => {
      let pending = ''; const timer = setTimeout(() => reject(new Error('Probe child did not stage within 40 seconds')), 40000);
      child.stderr.resume();
      child.stdout.on('data', bytes => { pending += bytes; const at = pending.indexOf('\n'); if (at >= 0) { clearTimeout(timer); try { resolveReady(JSON.parse(pending.slice(0, at))); } catch (error) { reject(error); } } });
      child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Probe child exited before staging: ${code ?? signal}`)); });
    });
    assert.equal(staged.event, 'outbox_staged_with_live_sandbox');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null;
    assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', staged.containerId])).stdout.trim(), 'true');
    online = false; const callsBeforeOffline = proxyCalls;
    const dry = await reapWorker({ runtime, apiUrl, workerId }); assert.equal(dry.attempts[0].containers.length, 1); assert.equal(dry.attempts[0].cleaned, false);
    const reaped = await reapWorker({ runtime, apiUrl, workerId, apply: true }); assert.equal(reaped.attempts[0].cleaned, true);
    const offlineApiCalls = proxyCalls - callsBeforeOffline; assert.equal(offlineApiCalls, 0);
    assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', foreign.containerId])).stdout.trim(), 'true');
    const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
    const [offline] = await journal.list(); assert.equal(offline.completion.digest, staged.digest); assert.equal(offline.cleanupAck, undefined);
    online = true;
    await recoverWorker({ journal, runtime, request });
    const [settled] = await journal.list(); assert.equal(settled.phase, 'settled'); assert.equal(settled.completion.digest, staged.digest); assert.equal(createHash('sha256').update(JSON.stringify(settled.completion.payload)).digest('hex'), staged.digest);
    await runtime.releaseRun(foreign, { discard: true }); foreign = null;
    const driver = name + '-driver';
    async function drive(kind, produce) {
      const { run } = await request('/claim', { workerId: driver, protocol: createWorkerDeclaration() }); assert.equal(run.taskKind, kind);
      const controller = new AbortController(); let heartbeats = Promise.resolve();
      const timer = setInterval(() => {
        heartbeats = heartbeats.then(async () => { const reply = await request(`/runs/${run.id}/heartbeat`, { workerId: driver, epoch: run.epoch }); if (reply.cancelRequested) throw new Error('Probe run cancelled'); }).catch(error => controller.abort(error));
      }, 7000);
      try {
        const extra = await produce(run, controller.signal);
        controller.signal.throwIfAborted();
        const output = kind === 'build' ? candidate : { ...run.inputCandidate, baseRef: run.inputCandidate.refId };
        await request(`/runs/${run.id}/complete`, { workerId: driver, epoch: run.epoch, status: 'completed', summary: `Synthetic ${kind}; no model calls`, inputCandidate: run.inputCandidate, candidate: output, artifacts: [output], ...extra });
      } finally { clearInterval(timer); await heartbeats; }
    }
    const tool = (run, path, body) => fetch(apiUrl + `/api/camp/worker/runs/${run.id}/${path}`, { method: 'POST', headers: { authorization: 'Bearer ' + run.runToken, 'content-type': 'application/json' }, body: JSON.stringify({ workerId: driver, epoch: run.epoch, ...body }), signal: AbortSignal.timeout(10000) }).then(async result => { assert.ok(result.ok, `${path}: ${result.status}`); return result.json(); });
    await drive('build', async (run, signal) => {
      const mounted = await runtime.prepareRun({ project, runId: `${run.id}-e${run.epoch}`, roleId: 'builder', baseRef: run.baseRef, signal }); active.add(mounted);
      await runtime.pinInputCandidate(mounted, run.inputCandidate, { signal });
      await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', mounted.workspacePath, mounted.containerId, '/usr/local/bin/node', '-e', "require('node:fs').writeFileSync('DELIVERY.md','Deployment and recovery acceptance\\n')"], { signal });
      await runtime.quiesceAgent(mounted, { signal }); candidate = await runtime.commitCandidate(mounted, { signal }); await runtime.releaseRun(mounted); active.delete(mounted);
      return { changeSet: await createChangeSet({ runtime, ownerRun: runtime.runIdentity(`${run.id}-e${run.epoch}`), base: run.goalBaseline, target: candidate, signal }) };
    });
    const review = async run => { await tool(run, 'events', { type: 'artifact', content: 'Synthetic review; independent platform test is real', artifact: { type: 'review', outcome: 'approved', summary: 'Synthetic role verdict', evidence: 'Frozen candidate will be verified independently', candidate: { projectId: candidate.projectId, refKind: candidate.refKind, refId: candidate.refId } } }); return { outcome: 'approved' }; };
    await drive('review', review);
    const logs = [];
    await startWorker({ runtime, env: { ...environment, CAMP_WORKER_ID: name + '-verifier' }, log: value => logs.push(value) });
    assert.ok(logs.some(value => value.event === 'completed' && value.executor === 'verification'));
    await drive('final_review', review);
    await drive('summary', async run => { await tool(run, 'finalize', { summary: 'Synthetic roles; real offline recovery, candidate and independent checks passed', evidence: 'Original outbox recovered unchanged after SIGKILL and API outage', remaining: ['This acceptance uses synthetic roles, not autonomous model execution'] }); return {}; });
    const manifest = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`); assert.equal(manifest.resultReady, true); assert.equal(manifest.verification.receipt.status, 'passed');
    const restarted = await new CampRuntime(runtimeOptions).ready();
    const exported = await exportCandidate({ runtime: restarted, candidate: manifest.candidate, roomId: room.id, goalId: goal.id, output: resolve(folder, 'export') });
    assert.match(await readFile(resolve(exported.output, 'DELIVERY.md'), 'utf8'), /Deployment and recovery/);
    assert.deepEqual(await readFile(resolve(exported.output, 'counter.js')), await readFile(resolve(source, 'counter.js')));
    await human('/channels/' + channelId + '/archive', {});
    const receipt = { event: 'worker_deployment_passed', at: new Date().toISOString(), modelCalls: 0, roleOutputs: 'synthetic', roomId: room.id, goalId: goal.id, folder, runtimeHome: runtime.home, imageId: image.imageId, toolchainDigest: ready.report.toolchainDigest, failedSourceBeforeClaim: true, projectCas: true, forcedAgentWithoutKeyRejected: true, capacityBeforeClaimRejected: true, realSigkill: true, realOrphanRemovedOffline: true, offlineApiCalls, foreignAttemptSurvived: true, originalOutboxDigest: staged.digest, exactOutboxRecovered: true, keylessWorkerCompleted: true, verificationPassed: true, checks: manifest.verification.receipt.checks.map(check => ({ id: check.id, exitCode: check.exitCode })), freshRuntimeExported: true, output: exported.output, resultReady: true };
    await writeFile(resolve(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile('.camp/deployment-latest.json', JSON.stringify(receipt, null, 2) + '\n');
    completed = true; console.log(JSON.stringify(receipt));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (!completed) await reapWorker({ runtime, apiUrl, workerId, apply: true }).catch(() => {});
    const cleanup = await Promise.allSettled([...active, foreign].filter(Boolean).map(run => runtime.cleanupAttempt(run.config.prefix)));
    if (room && !completed && goal) {
      online = true;
      await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
      try {
        const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
        await recoverWorker({ journal, runtime, request });
      } catch { console.error(JSON.stringify({ event: 'deployment_probe_recovery_requires_inspection', workerId })); }
    }
    if (room && !completed) await human('/channels/' + room.channelId + '/archive', {}).catch(() => {});
    await new Promise(resolveClosed => proxy.close(resolveClosed));
    if (cleanup.some(value => value.status === 'rejected')) console.error(JSON.stringify({ event: 'deployment_probe_cleanup_incomplete' }));
  }
}
