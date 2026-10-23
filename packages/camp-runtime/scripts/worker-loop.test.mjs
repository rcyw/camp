import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal, atomicJson } from '../src/durable-state.mjs';
import { createWorkerDeclaration, serverProtocol, getTaskRequirements } from '../../camp-protocol/src/index.js';
const compatibility = { status: 'compatible', code: 'compatible', protocolVersion: 1, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] };

async function fixture({ neverEnds = false, failTurn = false, droppedClaim = false, apiTransportFailure = false, version = 1, kind = 'plan', baseline = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'camp-loop-'));
  const workerId = `loop-test-${randomUUID()}`;
  const env = { CAMP_API_URL: 'http://127.0.0.1', CAMP_WORKER_TOKEN: 'local-test-only', DEEPSEEK_API_KEY: 'local-test-only', CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', ...(neverEnds ? { CAMP_RUN_TIMEOUT_MS: '100' } : {}) };
  const input = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'c'.repeat(64)}`, refKind: 'commit', refId: `12${'b'.repeat(64)}`, commitId: `12${'b'.repeat(64)}`, rootId: 'd'.repeat(64) };
  const claim = { id: 'run', roomId: 'room', role: 'planner', taskId: 'task', epoch: 1, workflow: 'legacy', taskKind: 'plan', inputCandidate: null, baseRef: 'main', workerProtocol: createWorkerDeclaration(), prompt: 'test orchestration only', project: {}, runToken: 'scoped-token', leaseExpiresAt: new Date(Date.now() + 45_000).toISOString() };
  claim.protocolVersion = version; claim.taskKind = kind; claim.goalBaseline = baseline;
  if (version >= 2) { claim.executor = 'agent'; claim.operationId = null; }
  if (kind === 'build') { claim.inputCandidate = input; claim.baseRef = input.refId; claim.role = 'builder'; }
  claim.workerProtocol = { version, declaration: createWorkerDeclaration(), requirements: getTaskRequirements(claim) };
  const negotiatedCompatibility = { ...compatibility, protocolVersion: version, ...(version >= 2 ? { missingHarnesses: [] } : {}) };
  const state = { run: { ...claim, workerId, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  const actions = [], claims = [], completions = [];
  let supplied = false, stops = 0;
  const runtime = {
    home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}` }),
    async prepareProject() { return { projectId: input.projectId, imageId: input.imageId }; },
    async prepareRun() { return { runId: 'run-e1', containerId: 'fake', workspacePath: '/workspace' }; },
    async pinInputCandidate(run) { run.baseRef = input.commitId; return input; },
    async installDsh() {}, async installPlugin() {}, async quiesceAgent() {},
    async sandboxHostAddress() { return '127.0.0.1'; }, async sandboxApiUrl() { return 'http://127.0.0.1'; }, launchSpec() { return {}; }, async archiveSession() {},
    async commitCandidate() { return { ...input, baseRef: input.commitId }; },
    async releaseRun() { actions.push('release'); }, async abortRun() { actions.push('abort'); }, async cleanupAttempt() { actions.push('cleanup'); },
  };
  const request = async (path, body) => {
    actions.push(path);
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path === '/protocol') return serverProtocol();
    if (path === '/claim') {
      claims.push(body);
      if (droppedClaim && claims.length === 1) throw new TypeError('claim response lost');
      if (supplied) return { run: null, compatibility: negotiatedCompatibility };
      supplied = true;
      return { run: claim, compatibility: negotiatedCompatibility };
    }
    if (path.endsWith('/heartbeat')) return { run: claim, cancelRequested: false };
    if (path.endsWith('/context')) return { artifacts: [] };
    if (path.endsWith('/state')) return state;
    if (path.endsWith('/complete')) { completions.push(body); state.run.status = body.status; state.leaseValid = false; return { replayed: false }; }
    if (apiTransportFailure && path.endsWith('/events')) throw Object.assign(new Error('Control API transport interrupted'), { code: 'camp_api_transport' });
    return {};
  };
  const createSession = () => {
    const session = new EventEmitter();
    session.start = async () => {
      if (!neverEnds) queueMicrotask(() => {
        if (failTurn) session.emit('runtime_event', { kind: 'error', message: 'Business execution failed' });
        session.emit('runtime_event', { kind: 'text', text: 'A complete test result' });
        session.emit('runtime_event', { kind: 'turn_end' });
      });
      return { ok: true };
    };
    session.stop = async () => { stops++; };
    return session;
  };
  return { home, env, runtime, request, createSession, admitExecution: async () => {}, checkCapacity: async () => {}, actions, claims, completions, input, stops: () => stops, async close() { await rm(home, { recursive: true, force: true }); } };
}

test('ambiguous claim is retried with the same intent before reconcile, then completes once', async () => {
  const f = await fixture({ droppedClaim: true });
  try {
    await startWorker({ ...f, log: () => {} });
    assert.deepEqual(f.claims[0], f.claims[1]);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'completed');
    const firstClaim = f.actions.indexOf('/claim');
    assert.equal(f.actions.slice(firstClaim + 1, f.actions.indexOf('/claim', firstClaim + 1)).some(path => path.startsWith('/reconcile')), false);
  } finally { await f.close(); }
});

