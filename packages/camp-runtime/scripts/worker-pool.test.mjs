import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startWorkerPool } from '../src/worker-pool.mjs';
import { startWorker } from '../src/worker.mjs';
import { CampRuntime } from '../src/index.mjs';
import { PoolAdmission, poolResources, admitPoolHost, acquireHostManager } from '../src/host-manager.mjs';
import { openPoolState, checkPoolJournals } from '../src/pool-state.mjs';
import { WorkerJournal, acquireWorkerLock, atomicJson } from '../src/durable-state.mjs';
import { restorePendingClaim } from '../src/worker-recovery.mjs';
import { resourcePolicy } from '../src/resource-policy.mjs';
import { selectWorkerDeclaration, negotiateWorker } from '../src/worker-protocol.mjs';
import { parseExecutionPool, serverProtocol, getTaskRequirements, checkWorkerCompatibility } from '../../camp-protocol/src/index.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const policy = resourcePolicy({}), resources = poolResources(policy);
const facts = { ID: 'fixture-docker', NCPU: 64, MemTotal: 64 * 1024 ** 3 };
const pool = () => parseExecutionPool({ poolId: randomUUID(), storageId: 'a'.repeat(64), maxParallel: 2, workerIds: ['lane-1', 'lane-2'], resources });
const container = (prefix, suffix = 'main') => ({ id: createHash('sha256').update(prefix + suffix).digest('hex'), name: prefix + suffix });
const prefix = number => `camp-mvp-run-${String(number).padStart(16, '0')}-`;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-pool-')), signals = new EventEmitter(), containers = [], requests = [], logs = [];
  const env = { CAMP_API_URL: 'http://pool.fixture', CAMP_WORKER_TOKEN: 'fixture-token', CAMP_WORKER_ID: 'base-' + randomUUID() };
  const runtime = { home, async dockerCall(args) {
    assert.equal(args[0], 'ps');
    return { stdout: containers.map(item => `${item.id} ${item.name}`).join('\n') };
  }, runIdentity(runId) { const short = createHash('sha256').update(runId).digest('hex').slice(0, 16); return { runId, prefix: `camp-mvp-run-${short}-`, folder: join(home, 'runs', short) }; }, async cleanupAttempt(selected) { for (let i = containers.length - 1; i >= 0; i--) if (containers[i].name.startsWith(selected)) containers.splice(i, 1); } };
  const f = { home, env, signals, containers, requests, logs, runtime, manager: { facts }, once: true,
    request: async (path, body) => { requests.push({ path, body }); if (path.startsWith('/reconcile?')) return { runs: [] }; if (path.endsWith('/cleanup')) return { cleanupState: 'confirmed' }; if (path === '/protocol') return serverProtocol(); if (path === '/claim') return body.restoreOnly ? { run: null, unbound: true } : { run: null, compatibility: null, requirements: null }; throw new Error(`Unexpected request ${path}`); },
    createRuntime: () => ({ ...runtime }), workerOptions: { admitExecution: async () => {}, checkCapacity: async () => {} },
    admitHost: async () => {}, signalSource: signals, log: entry => logs.push(entry), close: () => rm(home, { recursive: true, force: true }) };
  return f;
}

