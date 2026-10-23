// Real API/PostgreSQL/Docker/LayerFS, with synthetic role output and zero model
// requests. The child owns a real two-lane manager; the parent owns crash probes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkerPool } from '../../packages/camp-runtime/src/worker-pool.mjs';
import { startWorker } from '../../packages/camp-runtime/src/worker.mjs';
import { workerApiRequest } from '../../packages/camp-runtime/src/worker-preflight.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { superviseOwnedChild } from './owned-child.mjs';

const execute = promisify(execFile);
const docker = args => execute('docker', ['--host', 'unix://' + (process.env.CAMP_DOCKER_SOCKET ?? '/var/run/docker.sock'), ...args], { timeout: 30000, maxBuffer: 1024 * 1024 });

if (['--serial-probe', '--policy-probe'].includes(process.argv[2])) {
  const serialProbe = process.argv[2] === '--serial-probe';
  let claims = 0, sessions = 0;
  const request = workerApiRequest(process.env);
  await assert.rejects((serialProbe ? startWorker : startWorkerPool)({
    request: async (path, body) => { if (path === '/claim' && !body.restoreOnly) claims++; return request(path, body); },
    createSession: () => { sessions++; assert.fail('A foreign orphan must prevent agent execution'); },
    log: () => {},
  }), { code: serialProbe ? 'camp_foreign_resources' : 'camp_resource_policy' });
  assert.equal(claims, 0); assert.equal(sessions, 0);
  console.log(JSON.stringify({ probe: serialProbe ? 'foreign_serial_rejected' : 'invalid_policy_recovered', normalClaims: claims, modelSessions: sessions }));
} else if (process.argv[2] === '--child') {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const builds = new Map();
  let markBoth, markReview;
  const bothStarted = new Promise(resolveBoth => { markBoth = resolveBoth; });
  const rightReviewStarted = new Promise(resolveReview => { markReview = resolveReview; });
  const createSession = launch => {
    const session = new EventEmitter();
    let stopped = false;
    session.stop = async () => { stopped = true; };
    session.start = async () => {
      void (async () => {
        const env = launch.env;
        const workerId = env.CAMP_WORKER_ID, epoch = Number(env.CAMP_RUN_EPOCH), runId = env.CAMP_RUN_ID;
        const request = workerApiRequest({ CAMP_API_URL: input.apiUrl, CAMP_WORKER_TOKEN: process.env.CAMP_WORKER_TOKEN });
        const { run } = await request(`/runs/${runId}/state`);
        const tool = (path, body) => workerApiRequest({ CAMP_API_URL: input.apiUrl, CAMP_WORKER_TOKEN: env.CAMP_RUN_TOKEN })(`/runs/${runId}/${path}`, { workerId, epoch, ...body });
        if (run.taskKind === 'plan') {
          await tool('plan', { planRevision: 1, summary: 'Independent notes from one frozen baseline', tasks: ['left', 'right'].map(key => ({ key, title: 'Add ' + key + ' note', description: 'Write only ' + key + '-note.txt', acceptance: 'Contains the assigned note', verification: 'External immutable contract checks both notes after integration' })) });
        } else if (run.taskKind === 'build') {
          const containerId = launch.args[launch.args.indexOf('node') - 1];
          builds.set(runId, { runId, workerId, epoch, containerId, key: run.planItemKey, inputCandidate: run.inputCandidate });
          if (builds.size === 2) {
            const pair = [...builds.values()];
            assert.notEqual(pair[0].workerId, pair[1].workerId);
            assert.equal(pair[0].inputCandidate.refId, pair[1].inputCandidate.refId);
            const facts = JSON.parse((await docker(['inspect', ...pair.map(row => row.containerId)])).stdout);
            assert.equal(facts.length, 2); assert.ok(facts.every(row => row.State.Running));
            assert.ok(facts.every(row => row.HostConfig.NanoCpus === 2000000000 && row.HostConfig.Memory === 2 * 1024 ** 3 && row.HostConfig.PidsLimit === 256), 'Both real main sandboxes must have the default enforced CPU/memory/PID limits');
            console.log(JSON.stringify({ probe: 'two_live_build_containers', pair }));
            markBoth();
          }
          await bothStarted;
          if (input.kind !== 'complete') await new Promise(() => {});
          // Force reversed completion and overlapping build/review through
          // server facts rather than a machine-dependent sleep duration.
          if (run.planItemKey === 'left') await rightReviewStarted;
          await docker(['exec', '--user', '501:20', '--workdir', launch.cwd, containerId, 'node', '-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])', run.planItemKey + '-note.txt', run.planItemKey + '\n']);
        } else if (['review', 'final_review'].includes(run.taskKind)) {
          if (run.taskKind === 'review' && run.planItemKey === 'right') {
            const left = [...builds.values()].find(value => value.key === 'left');
            const state = await request(`/runs/${left.runId}/state`);
            assert.equal(state.run.status, 'running'); assert.equal(state.leaseValid, true);
            console.log(JSON.stringify({ probe: 'review_overlaps_build', buildRunId: left.runId, reviewRunId: runId }));
            markReview();
          }
          await tool('events', { type: 'artifact', content: 'Synthetic approval bound to the mounted candidate', artifact: { type: 'review', outcome: 'approved', summary: 'Synthetic infrastructure approval', evidence: 'The operator external contract validates the final combination', candidate: { projectId: run.inputCandidate.projectId, refKind: run.inputCandidate.refKind, refId: run.inputCandidate.refId } } });
        } else if (run.taskKind === 'summary') {
          await tool('finalize', { summary: 'Both concurrent changes integrated and independently verified', evidence: 'Real Docker and LayerFS with synthetic role decisions', remaining: ['Role decisions are synthetic in this infrastructure probe'] });
        } else throw new Error('Unexpected task kind in pool probe: ' + run.taskKind);
        if (!stopped) {
          session.emit('runtime_event', { kind: 'text', text: 'Synthetic role output; real sandbox execution and durable workflow.' });
          session.emit('runtime_event', { kind: 'turn_end' });
        }
      })().catch(error => { if (!stopped) session.emit('error', error); });
      return { ok: true };
    };
    return session;
  };
  await startWorkerPool({ once: true, createSession });
} else {
  if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for this explicit zero-model pool probe');
  const selection = process.argv.find(value => value.startsWith('--case='))?.slice(7) ?? 'all';
  assert.ok(['all', 'complete', 'cancel', 'crash'].includes(selection));
  const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
  const image = JSON.parse(await readFile(process.env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/parallel-image.json', 'utf8'));
  const bundle = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-0.6.0');
  const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
  const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 200); const auth = await login.json();
  const human = async (path, body, method) => {
    const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `Pool probe API rejected ${path} (${response.status})`); return response.json();
  };
  const results = [];
  for (const kind of selection === 'all' ? ['complete', 'cancel', 'crash'] : [selection]) results.push(await exercise(kind));
  const receipt = { event: 'bounded_pair_infrastructure_passed', at: new Date().toISOString(), roleOutputs: 'synthetic', modelCalls: 0, imageId: image.imageId, toolchainDigest: image.toolchainDigest, cases: results };
  await writeFile('.camp/parallel-infra-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));

  async function exercise(kind) {
    const name = `camp-pool-${Date.now().toString(36)}-${kind}`, folder = resolve('.camp/parallel', name), source = join(folder, 'project'), runtimeHome = join(folder, 'runtime');
    await mkdir(folder, { recursive: true, mode: 0o700 }); await cp('examples/camp-counter/project', source, { recursive: true });
    const harnessPath = join(folder, 'contract.mjs');
    await writeFile(harnessPath, "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';for(const side of ['left','right'])assert.equal(await readFile('/workspace/'+side+'-note.txt','utf8'),side+'\\n');console.log('Both concurrent changes preserved');\n", { mode: 0o400 });
    const mappings = join(folder, 'harnesses.json'), harness = { id: 'pair-contract', sha256: createHash('sha256').update(await readFile(harnessPath)).digest('hex') };
    await writeFile(mappings, JSON.stringify([{ id: harness.id, path: harnessPath }]), { mode: 0o600 });
    let room, goal, owner, descriptor, success = false, workerToken, child, parallel, reviewOverlap = false, recoveryReady = false, logWrites = Promise.resolve();
    const launch = async () => {
      recoveryReady = false;
      descriptor = await open(join(folder, 'pool.log'), 'a', 0o600);
      const input = join(folder, 'child.json'); await writeFile(input, JSON.stringify({ apiUrl, kind }), { mode: 0o600 });
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', input], { stdio: ['ignore', 'pipe', descriptor.fd], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken, CAMP_WORKER_ID: name, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_VERIFICATION_HARNESSES: mappings, DEEPSEEK_API_KEY: 'synthetic-unused-no-provider-requests' } });
      owner = superviseOwnedChild(child, { group: false, handleSignals: true });
      const logDescriptor = descriptor;
      let pending = '';
      child.stdout.on('data', bytes => {
        logWrites = logWrites.then(() => logDescriptor.write(bytes));
        pending += bytes;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try { const message = JSON.parse(line); if (message.probe === 'two_live_build_containers') parallel = message; if (message.probe === 'review_overlaps_build') reviewOverlap = true; if (message.event === 'pool_recovery_ready') recoveryReady = true; } catch { /* Persist non-JSON diagnostics without interpreting them. */ }
        }
      });
    };
    const waitFor = async (predicate, label, timeoutMs = 240000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { const value = await predicate(); if (value) return value; owner?.assertRunning(label + ': pool exited'); await delay(500); }
      throw new Error(label + ': deadline exceeded');
    };
    try {
      const channel = await human('/channels/', { name, visibility: 'public', description: 'Two actual concurrent LayerFS sandboxes, synthetic roles, zero provider requests.' });
      room = await human('/camp/rooms', { channelId: channel.channel?.id ?? channel.id, name, project: { name, repoPath: source } });
      workerToken = (await human('/camp/rooms/' + room.id + '/worker-token', {})).token;
      await human('/camp/rooms/' + room.id + '/verification-policy', { expectedDigest: null, policy: { id: 'parallel-pair', revision: 1, name: 'Both independent notes', maxRepairAttempts: 0, checks: [{ id: 'notes', label: 'Both merged notes', argv: ['node', '/camp-checks/pair-contract'], harness, timeoutMs: 30000 }] } }, 'PUT');
      const title = 'Run two independent implementations concurrently';
      const snapshot = await human('/camp/rooms/' + room.id + '/tasks', { title, planMode: 'parallel_pair' }); goal = snapshot.goals.find(row => row.title === title); assert.equal(goal.protocolVersion, 4);
      const request = workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken });
      const old = { ...createWorkerDeclaration(), protocolVersions: [1, 2, 3] };
      const rejected = await request('/claim', { workerId: name + '-unpooled', protocol: old }); assert.equal(rejected.run, null);
      assert.equal((await human('/camp/rooms/' + room.id)).goals.find(row => row.id === goal.id).usage.runs, 0);
      await launch();
      await waitFor(() => parallel, 'Both builders did not become physically live');
      const pairSnapshot = await human('/camp/rooms/' + room.id), current = pairSnapshot.goals.find(row => row.id === goal.id);
      assert.equal(pairSnapshot.runs.filter(row => row.status === 'running').length, 2);
      assert.equal(new Set(pairSnapshot.runs.filter(row => row.status === 'running').map(row => row.agentId)).size, 1);
      assert.equal(current.currentCandidate.refId, parallel.pair[0].inputCandidate.refId);
      const used = current.usage.runs, pool = current.executionPool;
      const wrongPool = { ...pool, storageId: 'e'.repeat(64) };
      const refused = await request('/claim', { workerId: pool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: wrongPool } });
      assert.equal(refused.run, null); assert.equal((await human('/camp/rooms/' + room.id)).goals.find(row => row.id === goal.id).usage.runs, used);
      if (kind === 'complete') {
        const delivered = await waitFor(async () => { const state = await human('/camp/rooms/' + room.id); const goalState = state.goals.find(row => row.id === goal.id); assert.ok(!['needs_attention', 'cancelled'].includes(goalState.status), 'Pool workflow stopped: ' + goalState.reason); return goalState.status === 'completed' && state; }, 'Concurrent delivery', 360000);
        await owner.stop({ graceMs: 30000 });
        const manifest = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`); assert.equal(manifest.resultReady, true); assert.equal(manifest.verification.receipt.status, 'passed');
        assert.equal(delivered.runs.filter(row => row.executor === 'integration').length, 1);
        const builds = delivered.runs.filter(row => row.taskKind === 'build'); assert.equal(builds.length, 2);
        assert.equal(builds[0].inputCandidate.refId, builds[1].inputCandidate.refId);
        assert.equal(reviewOverlap, true, 'The first review must run alongside its unfinished sibling build');
        assert.ok(Date.parse(builds.find(row => row.planItemKey === 'right').completedAt) < Date.parse(builds.find(row => row.planItemKey === 'left').completedAt));
        assert.deepEqual(manifest.integration.input.parents.map(parent => parent.key), ['left', 'right']);
        const runtime = await new CampRuntime({ home: runtimeHome, imageId: image.imageId, toolchainBundle: bundle }).ready(), output = join(folder, 'export');
        await exportCandidate({ runtime, candidate: manifest.candidate, roomId: room.id, goalId: goal.id, output });
        for (const side of ['left', 'right']) assert.equal(await readFile(join(output, side + '-note.txt'), 'utf8'), side + '\n');
        await writeFile(join(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      } else {
        if (kind === 'cancel') {
          // The single-run API must drain the entire parallel goal.
          await human(`/camp/rooms/${room.id}/runs/${parallel.pair[0].runId}/cancel`, {});
        } else {
          child.kill('SIGKILL'); await owner.exited;
          const containers = JSON.parse((await docker(['inspect', ...parallel.pair.map(row => row.containerId)])).stdout);
          assert.ok(containers.every(row => row.State.Running), 'SIGKILL probe needs both orphaned physical sandboxes');
          // A fresh serial identity must not interpret the released manager
          // lock as evidence that these old physical attempts have stopped.
          const probe = await execute(process.execPath, [fileURLToPath(import.meta.url), '--serial-probe'], { timeout: 30000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken, CAMP_WORKER_ID: name + '-foreign', CAMP_RUNTIME_HOME: join(folder, 'foreign-runtime'), CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, DEEPSEEK_API_KEY: 'synthetic-unused-no-provider-requests', CAMP_WORKER_ONCE: '1' } });
          assert.deepEqual(JSON.parse(probe.stdout), { probe: 'foreign_serial_rejected', normalClaims: 0, modelSessions: 0 });
          const preserved = JSON.parse((await docker(['inspect', ...parallel.pair.map(row => row.containerId)])).stdout);
          assert.ok(preserved.every(row => row.State.Running), 'A foreign Worker cannot clean these attempts');
          // Recovery authority comes from the original journals. Invalid new
          // resource settings must not prevent cleanup or old result delivery.
          const policyProbe = await execute(process.execPath, [fileURLToPath(import.meta.url), '--policy-probe'], { timeout: 60000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken, CAMP_WORKER_ID: name, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_AGENT_CPU_MILLIS: 'invalid' } });
          assert.deepEqual(JSON.parse(policyProbe.stdout), { probe: 'invalid_policy_recovered', normalClaims: 0, modelSessions: 0 });
          for (const item of parallel.pair) await assert.rejects(docker(['inspect', item.containerId]));
          await logWrites; await descriptor.close(); descriptor = null;
          await launch();
          await waitFor(() => recoveryReady, 'The original pool must recover and reopen after valid settings return');
        }
        await waitFor(async () => { const state = await human('/camp/rooms/' + room.id); return state.runs.filter(row => row.taskKind === 'build').every(row => row.status !== 'running' && row.cleanupState === 'confirmed') && state; }, 'Both interrupted attempts must be cleaned');
        await owner.stop({ graceMs: 30000 });
        for (const item of parallel.pair) await assert.rejects(docker(['inspect', item.containerId]));
        const stopped = await human('/camp/rooms/' + room.id); assert.equal(stopped.goals.find(row => row.id === goal.id).resultReady, false);
        assert.equal(stopped.runs.filter(row => row.executor === 'integration').length, 0);
      }
      success = true;
      return { kind, roomId: room.id, goalId: goal.id, channelId: room.channelId, folder, twoPhysicalBuilders: true, mainContainerLimitsEnforced: true, physicalAttempts: parallel.pair, sameBaseline: true, unpooledZeroAllocation: true, wrongStorageZeroAllocation: true, ...(kind === 'complete' ? { resultReady: true, bothChangesExported: true, independentVerification: true, integrationRuns: 1, reversedCompletion: true, reviewOverlappedBuild: true } : { bothContainersRemoved: true, noIntegrationAllocated: true, ...(kind === 'crash' ? { realSigkill: true, allLaneRecovery: true, foreignSerialZeroAllocation: true, foreignResourcesPreserved: true, invalidPolicyRecovery: true, validPolicyReopenedPool: true } : { singleRunCancelDrainsGoal: true }) }) };
    } finally {
      if (!success && room && goal) await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
      await owner?.stop({ graceMs: 30000 }); await logWrites; await descriptor?.close();
      if (room) await human('/channels/' + room.channelId + '/archive', {}).catch(() => {});
    }
  }
}
