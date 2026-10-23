// Real control DB, Docker and LayerFS. Role decisions are synthetic; no model
// request occurs. Stop the standing host manager before this explicit probe.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startWorkerPool } from '../../packages/camp-runtime/src/worker-pool.mjs';
import { workerApiRequest } from '../../packages/camp-runtime/src/worker-preflight.mjs';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';

if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for the explicit zero-provider DAG acceptance');
const execute = promisify(execFile), docker = args => execute('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const image = JSON.parse(await readFile(process.env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/dag-image-0.7.0.json', 'utf8'));
const bundle = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-dag-0.7.0');
const name = `camp-dag-${Date.now().toString(36)}`, folder = resolve('.camp/dag', name), source = join(folder, 'project'), runtimeHome = join(folder, 'runtime');
await mkdir(folder, { recursive: true, mode: 0o700 }); await cp('examples/camp-counter/project', source, { recursive: true });
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), redirect: 'error', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 200); const auth = await login.json();
const human = async (path, body, method) => {
  const readOnly = body === undefined && !method, deadline = Date.now() + 10000;
  for (;;) {
    try {
      const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${auth.accessToken}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (readOnly && response.status >= 500 && Date.now() < deadline) { await response.body?.cancel(); await new Promise(resolveDelay => setTimeout(resolveDelay, 250)); continue; }
      assert.ok(response.ok, `DAG API ${path}: ${response.status}`); return response.json();
    } catch (error) {
      if (!readOnly || !(error instanceof TypeError) || Date.now() >= deadline) throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
  }
};
const graph = [['a', []], ['b', []], ['c', ['a', 'b']], ['d', ['c']], ['e', ['a']], ['f', ['d', 'e']]];
const tasks = graph.map(([key, dependsOnKeys]) => ({ key, title: `Produce ${key}`, description: `Write ${key}-note.txt after checking mounted dependency files`, acceptance: `Contains ${key} and approved dependencies`, verification: 'Fixed external final contract', dependsOnKeys }));
const harnessPath = join(folder, 'contract.mjs');
await writeFile(harnessPath, "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';for(const key of ['a','b','c','d','e','f'])assert.equal(await readFile('/workspace/'+key+'-note.txt','utf8'),key+'\\n');assert.equal(await readFile('/workspace/c-review-fix.txt','utf8'),'reviewed\\n');console.log('All graph changes and rework preserved');\n", { mode: 0o400 });
const harness = { id: 'dag-contract', sha256: createHash('sha256').update(await readFile(harnessPath)).digest('hex') }, mappings = join(folder, 'harnesses.json');
await writeFile(mappings, JSON.stringify([{ id: harness.id, path: harnessPath }]), { mode: 0o600 });
let room, goal, poolPromise, poolError, workerToken, success = false, interrupted = false, cBuilds = 0, cReviews = 0;
const signals = new EventEmitter(), logs = [], roots = new Map();
const stop = () => { interrupted = true; signals.emit('SIGTERM'); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
let rootReady; const bothRoots = new Promise(resolveBoth => { rootReady = resolveBoth; });
const createSession = launch => {
  const session = new EventEmitter(); let stopped = false;
  session.stop = async () => { stopped = true; };
  session.start = async () => {
    void (async () => {
      const env = launch.env, runId = env.CAMP_RUN_ID, epoch = Number(env.CAMP_RUN_EPOCH), workerId = env.CAMP_WORKER_ID;
      const request = workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken });
      const { run } = await request(`/runs/${runId}/state`);
      const tool = (path, body) => workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: env.CAMP_RUN_TOKEN })(`/runs/${runId}/${path}`, { workerId, epoch, ...body });
      const container = launch.args[launch.args.indexOf('node') - 1];
      const code = source => docker(['exec', '--user', '501:20', '--workdir', launch.cwd, container, 'node', '-e', source]);
      if (run.taskKind === 'plan') await tool('plan', { planRevision: 2, summary: 'Two roots, repeated joins, isolated reviewed rework', tasks });
      else if (run.taskKind === 'build') {
        const key = run.planItemKey;
        if (['a', 'b'].includes(key)) {
          roots.set(key, { runId, workerId, container, inputCandidate: run.inputCandidate });
          if (roots.size === 2) {
            const pair = [...roots.values()]; assert.notEqual(pair[0].workerId, pair[1].workerId);
            const facts = JSON.parse((await docker(['inspect', ...pair.map(row => row.container)])).stdout);
            assert.ok(facts.every(row => row.State.Running)); rootReady();
          }
          await bothRoots;
        }
        if (key === 'c') { cBuilds++; await code("const fs=require('node:fs');for(const k of ['a','b'])if(fs.readFileSync(k+'-note.txt','utf8')!==k+'\\n')throw Error('Missing approved parent')"); }
        if (key === 'd') await code("if(require('node:fs').readFileSync('c-review-fix.txt','utf8')!=='reviewed\\n')throw Error('Unreviewed candidate consumed')");
        if (key === 'e') await code("const fs=require('node:fs');if(!fs.existsSync('a-note.txt')||fs.existsSync('b-note.txt'))throw Error('Wrong single-parent input')");
        if (key === 'f') await code("const fs=require('node:fs');for(const k of ['a','b','c','d','e'])if(!fs.existsSync(k+'-note.txt'))throw Error('Missing repeated merge parent');if(!fs.existsSync('c-review-fix.txt'))throw Error('Missing reviewed rework')");
        await code(`require('node:fs').writeFileSync(${JSON.stringify(key + '-note.txt')},${JSON.stringify(key + '\n')})`);
        if (key === 'c' && cBuilds === 2) await code("require('node:fs').writeFileSync('c-review-fix.txt','reviewed\\n')");
      } else if (['review', 'final_review'].includes(run.taskKind)) {
        const rework = run.taskKind === 'review' && run.planItemKey === 'c' && ++cReviews === 1;
        await tool('events', { type: 'artifact', content: rework ? 'Please add the c review fix' : 'Approve the exact mounted candidate', artifact: { type: 'review', outcome: rework ? 'changes_requested' : 'approved', summary: rework ? 'Add c-review-fix.txt containing reviewed' : 'Synthetic candidate-bound approval', evidence: 'Real immutable workspace; final external harness checks every file', candidate: { projectId: run.inputCandidate.projectId, refKind: run.inputCandidate.refKind, refId: run.inputCandidate.refId } } });
      } else if (run.taskKind === 'summary') await tool('finalize', { summary: 'All six nodes, reviewed rework and repeated fan-in completed', evidence: 'Real Docker/LayerFS and frozen external harness', remaining: ['Synthetic role decisions; one physical host'] });
      else throw new Error(`Unexpected DAG role ${run.taskKind}`);
      if (!stopped) { session.emit('runtime_event', { kind: 'text', text: 'Synthetic DAG role completed' }); session.emit('runtime_event', { kind: 'turn_end' }); }
    })().catch(error => { if (!stopped) session.emit('error', error); });
    return { ok: true };
  };
  return session;
};
try {
  const channel = await human('/channels/', { name, visibility: 'public', description: 'Bounded DAG real infrastructure acceptance, zero model requests' });
  room = await human('/camp/rooms', { channelId: channel.channel?.id ?? channel.id, name, project: { name, repoPath: source } });
  workerToken = (await human(`/camp/rooms/${room.id}/worker-token`, {})).token;
  await human(`/camp/rooms/${room.id}/verification-policy`, { expectedDigest: null, policy: { id: 'dag-contract', revision: 1, name: 'Six nodes and reviewed rework', maxRepairAttempts: 0, checks: [{ id: 'files', label: 'All graph changes', argv: ['node', '/camp-checks/dag-contract'], harness, timeoutMs: 30000 }] } }, 'PUT');
  const snapshot = await human(`/camp/rooms/${room.id}/tasks`, { title: 'Six-node repeated fan-in delivery', planMode: 'bounded_dag', budget: { maxRuns: 36, maxReviewRounds: 16, maxDurationSeconds: 1200 } });
  goal = snapshot.goals[0]; assert.equal(goal.protocolVersion, 5);
  await writeFile(join(folder, 'fixture.json'), JSON.stringify({ name, roomId: room.id, channelId: room.channelId, goalId: goal.id, runtimeHome, imageId: image.imageId }, null, 2) + '\n', { mode: 0o600 });
  const request = workerApiRequest({ CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken });
  const unsupported = await request('/claim', { workerId: 'v4-probe', protocol: { ...createWorkerDeclaration(), protocolVersions: [1, 2, 3, 4] } });
  assert.equal(unsupported.run, null); assert.equal((await human(`/camp/rooms/${room.id}`)).goals[0].usage.runs, 0);
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: workerToken, CAMP_WORKER_ID: name, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_VERIFICATION_HARNESSES: mappings, DEEPSEEK_API_KEY: 'synthetic-unused-no-provider-requests' };
  poolPromise = startWorkerPool({ env, once: true, createSession, signalSource: signals, log: value => { logs.push(value); process.stdout.write(`${JSON.stringify(value)}\n`); } });
  poolPromise.catch(error => { poolError = error; });
  let delivered;
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (poolError) throw poolError;
    assert.equal(interrupted, false, 'DAG acceptance interrupted');
    assert.equal(logs.some(row => row.event === 'completion_fenced'), false, 'A trusted completion was fenced');
    const state = await human(`/camp/rooms/${room.id}`), current = state.goals.find(row => row.id === goal.id);
    assert.ok(!['needs_attention', 'cancelled'].includes(current.status), `DAG stopped: ${current.reason}`);
    if (current.status === 'completed') { delivered = state; break; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  }
  assert.ok(delivered, 'DAG delivery exceeded deadline'); signals.emit('SIGTERM'); await poolPromise;
  const result = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`);
  assert.equal(result.resultReady, true); assert.equal(result.verification.receipt.status, 'passed');
  assert.equal(delivered.runs.filter(run => run.executor === 'integration' && run.status === 'completed').length, 2);
  assert.equal(cBuilds, 2); assert.equal(cReviews, 2); assert.equal(delivered.goals[0].items.every(item => item.status === 'approved'), true);
  const runtime = await new CampRuntime({ home: runtimeHome, imageId: image.imageId, toolchainBundle: bundle }).ready();
  const output = join(folder, 'export'); await exportCandidate({ runtime, roomId: room.id, goalId: goal.id, candidate: result.candidate, output });
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(await readFile(join(output, key + '-note.txt'), 'utf8'), key + '\n');
  assert.equal(await readFile(join(output, 'c-review-fix.txt'), 'utf8'), 'reviewed\n');
  await assert.rejects(readFile(join(source, 'a-note.txt')), { code: 'ENOENT' });
  const receipt = { event: 'bounded_dag_infrastructure_passed', at: new Date().toISOString(), hostCount: 1, modelCalls: 0, roleOutputs: 'synthetic', folder, kind: 'complete', webUrl: `${process.env.CAMP_WEB_URL ?? 'http://localhost:15190'}/s/${seed.server.slug ?? 'dev'}/channel/${room.channelId}?tab=camp`, roomId: room.id, channelId: room.channelId, goalId: goal.id, imageId: image.imageId, toolchainDigest: image.toolchainDigest, nodes: 6, integrationRuns: 2, reviewedRework: 1, parallelRoots: [...roots.values()], resultReady: true, nativeHistoryIncludesEarlierMerge: true, originalSourceUnchanged: true };
  await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await writeFile('.camp/dag-infra-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt)); success = true;
} finally {
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  if (!success && room && goal) await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
  signals.emit('SIGTERM'); await poolPromise?.catch(() => {});
  await writeFile(join(folder, 'worker.log'), logs.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  if (room) await human(`/channels/${room.channelId}/archive`, {}).catch(() => {});
}
