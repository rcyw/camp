// Explicit real-provider chaos check. Creates only its own room/project/files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const baked = JSON.parse(await readFile(resolve('packages/camp-runtime/.local/baked-image.json'), 'utf8'));
const stamp = Date.now().toString(36);
const name = `camp-recovery-${stamp}`;
const folder = resolve('.camp/recovery', name);
const source = resolve(folder, 'source');
await mkdir(source, { recursive: true, mode: 0o700 });
await writeFile(resolve(source, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }) + '\n');
await writeFile(resolve(source, 'probe.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('recovery fixture remains readable', () => assert.equal(2 + 3, 5));\n");
const login = await fetch(`${apiUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200);
const { accessToken } = await login.json();
async function userRequest(path, body) {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'x-server-id': seed.server.id, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const created = await userRequest('/channels/', { name, description: 'Explicit real worker recovery / network-fault check', visibility: 'public' });
const channel = created.channel ?? created;
const room = await userRequest('/camp/rooms', { channelId: channel.id, name, project: { name, repoPath: source, baseRef: 'main' } });
const credential = await userRequest(`/camp/rooms/${room.id}/worker-token`, {});
const marker = `Crash recovery probe ready ${stamp}`;
const initial = await userRequest(`/camp/rooms/${room.id}/tasks`, {
  role: 'planner', title: `Verify worker recovery ${stamp}`,
  description: `This is an explicit worker crash recovery test. First call camp_read_context and inspect run.epoch. If epoch is 1: call camp_progress with exactly "${marker}" and then run node -e 'setTimeout(() => {}, 120000)' and wait; the test controller will kill the worker. If epoch is greater than 1: do not sleep; run node --test in the workspace, report its actual result and finish promptly. Do not change any files, spawn other agents, or publish anything.`,
});
const task = initial.tasks.find(task => task.title.includes(stamp));
assert.ok(task);
let worker, childNumber = 0, crashedDuringCompletion = false;
let droppedClaim = false, droppedCompletion = false;
let temporaryOutageUntil = 0, unavailableResponses = 0;
const observedClaims = new Map();
const completionAcks = [];
function killWorker() {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) process.kill(-worker.child.pid, 'SIGKILL');
}
// Forward only the Camp worker protocol to one fixed local server. Never log credentials.
const proxy = createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/api/camp/worker/')) { res.writeHead(404).end(); return; }
    if (Date.now() < temporaryOutageUntil) {
      unavailableResponses++;
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"Injected temporary control-plane outage"}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(`${apiUrl}${req.url}`, {
      method: req.method,
      headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
      ...(body.length ? { body } : {}), signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    if (upstream.ok && req.url === '/api/camp/worker/claim') {
      const reply = JSON.parse(text);
      if (reply.run) {
        const claim = JSON.parse(body.toString());
        const ids = observedClaims.get(claim.claimId) ?? new Set();
        ids.add(reply.run.id);
        observedClaims.set(claim.claimId, ids);
        if (!droppedClaim) {
          droppedClaim = true;
          console.log(JSON.stringify({ event: 'fault_claim_response_lost', runId: reply.run.id }));
          res.destroy();
          return;
        }
      }
    }
    if (upstream.ok && /\/runs\/[^/]+\/complete$/.test(req.url)) {
      const reply = JSON.parse(text);
      completionAcks.push({ runId: reply.run?.id, replayed: reply.replayed === true });
      if (!droppedCompletion && reply.run?.status === 'completed') {
        droppedCompletion = true;
        crashedDuringCompletion = true;
        console.log(JSON.stringify({ event: 'fault_completion_applied_response_lost', runId: reply.run.id }));
        killWorker();
        res.destroy();
        return;
      }
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
  } catch {
    if (!res.headersSent) res.writeHead(502).end('{"error":"Fault proxy upstream unavailable"}');
    else res.destroy();
  }
});
await new Promise((resolveListen, reject) => { proxy.once('error', reject); proxy.listen(0, '0.0.0.0', resolveListen); });
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const workerEnv = resolve(folder, 'worker.env');
await writeFile(workerEnv, `CAMP_API_URL=${proxyUrl}\nCAMP_WORKER_TOKEN=${credential.token}\nCAMP_WORKER_ID=${name}\nCAMP_WORKER_ONCE=1\nCAMP_RUNTIME_HOME=${resolve(folder, 'runtime')}\nCAMP_RUNTIME_IMAGE=${baked.imageId}\n`, { mode: 0o600 });
async function startWorker() {
  const log = await open(resolve(folder, `worker-${++childNumber}.log`), 'w', 0o600);
  const child = spawn(process.execPath, ['--env-file=.camp/runtime.env', `--env-file=${workerEnv}`, '--import', '@oxc-node/core/register', 'packages/camp-runtime/src/worker.mjs'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env } });
  const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  worker = { child, exit, log };
  return worker;
}
async function snapshot() { return userRequest(`/camp/rooms/${room.id}`); }
async function until(check, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const prefixOf = run => `camp-mvp-run-${createHash('sha256').update(`${run.id}-e${run.epoch}`).digest('hex').slice(0, 16)}-`;
const containers = async prefix => (await execute('docker', ['ps', '-a', '-q', '--filter', `name=^/${prefix}`])).stdout.trim();
let firstRun;
try {
  await startWorker();
  firstRun = await until(async () => {
    const state = await snapshot();
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error(`Worker exited before the real-model milestone; inspect ${folder}`);
    const run = state.runs.find(run => run.taskId === task.id && run.epoch === 1);
    if (run?.status === 'failed') throw new Error(`First run failed before injected crash; inspect ${folder}`);
    return run && state.events.some(event => event.runId === run.id && event.type === 'progress' && event.content === marker) ? run : null;
  }, 180, 'real DSH crash milestone');
  assert.ok(droppedClaim, 'Claim response loss must be exercised');
  assert.ok(await containers(prefixOf(firstRun)), 'There must be a real sandbox before the crash');
  killWorker();
  assert.equal((await worker.exit).signal, 'SIGKILL');
  await worker.log.close();
  assert.ok(await containers(prefixOf(firstRun)), 'The crash must leave a sandbox for recovery to reconcile');
  console.log(JSON.stringify({ event: 'fault_worker_sigkill_with_orphan', runId: firstRun.id }));
  // The periodic server reconciler must work without a replacement claim.
  await until(async () => (await snapshot()).runs.find(run => run.id === firstRun.id)?.status === 'failed', 75, 'server lease reconciliation without a new claim');
  temporaryOutageUntil = Date.now() + 2500;
  await startWorker();
  await until(async () => crashedDuringCompletion, 180, 'second run completion response loss');
  assert.equal((await worker.exit).signal, 'SIGKILL');
  await worker.log.close();
  assert.equal(await containers(prefixOf(firstRun)), '', 'Restart must remove only the obsolete run sandbox');
  await startWorker();
  const lastExit = await Promise.race([worker.exit, delay(45_000, null, { ref: false }).then(() => { throw new Error('Outbox recovery did not finish'); })]);
  assert.equal(lastExit.code, 0, `Restart must acknowledge the outbox; inspect ${folder}`);
  await worker.log.close();
  const final = await snapshot();
  const runs = final.runs.filter(run => run.taskId === task.id).sort((a, b) => a.epoch - b.epoch);
  assert.equal(runs.length, 2, 'Restarting the outbox must not execute another model run');
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[1].status, 'completed');
  assert.equal(runs[1].epoch, runs[0].epoch + 1);
  assert.equal(final.events.filter(event => event.runId === runs[1].id && event.type === 'completed').length, 1, 'Completion must publish one event');
  assert.ok(completionAcks.some(ack => ack.runId === runs[1].id && ack.replayed), 'The restarted worker must receive an idempotent completion acknowledgement');
  assert.ok(unavailableResponses > 0, 'Startup recovery must also survive a temporary control-plane outage');
  for (const ids of observedClaims.values()) assert.equal(ids.size, 1, 'A repeated claim identity must never allocate a different run');
  for (const run of runs) assert.equal(await containers(prefixOf(run)), '', 'All probe execution containers must be released');
  const result = { event: 'real_recovery_smoke_passed', at: new Date().toISOString(), roomId: room.id, channelId: channel.id, webUrl: `http://localhost:15190/s/${seed.server.slug}/channel/${channel.id}?tab=camp`, imageId: baked.imageId, droppedClaim, droppedCompletion, unavailableResponses, restarts: childNumber - 1, runs: runs.map(run => ({ id: run.id, epoch: run.epoch, status: run.status })), completionAcks, orphanRemoved: true };
  await writeFile(resolve(folder, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(resolve('.camp/recovery-latest.json'), JSON.stringify({ folder, ...result }, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'real_recovery_smoke_failed', reason: error.message, folder, roomId: room.id }));
  process.exitCode = 1;
} finally {
  killWorker();
  await Promise.race([worker?.exit, delay(3000, null, { ref: false })]);
  await worker?.log.close().catch(() => {});
  const state = await snapshot().catch(() => null);
  for (const run of state?.runs ?? []) {
    if (run.status === 'running') await userRequest(`/camp/rooms/${room.id}/runs/${run.id}/cancel`, {}).catch(() => {});
    // Exclusive, deterministically computed prefixes for this probe's runs only.
    const ids = await containers(prefixOf(run));
    if (ids) await execute('docker', ['rm', '-f', ...ids.split('\n')]);
  }
  proxy.closeAllConnections();
  await new Promise(resolveClose => proxy.close(resolveClose));
}