test('stable pool identity binds the original Docker host, API, base worker and resource policy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-pool-state-'));
  const options = { home, apiUrl: 'http://fixture', baseWorkerId: 'base', dockerId: 'daemon', resources, policy };
  try {
    const first = await openPoolState(options), second = await openPoolState(options);
    assert.deepEqual(second, first); assert.equal(first.workerIds.length, 2);
    for (const changed of [{ apiUrl: 'http://other' }, { baseWorkerId: 'another' }, { dockerId: 'changed' }, { policy: { ...policy, cpuMillis: policy.cpuMillis + 1 } }]) await assert.rejects(openPoolState({ ...options, ...changed }), { code: 'camp_pool_identity' });
    const text = await readFile(join(home, 'execution-pool.json'), 'utf8'); assert(!text.includes('token'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('a manager lock spans different runtime homes on the same Docker host and is retained until release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-host-manager-lock-'));
  const runtime = home => ({ home, dockerCall: async () => ({ stdout: JSON.stringify(facts) }) });
  let first, second;
  try {
    first = await acquireHostManager({ runtime: runtime('/first'), lockRoot: root });
    await assert.rejects(acquireHostManager({ runtime: runtime('/second'), lockRoot: root }), /already running/);
    await first.release(); first = null;
    second = await acquireHostManager({ runtime: runtime('/second'), lockRoot: root });
  } finally { await first?.release(); await second?.release(); await rm(root, { recursive: true, force: true }); }
});
test('an explicitly supplied real Runtime acquires the host manager before API calls and releases it after the worker exits', async () => {
  const f = await fixture(); let acquired = 0, released = 0;
  const runtime = new CampRuntime({ home: f.home, imageId: 'sha256:' + 'a'.repeat(64) });
  runtime.dockerCall = async () => ({ stdout: '' });
  const original = f.request;
  try {
    await startWorker({ ...f.workerOptions, env: { ...f.env, CAMP_WORKER_ONCE: '1' }, runtime, request: async (...args) => { assert.equal(acquired, 1); assert.equal(released, 0); return original(...args); }, signalSource: f.signals, log: f.log,
      acquireManager: async selected => {
        assert.equal(selected.runtime, runtime); acquired++;
        const manager = await acquireHostManager({ runtime: { dockerCall: async () => ({ stdout: JSON.stringify(facts) }) }, lockRoot: join(f.home, 'host-locks') });
        return { ...manager, async release() { released++; await manager.release(); } };
      },
    });
    assert.equal(acquired, 1); assert.equal(released, 1);
    const next = await acquireHostManager({ runtime: { dockerCall: async () => ({ stdout: JSON.stringify(facts) }) }, lockRoot: join(f.home, 'host-locks') }); await next.release();
  } finally { await f.close(); }
});
test('a fresh standalone real Runtime refuses another manager orphan before any allocation without deleting it', async () => {
  const f = await fixture(), orphan = container(prefix(99)); let cleanups = 0;
  const runtime = new CampRuntime({ home: f.home, imageId: 'sha256:' + 'a'.repeat(64) });
  runtime.dockerCall = async args => { assert.equal(args[0], 'ps'); return { stdout: `${orphan.id} ${orphan.name}` }; };
  runtime.cleanupAttempt = async () => { cleanups++; };
  try {
    await assert.rejects(startWorker({ ...f.workerOptions, env: { ...f.env, CAMP_WORKER_ONCE: '1' }, runtime, request: f.request, log: f.log, acquireManager: async () => ({ facts, release: async () => {} }) }), { code: 'camp_foreign_resources' });
    assert.equal(f.requests.filter(item => item.path === '/claim' && !item.body.restoreOnly).length, 0); assert.equal(cleanups, 0);
  } finally { await f.close(); }
});
for (const operation of ['beforeClaim', 'withContainer']) test(`${operation} does not mistake an in-flight observation of a just-retired sibling for foreign resources`, async () => {
  const snapshot = deferred(), entered = deferred(), old = container(prefix(1)); let queries = 0, created = 0;
  const admission = new PoolAdmission({ runtime: { dockerCall: async () => { if (++queries === 1) { entered.resolve(); return snapshot.promise; } return { stdout: '' }; } }, resources });
  admission.hold(prefix(1), 'old'); admission.hold(prefix(2), 'active');
  const observing = operation === 'beforeClaim' ? admission.beforeClaim() : admission.withContainer(prefix(2), async () => { created++; });
  observing.catch(() => {});
  await entered.promise;
  await admission.finish(prefix(1), { cleanupKnown: true });
  snapshot.resolve({ stdout: `${old.id} ${old.name}` });
  await observing;
  assert.equal(admission.closed, false); assert.equal(created, operation === 'withContainer' ? 1 : 0); assert(queries >= 3, 'A changed reservation generation requires a fresh physical observation');
});
test('a queued container creation cannot outlive its own attempt reservation', async () => {
  const snapshot = deferred(), entered = deferred(); let queries = 0, creates = 0;
  const admission = new PoolAdmission({ runtime: { dockerCall: async () => { if (++queries === 1) { entered.resolve(); return snapshot.promise; } return { stdout: '' }; } }, resources });
  admission.hold(prefix(1), 'old');
  const creating = admission.withContainer(prefix(1), async () => { creates++; }); creating.catch(() => {});
  await entered.promise; await admission.finish(prefix(1), { cleanupKnown: true }); snapshot.resolve({ stdout: '' });
  await assert.rejects(creating, { code: 'camp_pool_unsafe' }); assert.equal(creates, 0);
});
test('invalid resource declarations cannot leave a persisted unusable pool identity', async () => {
  const f = await fixture();
  try {
    await assert.rejects(openPoolState({ home: f.home, apiUrl: f.env.CAMP_API_URL, baseWorkerId: f.env.CAMP_WORKER_ID, dockerId: facts.ID, resources: { ...resources, cpuMillis: 1000000000 }, policy }));
    await assert.rejects(access(join(f.home, 'execution-pool.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
for (const changed of ['changed', 'invalid', 'tampered']) test(`all original serial and lane outboxes replay before ${changed} new resource policy blocks allocation`, async () => {
  const f = await fixture(), completions = [], states = new Map(), journals = [];
  try {
    const metadata = await openPoolState({ home: f.home, apiUrl: f.env.CAMP_API_URL, baseWorkerId: f.env.CAMP_WORKER_ID, dockerId: facts.ID, resources, policy });
    for (const workerId of [f.env.CAMP_WORKER_ID, ...metadata.workerIds]) {
      const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId }).ready(), runId = randomUUID(); journals.push(journal);
      const record = await journal.recordClaim({ id: runId, roomId: randomUUID(), executor: 'agent', epoch: 3, protocolVersion: 99 }, { runtime: f.runtime.runIdentity(`${runId}-e3`) });
      const payload = { workerId, epoch: 3, status: 'completed', summary: `Original result for ${workerId}` };
      await journal.update(record, { cleanupKnown: true }); await journal.prepareCompletion(record, payload);
      states.set(runId, { run: { id: runId, workerId, epoch: 3, status: 'completed', cleanupState: 'confirmed' }, cleanupState: 'confirmed', leaseValid: false, replaced: false });
    }
    if (changed === 'tampered') await atomicJson(join(f.home, 'execution-pool.json'), { ...metadata, resources: { ...metadata.resources, cpuMillis: metadata.resources.cpuMillis - 1000 } });
    else f.env.CAMP_AGENT_CPU_MILLIS = changed === 'changed' ? '1000' : '0';
    const originalMetadata = await readFile(join(f.home, 'execution-pool.json'), 'utf8');
    const original = f.request;
    f.request = async (path, body) => { if (path.endsWith('/state')) return states.get(path.split('/')[2]); if (path.endsWith('/complete')) { completions.push(body); return { replayed: true }; } return original(path, body); };
    await assert.rejects(startWorkerPool(f), { code: changed === 'invalid' ? 'camp_resource_policy' : 'camp_pool_identity' });
    assert.equal(completions.length, 3); assert.equal(f.requests.filter(item => item.path === '/claim').length, 0);
    for (const journal of journals) { const [record] = await journal.list(); assert.equal(record.phase, 'settled'); assert.deepEqual(completions.find(item => item.workerId === journal.workerId), record.completion.payload); }
    assert.equal(await readFile(join(f.home, 'execution-pool.json'), 'utf8'), originalMetadata);
  } finally { await f.close(); }
});
test('the complete four-container CPU range is valid before persisting a pool identity', async () => {
  const f = await fixture(), maximumPolicy = resourcePolicy({ CAMP_AGENT_CPU_MILLIS: '64000' });
  try { const metadata = await openPoolState({ home: f.home, apiUrl: f.env.CAMP_API_URL, baseWorkerId: f.env.CAMP_WORKER_ID, dockerId: facts.ID, policy: maximumPolicy, resources: poolResources(maximumPolicy) }); assert.equal(metadata.resources.cpuMillis, 256000); }
  finally { await f.close(); }
});
test('a restored original standalone outbox is acknowledged before a foreign physical resource blocks new work', async () => {
  const f = await fixture(), orphan = container(prefix(99)), completed = [], runId = randomUUID();
  const runtime = new CampRuntime({ home: f.home, imageId: 'sha256:' + 'a'.repeat(64) }); runtime.dockerCall = async () => ({ stdout: `${orphan.id} ${orphan.name}` });
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready(), intent = await journal.claimIntent();
    const record = await journal.recordClaim({ id: runId, roomId: randomUUID(), executor: 'agent', epoch: 3 }, { claimId: intent, runtime: runtime.runIdentity(`${runId}-e3`) });
    const payload = { workerId: journal.workerId, epoch: 3, status: 'completed', summary: 'Original durable result.' };
    await journal.update(record, { cleanupKnown: true }); await journal.prepareCompletion(record, payload);
    const request = async (path, body) => {
      if (path === '/protocol') return serverProtocol();
      if (path === '/claim') { assert.equal(body.restoreOnly, true); return { run: { id: runId, epoch: 3, executor: 'agent', prompt: 'Do not execute', runToken: 'fixture-only' } }; }
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path.endsWith('/state')) return { run: { id: runId, workerId: journal.workerId, epoch: 3, status: 'completed', cleanupState: 'confirmed' }, cleanupState: 'confirmed', leaseValid: false, replaced: false };
      if (path.endsWith('/complete')) { completed.push(body); return { replayed: true }; }
      assert.fail(`Unexpected ${path}`);
    };
    await assert.rejects(startWorker({ ...f.workerOptions, env: { ...f.env, CAMP_WORKER_ONCE: '1' }, runtime, journal, request, acquireManager: async () => ({ facts, release: async () => {} }), log: f.log }), { code: 'camp_foreign_resources' });
    assert.deepEqual(completed, [payload]); assert.equal(await journal.pendingClaim(), null); assert.equal((await journal.list())[0].phase, 'settled');
  } finally { await f.close(); }
});
test('aggregate admission reserves helpers, host memory, PID headroom and private scratch', async () => {
  assert.deepEqual(resources, { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 });
  let storagePolicy;
  const options = { runtime: {}, policy, facts, pidLimit: 4096, env: {}, capacity: async (_runtime, value) => { storagePolicy = value; } };
  await admitPoolHost(options); assert.equal(storagePolicy.minFreeBytes, policy.minFreeBytes + 2 * 1024 ** 3);
  for (const changed of [{ facts: { ...facts, NCPU: 7 } }, { facts: { ...facts, MemTotal: resources.memoryBytes } }, { pidLimit: 1024 }]) await assert.rejects(admitPoolHost({ ...options, ...changed }), { code: 'camp_pool_capacity' });
  assert.equal(poolResources(resourcePolicy({ CAMP_AGENT_CPU_MILLIS: '250', CAMP_AGENT_MEMORY_MIB: '512', CAMP_AGENT_PIDS_LIMIT: '64' })).cpuMillis, 2000, 'fixed verifier CPU is reserved even with a smaller agent policy');
});
test('two attempt reservations and four containers are strict, including helpers', async () => {
  const observed = [], failed = [];
  const runtime = { dockerCall: async () => ({ stdout: observed.map(item => `${item.id} ${item.name}`).join('\n') }) };
  const admission = new PoolAdmission({ runtime, resources, onFatal: error => failed.push(error) });
  admission.hold(prefix(1), 'a'); admission.hold(prefix(2), 'b');
  await Promise.all([1, 2].flatMap(lane => ['main', 'aux'].map(suffix => admission.withContainer(prefix(lane), async () => { await new Promise(resolve => setTimeout(resolve, 2)); observed.push(container(prefix(lane), suffix)); }))));
  assert.equal(observed.length, 4);
  await assert.rejects(admission.withContainer(prefix(1), async () => assert.fail('A fifth container cannot be created')), { code: 'camp_pool_unsafe' });
  assert.equal(admission.attempts.size, 2); assert.equal(failed.length, 1);
});
test('a failed cleanup or native uncertainty retains its slot and closes the whole pool', async () => {
  for (const state of [{ cleanupKnown: false }, { cleanupKnown: true, requiresInspection: true }, { cleanupKnown: true, phase: 'ownership_conflict' }]) {
    const admission = new PoolAdmission({ runtime: { dockerCall: async () => ({ stdout: '' }) }, resources });
    admission.hold(prefix(1), 'a');
    await assert.rejects(admission.finish(prefix(1), state));
    assert.equal(admission.attempts.size, 1); assert.equal(admission.closed, true);
  }
});
test('a remaining physical orphan retains its slot even with a prior cleanup flag', async () => {
  const orphan = container(prefix(1));
  const admission = new PoolAdmission({ runtime: { dockerCall: async () => ({ stdout: `${orphan.id} ${orphan.name}` }) }, resources });
  admission.hold(prefix(1), 'a'); await assert.rejects(admission.finish(prefix(1), { cleanupKnown: true })); assert.equal(admission.attempts.size, 1);
});
test('an unbound pending claim recovery never allocates or discards its intent', async () => {
  const f = await fixture();
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    const intent = await journal.claimIntent();
    await restorePendingClaim({ journal, runtime: f.runtime, request: f.request, workerToken: f.env.CAMP_WORKER_TOKEN });
    assert.equal(await journal.pendingClaim(), intent); assert.equal(f.requests.length, 2); assert.equal(f.requests[0].path, '/protocol'); assert.equal(f.requests[1].body.restoreOnly, true); assert.equal(f.requests[1].body.claimId, intent);
  } finally { await f.close(); }
});
test('invalid first-time pool configuration does not block the original serial outbox or create metadata', async () => {
  const f = await fixture(), completed = [], runId = randomUUID();
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    const record = await journal.recordClaim({ id: runId, epoch: 1, executor: 'agent', roomId: randomUUID() }, { runtime: f.runtime.runIdentity(`${runId}-e1`) });
    const payload = { workerId: journal.workerId, epoch: 1, status: 'completed', summary: 'Original serial result.' };
    await journal.update(record, { cleanupKnown: true }); await journal.prepareCompletion(record, payload);
    f.env.CAMP_AGENT_CPU_MILLIS = '0'; const original = f.request;
    f.request = async (path, body) => { if (path.endsWith('/state')) return { run: { id: runId, workerId: journal.workerId, epoch: 1, status: 'completed', cleanupState: 'confirmed' }, cleanupState: 'confirmed', leaseValid: false, replaced: false }; if (path.endsWith('/complete')) { completed.push(body); return { replayed: true }; } return original(path, body); };
    await assert.rejects(startWorkerPool(f), { code: 'camp_resource_policy' }); assert.deepEqual(completed, [payload]); assert.equal(f.requests.filter(item => item.path === '/claim').length, 0);
    await assert.rejects(access(join(f.home, 'execution-pool.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
for (const mode of ['standalone', 'pool']) for (const hasOutbox of [false, true]) test(`${mode} pending recovery never sends restoreOnly to an old server that would ignore it, while known outbox=${hasOutbox} survives`, async () => {
  const f = await fixture(), posts = [], payloads = [], runId = randomUUID();
  const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready(), intent = await journal.claimIntent();
  const runtime = new CampRuntime({ home: f.home, imageId: 'sha256:' + 'a'.repeat(64) }); runtime.dockerCall = async () => ({ stdout: '' });
  const original = f.request, payload = { workerId: journal.workerId, epoch: 1, status: 'completed', summary: 'Immutable old server result.' };
  try {
    if (hasOutbox) {
      const record = await journal.recordClaim({ id: runId, epoch: 1, executor: 'agent', roomId: randomUUID() }, { runtime: f.runtime.runIdentity(`${runId}-e1`) }); await journal.update(record, { cleanupKnown: true }); await journal.prepareCompletion(record, payload);
    }
    f.request = async (path, body) => {
      if (path === '/protocol') return { ...serverProtocol(), supportedProtocolVersions: [1, 2, 3] };
      if (path === '/claim') { posts.push(body); return { run: null, compatibility: null, requirements: null }; }
      if (path.startsWith('/reconcile')) assert.fail('Unsupported pending recovery must not discover an unknown bound intent');
      if (path.endsWith('/state')) return { run: { id: runId, workerId: journal.workerId, epoch: 1, status: 'completed', cleanupState: 'confirmed' }, cleanupState: 'confirmed', leaseValid: false, replaced: false };
      if (path.endsWith('/complete')) { payloads.push(body); return { replayed: true }; }
      return original(path, body);
    };
    const action = mode === 'pool' ? startWorkerPool(f) : startWorker({ ...f.workerOptions, env: { ...f.env, CAMP_WORKER_ONCE: '1' }, runtime, request: f.request, journal, acquireManager: async () => ({ facts, release: async () => {} }), log: f.log });
    await assert.rejects(action, { code: 'camp_restore_unsupported' });
    assert.deepEqual(posts, []); assert.deepEqual(payloads, hasOutbox ? [payload] : []); assert.equal(await journal.pendingClaim(), intent);
  } finally { await f.close(); }
});
test('the whole pool waits for both lane recoveries before its first allocation', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const original = f.request; let laneRecoveries = 0;
  f.request = async (path, body) => {
    if (path.startsWith('/reconcile?') && !path.includes(encodeURIComponent(f.env.CAMP_WORKER_ID))) {
      if (++laneRecoveries === 2) { entered.resolve(); await release.promise; }
    }
    return original(path, body);
  };
  try {
    const running = startWorkerPool(f); await entered.promise;
    assert.equal(f.requests.filter(item => item.path === '/claim').length, 0);
    release.resolve(); await running;
    assert.equal(f.logs.filter(item => item.event === 'pool_recovery_ready').length, 1);
    const claims = f.requests.filter(item => item.path === '/claim'); assert(claims.length >= 2); assert(claims.every(item => item.body.protocol.executionPool.maxParallel === 2));
    assert.equal(new Set(claims.map(item => item.body.workerId)).size, 2);
  } finally { release.resolve(); await f.close(); }
});
test('a foreign orphan blocks both lanes without deleting it or allocating work', async () => {
  const f = await fixture(); f.containers.push(container(prefix(99)));
  try { await assert.rejects(startWorkerPool(f), { code: 'camp_pool_unsafe' }); assert.equal(f.containers.length, 1); assert.equal(f.requests.filter(item => item.path === '/claim').length, 0); }
  finally { await f.close(); }
});
test('foreign pending journals cannot be adopted just because they share this runtime home', async () => {
  const f = await fixture();
  try {
    const other = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: 'foreign' }).ready(); await other.claimIntent();
    await assert.rejects(checkPoolJournals({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerIds: [f.env.CAMP_WORKER_ID] }), { code: 'camp_pool_foreign_state' });
  } finally { await f.close(); }
});
test('standalone workers never advertise v4; pool negotiation cannot fall back to an older server', async () => {
  const declaration = selectWorkerDeclaration(serverProtocol()).protocol;
  assert.deepEqual(declaration.protocolVersions, [1, 2, 3]); assert(!declaration.capabilities.includes('bounded-pair.v1')); assert(!declaration.executionPool);
  await assert.rejects(negotiateWorker({ request: async () => ({ ...serverProtocol(), supportedProtocolVersions: [1, 2, 3] }), env: {}, executionPool: pool() }), { code: 'protocol_unsupported' });
  const negotiated = await negotiateWorker({ request: async () => serverProtocol(), env: {}, executionPool: pool() });
  assert(negotiated.protocol.protocolVersions.includes(4)); assert(negotiated.protocol.capabilities.includes('bounded-pair.v1'));
});
for (const cancelRequested of [false, true]) test(`a lane fatal error stops its active sibling with cancellation=${cancelRequested} and keeps the original outbox identity`, async () => {
  const f = await fixture(), active = deferred(), completions = [], claims = new Map();
  const candidate = { type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), layerId: '32' + 'a'.repeat(64), rootId: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64) };
  const verificationPolicy = { policy: { id: 'checks', revision: 1, name: 'checks', checks: [{ id: 'unit', label: 'unit', argv: ['node', '--test'], timeoutMs: 1000 }], maxRepairAttempts: 0 }, digest: 'a'.repeat(64) };
  let discovery = 0, stopped = false;
  const original = f.request;
  f.request = async (path, body) => {
    if (path === '/protocol' && ++discovery === 2) { await active.promise; throw Object.assign(new Error('Unsupported server'), { status: 426, code: 'protocol_unsupported' }); }
    if (path === '/claim' && !body.restoreOnly) {
      const requirements = getTaskRequirements({ protocolVersion: 4, workflow: 'serial', taskKind: 'verification', inputCandidate: candidate, verificationPolicy });
      const claim = { id: randomUUID(), roomId: randomUUID(), workerId: body.workerId, epoch: 1, executor: 'verification', taskKind: 'verification', taskId: null, role: null, agentId: null, operationId: randomUUID(), project: { name: 'fixture' }, protocolVersion: 4, workflow: 'serial', inputCandidate: candidate, verificationPolicy, leaseExpiresAt: new Date(Date.now() + 45000).toISOString(), workerProtocol: { version: 4, declaration: body.protocol, requirements } };
      claims.set(claim.id, claim); return { run: claim, requirements, compatibility: checkWorkerCompatibility(body.protocol, requirements) };
    }
    if (path.endsWith('/heartbeat')) return { run: { leaseExpiresAt: new Date(Date.now() + 45000).toISOString() }, cancelRequested: false };
    if (path.endsWith('/state')) { const claim = claims.get(path.split('/')[2]); return { run: { id: claim.id, workerId: claim.workerId, epoch: 1, status: 'running', cancelRequested }, leaseValid: true, replaced: false }; }
    if (path.endsWith('/complete')) { completions.push(body); return {}; }
    return original(path, body);
  };
  f.createRuntime = () => ({ ...f.runtime, prepareProject: async () => ({ projectId: candidate.projectId, imageId: candidate.imageId }) });
  f.workerOptions = { admitExecution: async () => {}, checkCapacity: async () => {}, verifyCandidate: async ({ signal }) => {
    active.resolve(); await new Promise((resolveWait, reject) => { signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true }); });
  } };
  try {
    await assert.rejects(startWorkerPool(f), { code: 'protocol_unsupported' });
    assert.equal(stopped, true); assert.equal(completions.length, 1); assert.equal(completions[0].status, cancelRequested ? 'cancelled' : 'failed'); if (!cancelRequested) assert.equal(completions[0].error, 'worker_shutdown');
    const claim = [...claims.values()][0]; assert.equal(completions[0].workerId, claim.workerId); assert.equal(completions[0].epoch, claim.epoch);
    const lock = await acquireWorkerLock(claim.workerId); await lock.release();
  } finally { await f.close(); }
});
test('pool upgrade replays the original serial outbox before any new lane claim without a model', async () => {
  const f = await fixture(), completed = [], claimId = randomUUID(), runId = randomUUID();
  const original = f.request;
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    const record = await journal.recordClaim({ id: runId, roomId: randomUUID(), executor: 'agent', epoch: 9, protocolVersion: 99 }, { claimId, runtime: f.runtime.runIdentity(`${runId}-e9`) });
    const payload = { workerId: f.env.CAMP_WORKER_ID, epoch: 9, status: 'completed', summary: 'Original immutable result.' };
    await journal.update(record, { cleanupKnown: true }); await journal.prepareCompletion(record, payload);
    f.request = async (path, body) => {
      if (path.endsWith('/state')) return { run: { id: runId, workerId: f.env.CAMP_WORKER_ID, epoch: 9, status: 'completed' }, leaseValid: false, replaced: false };
      if (path.endsWith('/complete')) { assert.equal(f.requests.filter(item => item.path === '/claim').length, 0); completed.push(body); return { replayed: true }; }
      return original(path, body);
    };
    await startWorkerPool(f); assert.deepEqual(completed, [payload]);
    const [saved] = await journal.list(); assert.equal(saved.phase, 'settled'); assert.deepEqual(saved.completion.payload, payload);
  } finally { await f.close(); }
});
test('SIGTERM during old intent inspection retains its original unknown binding and allocates nothing', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  const original = f.request;
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready(), intent = await journal.claimIntent();
    f.request = async (path, body) => { if (path === '/claim' && body.restoreOnly) { entered.resolve(); await release.promise; } return original(path, body); };
    const running = startWorkerPool(f); await entered.promise; f.signals.emit('SIGTERM'); release.resolve(); await running;
    assert.equal(await journal.pendingClaim(), intent); assert(f.requests.filter(item => item.path === '/claim').every(item => item.body.restoreOnly));
  } finally { release.resolve(); await f.close(); }
});