for (const mode of ['timeout', 'business-failure']) {
  test(`${mode} keeps its original failure semantics instead of becoming worker_interrupted`, async () => {
    const f = await fixture({ neverEnds: mode === 'timeout', failTurn: mode === 'business-failure' });
    try {
      await startWorker({ ...f, log: () => {} });
      assert.ok(f.stops() >= 1);
      assert.equal(f.completions.length, 1);
      assert.equal(f.completions[0].error, mode === 'timeout' ? 'run_budget_exhausted' : 'dsh_execution_failed');
      assert.equal(f.completions[0].status, 'failed');
      const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
      assert.deepEqual((await journal.list())[0].completion.payload, f.completions[0]);
      assert.ok(f.actions.indexOf('abort') < f.actions.indexOf('/runs/run/complete'));
    } finally { await f.close(); }
  });
}
test('journal fsync failure stops the worker before any claim can allocate a run', async () => {
  const f = await fixture();
  try {
    let writes = 0;
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID, persist: async (path, value) => {
      writes++;
      if (writes > 1) throw Object.assign(new Error('Injected fsync EIO'), { code: 'camp_journal_io' });
      await atomicJson(path, value);
    } }).ready();
    await assert.rejects(startWorker({ ...f, journal, log: () => {} }), /fsync EIO/);
    assert.equal(f.claims.length, 0);
    assert.equal(f.completions.length, 0);
  } finally { await f.close(); }
});
for (const boundary of ['admitExecution', 'checkCapacity']) test(`${boundary} failure prevents a claim and never starts a model`, async () => {
  const f = await fixture();
  try {
    await assert.rejects(startWorker({ ...f, [boundary]: async () => { throw Object.assign(new Error('Prerequisite unavailable'), { code: 'camp_preflight_failed', status: 409 }); }, createSession: () => assert.fail('No model before admission'), log: () => {} }), { code: 'camp_preflight_failed' });
    assert.equal(f.claims.length, 0); assert.equal(f.completions.length, 0);
    assert.equal(f.actions[0].startsWith('/reconcile'), true, 'Recovery precedes new-execution admission');
  } finally { await f.close(); }
});
for (const code of ['camp_capacity_low', 'camp_capacity_unavailable']) test(`active ${code} stops execution and retains an explicit policy failure`, async () => {
  const f = await fixture({ neverEnds: true });
  let started = false;
  try {
    f.env.CAMP_RUN_TIMEOUT_MS = '2000';
    const createSession = options => {
      const session = f.createSession(options), original = session.start;
      session.start = async input => { started = true; return original(input); };
      return session;
    };
    await assert.rejects(startWorker({ ...f, createSession, heartbeatIntervalMs: 5, checkCapacity: async () => { if (started) throw Object.assign(new Error('Storage policy stopped the active execution'), { code, status: 409 }); }, log: () => {} }), { code });
    assert.equal(f.claims.length, 1); assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'failed'); assert.equal(f.completions[0].error, code);
    assert.ok(f.stops() > 0); assert.ok(f.actions.indexOf('abort') < f.actions.indexOf('/runs/run/complete'));
  } finally { await f.close(); }
});
test('control API transport failure keeps infrastructure semantics without relabeling model failures', async () => {
  const f = await fixture({ apiTransportFailure: true });
  try {
    await startWorker({ ...f, log: () => {} });
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'failed');
    assert.equal(f.completions[0].error, 'worker_interrupted');
  } finally { await f.close(); }
});
for (const kind of ['build', 'plan']) test(`v2 ${kind} ${kind === 'build' ? 'binds its diff to the frozen goal baseline' : 'does not regenerate a diff'}`, async () => {
  const baseline = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'c'.repeat(64)}`, refKind: 'layer', refId: `32${'e'.repeat(64)}`, layerId: `32${'e'.repeat(64)}`, rootId: 'f'.repeat(64) };
  const f = await fixture({ version: 2, kind, baseline });
  const diffs = [], logs = [];
  try {
    await startWorker({ ...f, log: entry => logs.push(entry), createChangeSet: async args => {
      diffs.push(args);
      return { schemaVersion: 1, base: args.base, target: args.target, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } };
    } });
    assert.equal(f.completions.length, 1, JSON.stringify(logs)); assert.equal(f.completions[0].status, 'completed');
    assert.equal(diffs.length, kind === 'build' ? 1 : 0);
    if (kind === 'build') {
      assert.deepEqual(diffs[0].base, baseline);
      assert.deepEqual(diffs[0].target, f.completions[0].candidate);
      assert.notDeepEqual(diffs[0].base, f.input);
    } else assert.equal('changeSet' in f.completions[0], false);
  } finally { await f.close(); }
});

for (const configuration of ['shared-journal', 'whitespace-worker-id']) test(`${configuration} fails before logging, API contact or task allocation`, async () => {
  const f = await fixture(), logs = [];
  try {
    if (configuration === 'shared-journal') {
      const { mkdir, chmod } = await import('node:fs/promises');
      await mkdir(join(f.home, 'workers')); await chmod(join(f.home, 'workers'), 0o755);
    } else f.env.CAMP_WORKER_ID = ` ${f.env.CAMP_WORKER_ID} `;
    await assert.rejects(startWorker({ ...f, log: entry => logs.push(entry) }), { code: configuration === 'shared-journal' ? 'camp_journal_io' : 'camp_worker_configuration' });
    assert.equal(f.actions.length, 0); assert.equal(f.claims.length, 0); assert.equal(logs.length, 0);
  } finally { await f.close(); }
});
