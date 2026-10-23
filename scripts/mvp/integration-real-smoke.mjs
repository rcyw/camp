// Synthetic role outputs, real API/PostgreSQL/Worker/LayerFS integration,
// independent verification and SIGKILL. This probe never loads model config.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { startWorker } from '../../packages/camp-runtime/src/worker.mjs';
import { WorkerJournal } from '../../packages/camp-runtime/src/durable-state.mjs';
import { workerApiRequest } from '../../packages/camp-runtime/src/worker-preflight.mjs';
import { runTrustedIntegration } from '../../packages/camp-runtime/src/integration.mjs';
import { createChangeSet } from '../../packages/camp-runtime/src/change-set.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { createWorkerDeclaration, serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';
import { superviseOwnedChild } from './owned-child.mjs';

if (process.argv[2] === '--child') {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = await new CampRuntime(input.runtimeOptions).ready();
  const journal = await new WorkerJournal({ home: runtime.home, apiUrl: input.env.CAMP_API_URL, workerId: input.env.CAMP_WORKER_ID }).ready();
  if (input.kind.startsWith('uncertain')) {
    const sdk = runtime.sdk.bind(runtime);
    runtime.sdk = async (...args) => {
      const answer = await sdk(...args);
      if (args[1] === 'branch.merge') {
        console.log(JSON.stringify({ probe: 'native_merge_returned_before_validation' }));
        await new Promise(() => {}); // Parent injects SIGKILL after a real merge.
      }
      return answer;
    };
  }
  await startWorker({ runtime, journal, env: { ...input.env, CAMP_WORKER_TOKEN: process.env.CAMP_WORKER_TOKEN }, log: () => {},
    integrateCandidates: async options => runTrustedIntegration({ ...options, onResult: async report => {
      await options.onResult(report);
      const records = await journal.list(), record = records.find(row => row.executor === 'integration');
      assert.ok(record.completion);
      console.log(JSON.stringify({ probe: 'integration_outbox_staged', runId: record.runId, epoch: record.epoch, digest: record.completion.digest }));
      await new Promise(() => {});
    } }),
  });
  throw new Error('The integration crash probe exited without reaching its boundary');
} else {
  if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for this explicit zero-model infrastructure probe');
  const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7) ?? 'all';
  if (!['all', 'complete', 'conflict', 'uncertain', 'uncertain_cancel'].includes(selected)) throw new Error('Choose --case=all|complete|conflict|uncertain|uncertain_cancel');
  const cases = selected === 'all' ? ['complete', 'conflict', 'uncertain', 'uncertain_cancel'] : [selected];
  const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
  const image = JSON.parse(await readFile(process.env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/integration-image.json', 'utf8'));
  const bundle = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-0.5.0');
  const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
  const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  assert.equal(login.status, 200); const auth = await login.json();
  async function human(path, body, method) {
    const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.ok(response.ok, `Integration probe API rejected ${path} (${response.status})`); return response.json();
  }
  const results = [];
  for (const kind of cases) results.push(await exercise(kind));
  const receipt = { event: 'trusted_integration_infrastructure_passed', at: new Date().toISOString(), roleOutputs: 'synthetic', modelCalls: 0, imageId: image.imageId, toolchainDigest: image.toolchainDigest, cases: results };
  await writeFile('.camp/integration-infra-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));

  async function exercise(kind) {
    const name = `camp-merge-${Date.now().toString(36)}-${kind === 'uncertain_cancel' ? 'ucancel' : kind}`, folder = resolve('.camp/integration', name), source = join(folder, 'source');
    await mkdir(folder, { recursive: true, mode: 0o700 }); await cp('examples/camp-counter/project', source, { recursive: true });
    await writeFile(join(source, 'shared.txt'), 'baseline\n');
    const harnessPath = join(folder, 'contract.mjs');
    await writeFile(harnessPath, "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal(await readFile('/workspace/left-note.txt','utf8'),'left\\n');assert.equal(await readFile('/workspace/right-note.txt','utf8'),'right\\n');console.log('Both independent changes are present');\n", { mode: 0o400 });
    const harness = { id: 'pair-contract', sha256: createHash('sha256').update(await readFile(harnessPath)).digest('hex') };
    const mappings = join(folder, 'harnesses.json'); await writeFile(mappings, JSON.stringify([{ id: harness.id, path: harnessPath }]), { mode: 0o600 });
    const runtimeOptions = { home: join(folder, 'runtime'), toolchainBundle: bundle, imageId: image.imageId };
    const runtime = await new CampRuntime(runtimeOptions).ready();
    let room, goal, workerToken, project, activeRun, childOwner, child;
    const workerId = name + '-system', env = { CAMP_API_URL: apiUrl, CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', CAMP_VERIFICATION_HARNESSES: mappings };
    const request = (path, body) => workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken })(path, body);
    const driver = name + '-roles';
    const assertNoRunningRuns = snapshot => assert.equal(snapshot.runs.filter(run => run.status === 'running').length, 0);
    let baseline, staged, completed = false;
    try {
      const channel = await human('/channels/', { name, visibility: 'public', description: 'Synthetic roles; real trusted integration, verification, recovery. Zero model calls.' });
      room = await human('/camp/rooms', { channelId: channel.channel?.id ?? channel.id, name, project: { name, repoPath: source } });
      workerToken = (await human('/camp/rooms/' + room.id + '/worker-token', {})).token;
      await human('/camp/rooms/' + room.id + '/verification-policy', { expectedDigest: null, policy: { id: 'pair', revision: 1, name: 'Both changes and original tests', maxRepairAttempts: 0, checks: [{ id: 'project-tests', label: 'Original tests', argv: ['node', '--test'], timeoutMs: 60000 }, { id: 'pair', label: 'Both independent changes', argv: ['node', '/camp-checks/pair-contract'], harness, timeoutMs: 30000 }] } }, 'PUT');
      const title = 'Implement two independent notes and integrate both (synthetic infrastructure acceptance)';
      let snapshot = await human('/camp/rooms/' + room.id + '/tasks', { title, planMode: 'same_baseline_pair' }); goal = snapshot.goals.find(row => row.title === title); assert.equal(goal.protocolVersion, 3);
      const oldWorker = { ...createWorkerDeclaration(), protocolVersions: [1, 2], taskKinds: createWorkerDeclaration().taskKinds.filter(value => value !== 'integration'), capabilities: createWorkerDeclaration().capabilities.filter(value => value !== 'trusted-integration.v1') };
      const refused = await request('/claim', { workerId: name + '-v2', protocol: oldWorker }); assert.equal(refused.run, null); assert.equal(refused.compatibility.status, 'incompatible');
      snapshot = await human('/camp/rooms/' + room.id); assert.equal(snapshot.runs.length, 0); assert.equal(snapshot.goals.find(row => row.id === goal.id).usage.runs, 0);
      project = await runtime.prepareProject({ projectId: 'room:' + room.id, sourcePath: source });
      const parents = [];
      async function tool(run, path, body) {
        const response = await fetch(apiUrl + `/api/camp/worker/runs/${run.id}/${path}`, { method: 'POST', headers: { authorization: 'Bearer ' + run.runToken, 'content-type': 'application/json' }, body: JSON.stringify({ workerId: driver, epoch: run.epoch, ...body }), signal: AbortSignal.timeout(10000), redirect: 'error' });
        assert.ok(response.ok, `${path} rejected (${response.status})`); return response.json();
      }
      async function drive(taskKind, produce) {
        const { run } = await request('/claim', { workerId: driver, protocol: createWorkerDeclaration() }); assert.equal(run.taskKind, taskKind);
        const controller = new AbortController(); let heartbeat = Promise.resolve();
        const timer = setInterval(() => { heartbeat = heartbeat.then(async () => { const reply = await request(`/runs/${run.id}/heartbeat`, { workerId: driver, epoch: run.epoch }); if (reply.cancelRequested) throw new Error('Synthetic role was cancelled'); }).catch(error => controller.abort(error)); }, 7000);
        try {
          const result = await produce(run, controller.signal); controller.signal.throwIfAborted();
          await request(`/runs/${run.id}/complete`, { workerId: driver, epoch: run.epoch, status: 'completed', summary: `Synthetic ${taskKind}; infrastructure is real`, inputCandidate: run.inputCandidate ?? baseline, candidate: { ...(result.candidate ?? run.inputCandidate ?? baseline), baseRef: (run.inputCandidate ?? baseline).refId }, ...result });
          return run;
        } finally { clearInterval(timer); await heartbeat; }
      }
      await drive('plan', async (run, signal) => {
        activeRun = await runtime.prepareRun({ project, runId: `${run.id}-e${run.epoch}`, roleId: 'planner', baseRef: run.baseRef, signal });
        baseline = await runtime.pinInputCandidate(activeRun, run.inputCandidate, { signal }); await runtime.releaseRun(activeRun); activeRun = null;
        await tool(run, 'plan', { planRevision: 1, summary: 'Two independent same-baseline items', tasks: ['left', 'right'].map(key => ({ key, title: 'Add ' + key + ' note', description: 'Add only ' + key + '-note.txt', acceptance: 'The note exists', verification: 'Independent external contract checks both files' })) });
        return { candidate: { ...baseline, baseRef: baseline.refId } };
      });
      for (const side of ['left', 'right']) {
        await drive('build', async (run, signal) => {
          assert.equal(run.inputCandidate.refId, baseline.refId); assert.equal(run.baseRef, baseline.refId);
          activeRun = await runtime.prepareRun({ project, runId: `${run.id}-e${run.epoch}`, roleId: 'builder', baseRef: run.baseRef, signal });
          await runtime.pinInputCandidate(activeRun, run.inputCandidate, { signal });
          const path = kind === 'conflict' ? 'shared.txt' : side + '-note.txt';
          await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', activeRun.workspacePath, activeRun.containerId, 'node', '-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', path, side + '\n'], { signal });
          await runtime.quiesceAgent(activeRun, { signal }); const output = await runtime.commitCandidate(activeRun, { signal }); await runtime.releaseRun(activeRun); activeRun = null; parents.push(output);
          return { candidate: output, changeSet: await createChangeSet({ runtime, ownerRun: runtime.runIdentity(`${run.id}-e${run.epoch}`), base: baseline, target: output, signal }) };
        });
        await drive('review', async run => { await tool(run, 'events', { type: 'artifact', content: 'Synthetic candidate-bound review', artifact: { type: 'review', outcome: 'approved', summary: 'Synthetic approval', evidence: 'Real independent verification follows integration', candidate: { projectId: run.inputCandidate.projectId, refKind: run.inputCandidate.refKind, refId: run.inputCandidate.refId } } }); return { outcome: 'approved' }; });
      }
      snapshot = await human('/camp/rooms/' + room.id); const operation = snapshot.goals.find(row => row.id === goal.id).integration.operations[0];
      assert.equal(operation.integrationInput.base.refId, baseline.refId);
      assert.deepEqual(operation.integrationInput.parents.map(row => row.candidate.refId), parents.map(row => row.refId));
      assert.equal(operation.inputDigest, createHash('sha256').update(serializeIntegrationInput(operation.integrationInput)).digest('hex'));
      if (kind !== 'conflict') {
        const childInput = join(folder, 'child.json'); await writeFile(childInput, JSON.stringify({ runtimeOptions, env, kind }), { mode: 0o600 });
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', childInput], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_WORKER_TOKEN: workerToken } });
        childOwner = superviseOwnedChild(child, { group: false }); child.stderr.resume();
        staged = await new Promise((resolveReady, reject) => {
          let pending = ''; const timer = setTimeout(() => reject(new Error('Integration worker did not reach the injection boundary')), 180000);
          child.stdout.on('data', bytes => { pending += bytes; const at = pending.indexOf('\n'); if (at >= 0) { clearTimeout(timer); try { resolveReady(JSON.parse(pending.slice(0, at))); } catch (error) { reject(error); } } });
          void childOwner.exited.then(() => { clearTimeout(timer); reject(new Error('Integration child exited before the injection boundary')); });
        });
        assert.equal(staged.probe, kind === 'complete' ? 'integration_outbox_staged' : 'native_merge_returned_before_validation');
        if (kind === 'uncertain_cancel') await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {});
        child.kill('SIGKILL'); await childOwner.exited;
      }
      const logs = [], workerOptions = { runtime, env: { ...env, CAMP_WORKER_TOKEN: workerToken }, log: value => logs.push(value) };
      if (kind.startsWith('uncertain')) await assert.rejects(startWorker(workerOptions), { code: 'camp_integration_inspection_required' });
      else await startWorker(workerOptions);
      snapshot = await human('/camp/rooms/' + room.id); assertNoRunningRuns(snapshot);
      const current = snapshot.goals.find(row => row.id === goal.id), integration = current.integration.operations[0];
      if (kind === 'complete') {
        assert.equal(current.verification.status, 'passed'); assert.equal(integration.integrationReport.status, 'merged');
        const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready(); const records = await journal.list(), record = records.find(row => row.executor === 'integration');
        assert.equal(record.completion.digest, staged.digest); assert.equal(record.phase, 'settled');
        assert.equal(snapshot.runs.filter(row => row.executor === 'integration').length, 1);
        await drive('final_review', async run => { await tool(run, 'events', { type: 'artifact', content: 'Synthetic final review of the verified integrated candidate', artifact: { type: 'review', outcome: 'approved', summary: 'Synthetic final approval', evidence: 'Both frozen operator checks passed', candidate: { projectId: run.inputCandidate.projectId, refKind: run.inputCandidate.refKind, refId: run.inputCandidate.refId } } }); return { outcome: 'approved' }; });
        await drive('summary', async run => { await tool(run, 'finalize', { summary: 'Both independent candidates integrated, recovered and verified', evidence: 'Real LayerFS merge, SIGKILL outbox recovery and independent checks', remaining: ['Role outputs in this probe are synthetic'] }); return {}; });
        const manifest = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`); assert.equal(manifest.resultReady, true); assert.equal(manifest.integration.receipt.status, 'merged');
        const output = join(folder, 'export'); await exportCandidate({ runtime: await new CampRuntime(runtimeOptions).ready(), candidate: manifest.candidate, roomId: room.id, goalId: goal.id, output });
        for (const side of ['left', 'right']) assert.equal(await readFile(join(output, side + '-note.txt'), 'utf8'), side + '\n');
        await writeFile(join(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
        completed = true;
        return { kind, roomId: room.id, goalId: goal.id, folder, resultReady: true, sameBaseline: true, v2ZeroAllocation: true, realSigkill: true, originalOutboxRecovered: true, duplicateIntegrationRuns: 0, bothChangesExported: true, verificationPassed: true };
      }
      assert.equal(current.status, kind === 'uncertain_cancel' ? 'cancelled' : 'needs_attention'); assert.equal(current.resultReady, false); assert.equal(snapshot.room.acceptedRevision, 0); assert.equal(snapshot.room.acceptedCandidate, null);
      assert.equal(snapshot.runs.filter(row => row.executor === 'verification').length, 0);
      if (kind === 'conflict') { assert.equal(integration.integrationReport.status, 'conflict'); assert.ok(integration.integrationReport.conflicts.some(row => row.path === 'shared.txt')); assert.equal(integration.integrationReport.candidate, null); }
      else { assert.equal(current.integrationInspectionRequired, true); assert.equal(current.canRetry, false); if (kind === 'uncertain_cancel') assert.equal(current.reason, 'cancelled_by_human'); else assert.match(current.reason, /integration_inspection_required/); assert.equal(snapshot.runs.filter(row => row.executor === 'integration').length, 1); }
      for (const parent of parents) await runtime.verifyCandidate(project, parent);
      completed = true;
      return { kind, roomId: room.id, goalId: goal.id, folder, resultReady: false, parentsPreserved: true, acceptedHeadUnchanged: true, noVerificationAllocated: true, ...(kind.startsWith('uncertain') ? { realNativeMergeThenSigkill: true, unknownOutcomeRequiresInspection: true, mergeNotRetried: true, ...(kind === 'uncertain_cancel' ? { cancellationPreserved: true, inspectionLatchSurvivedCancellation: true, retryBlocked: true } : {}) } : { overlapRejected: true, noFallbackCandidate: true }) };
    } finally {
      await childOwner?.stop({ graceMs: 1000 });
      if (activeRun) await runtime.cleanupAttempt(activeRun.config.prefix);
      if (room && !completed && goal) await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
      if (room) await human('/channels/' + room.channelId + '/archive', {});
    }
  }
}
