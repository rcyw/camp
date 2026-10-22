import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal, atomicJson } from '../src/durable-state.mjs';

async function fixture({ neverEnds = false, failTurn = false, droppedClaim = false, apiTransportFailure = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'camp-loop-'));
  const workerId = `loop-test-${randomUUID()}`;
  const env = { CAMP_API_URL: 'http://127.0.0.1', CAMP_WORKER_TOKEN: 'local-test-only', DEEPSEEK_API_KEY: 'local-test-only', CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', ...(neverEnds ? { CAMP_RUN_TIMEOUT_MS: '100' } : {}) };
  const claim = { id: 'run', roomId: 'room', role: 'planner', taskId: 'task', epoch: 1, prompt: 'test orchestration only', project: {}, runToken: 'scoped-token', leaseExpiresAt: new Date(Date.now() + 45_000).toISOString() };
  const state = { run: { ...claim, workerId, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  const actions = [], claims = [], completions = [];
  let supplied = false, stops = 0;
  const runtime = {
    home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}` }),
    async prepareProject() { return {}; },
    async prepareRun() { return { runId: 'run-e1', containerId: 'fake', workspacePath: '/workspace' }; },
    async installDsh() {}, async installPlugin() {},
    async sandboxApiUrl() { return 'http://127.0.0.1'; }, launchSpec() { return {}; }, async archiveSession() {},
    async commitCandidate() { return { type: 'layerfs', commitId: 'test-candidate', rootId: 'test-root' }; },
    async releaseRun() { actions.push('release'); }, async abortRun() { actions.push('abort'); }, async cleanupAttempt() { actions.push('cleanup'); },
  };
  const request = async (path, body) => {
    actions.push(path);
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path === '/claim') {
      claims.push(body);
      if (droppedClaim && claims.length === 1) throw new TypeError('claim response lost');
      if (supplied) return { run: null };
      supplied = true;
      return { run: claim };
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
  return { home, env, runtime, request, createSession, actions, claims, completions, stops: () => stops, async close() { await rm(home, { recursive: true, force: true }); } };
}

test('ambiguous claim is retried with the same intent before reconcile, then completes once', async () => {
  const f = await fixture({ droppedClaim: true });
  try {
    await startWorker({ ...f, log: () => {} });
    assert.deepEqual(f.claims[0], f.claims[1]);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'completed');
    const firstClaim = f.actions.indexOf('/claim');
    assert.equal(f.actions[firstClaim + 1], '/claim');
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
test('control API transport failure keeps infrastructure semantics without relabeling model failures', async () => {
  const f = await fixture({ apiTransportFailure: true });
  try {
    await startWorker({ ...f, log: () => {} });
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'failed');
    assert.equal(f.completions[0].error, 'worker_interrupted');
  } finally { await f.close(); }
});
