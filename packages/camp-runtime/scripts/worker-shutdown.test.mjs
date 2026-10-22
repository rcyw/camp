import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal, acquireWorkerLock } from '../src/durable-state.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve: value => resolve(value) };
}

/** This fixture runs the real worker and real kernel lock, with no ACP child,
 * Docker/LayerFS operation, provider request, or external API connection. */
async function fixture({ holdSecondHeartbeat = false, queueProgress = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'camp-shutdown-'));
  const workerId = `shutdown-test-${randomUUID()}`;
  const signalSource = new EventEmitter();
  const sessionStarted = deferred();
  const secondHeartbeatEntered = deferred();
  const secondHeartbeatReply = deferred();
  const firstProgressEntered = deferred();
  const firstProgressReply = deferred();
  const completionAcknowledged = deferred();
  const initialLease = new Date(Date.now() + 45_000).toISOString();
  const laterLease = new Date(Date.now() + 90_000).toISOString();
  const env = {
    CAMP_API_URL: 'http://127.0.0.1', CAMP_WORKER_TOKEN: 'fixture-worker-capability',
    DEEPSEEK_API_KEY: 'fixture-unused-provider-key', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', CAMP_RUN_TIMEOUT_MS: '20000',
  };
  const claim = { id: 'run-shutdown', roomId: 'room-fixture', role: 'planner', taskId: 'task-fixture', epoch: 1,
    prompt: 'Injected event emitter only', project: {}, runToken: 'fixture-run-capability', leaseExpiresAt: initialLease };
  const state = { run: { ...claim, workerId, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  const actions = [], progress = [], completions = [];
  let claimed = false, heartbeats = 0;
  const runtime = {
    home, runIdentity: runId => ({ runId, prefix: `fixture-prefix-${runId}` }),
    async prepareProject() { actions.push('prepare-project'); return {}; },
    async prepareRun() { return { runId: 'run-shutdown-e1', containerId: 'fixture', workspacePath: '/fixture' }; },
    async installDsh() {}, async installPlugin() {},
    async sandboxApiUrl() { return 'http://127.0.0.1'; }, launchSpec() { return {}; },
    async archiveSession() { throw new Error('An interrupted turn must not be archived as complete'); },
    async commitCandidate() { throw new Error('An interrupted turn must not produce a candidate'); },
    async releaseRun() { throw new Error('An interrupted turn must use abort cleanup'); },
    async abortRun() { actions.push('abort'); }, async cleanupAttempt() { actions.push('cleanup'); },
  };
  const request = async (path, body) => {
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path === '/claim') { if (claimed) return { run: null }; claimed = true; return { run: claim }; }
    if (path.endsWith('/heartbeat')) {
      heartbeats += 1;
      if (holdSecondHeartbeat && heartbeats === 2) {
        secondHeartbeatEntered.resolve();
        await secondHeartbeatReply.promise;
        actions.push('heartbeat-reply');
        return { run: { ...claim, leaseExpiresAt: laterLease }, cancelRequested: false };
      }
      return { run: claim, cancelRequested: false };
    }
    if (path.endsWith('/events') && body.type === 'progress') {
      progress.push(body.content);
      if (queueProgress && progress.length === 1) { firstProgressEntered.resolve(); await firstProgressReply.promise; }
      return {};
    }
    if (path.endsWith('/state')) return state;
    if (path.endsWith('/complete')) {
      completions.push(body); state.run.status = body.status; state.leaseValid = false;
      return { replayed: false };
    }
    return {};
  };
  const createSession = () => {
    const session = new EventEmitter();
    session.start = async () => {
      sessionStarted.resolve();
      if (queueProgress) for (const text of ['Queued milestone A', 'Queued milestone B', 'Queued milestone C']) {
        session.emit('runtime_event', { kind: 'text', text });
      }
      return { ok: true };
    };
    session.stop = async () => { actions.push('session-stop'); };
    return session;
  };
  const log = event => { if (event.event === 'completion_acknowledged') completionAcknowledged.resolve(); };
  return { home, workerId, env, runtime, request, createSession, signalSource, log, actions, progress, completions,
    initialLease, laterLease, sessionStarted, secondHeartbeatEntered, secondHeartbeatReply,
    firstProgressEntered, firstProgressReply, completionAcknowledged,
    async close() { await rm(home, { recursive: true, force: true }); },
  };
}

test('SIGTERM drains an already running periodic heartbeat before releasing its worker flock', { timeout: 20_000 }, async t => {
  // A rejected fetch would expose an unexpected provider/API path in this fixture.
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network is allowed in the worker shutdown fixture'); });
  const f = await fixture({ holdSecondHeartbeat: true });
  let returned = false;
  const worker = startWorker(f).then(() => { returned = true; });
  worker.catch(() => {});
  try {
    await f.sessionStarted.promise;
    // Exercise a periodic refresh after execution began. Holding the first
    // heartbeat would also block startup in the buggy implementation.
    await f.secondHeartbeatEntered.promise;
    f.signalSource.emit('SIGTERM');
    await f.completionAcknowledged.promise;
    await delay(20);
    assert.equal(returned, false, 'Worker must wait for its pending journal writer before returning');
    await assert.rejects(acquireWorkerLock(f.workerId), /already running/);
    f.secondHeartbeatReply.resolve();
    await worker;
    const nextOwner = await acquireWorkerLock(f.workerId);
    await nextOwner.release();
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.workerId }).ready();
    const [record] = await journal.list();
    assert.equal(record.leaseExpiresAt, f.laterLease, 'Last heartbeat write must finish while the old lock is owned');
    assert.equal(record.phase, 'settled');
    assert.equal(record.completion.payload.error, 'worker_shutdown');
    assert.equal(network.mock.callCount(), 0);
  } finally {
    f.signalSource.emit('SIGTERM');
    f.secondHeartbeatReply.resolve();
    await worker;
    await f.close();
  }
});

test('SIGTERM drops queued ordinary progress after the current request settles and preserves one failure completion', { timeout: 10_000 }, async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network is allowed in the worker shutdown fixture'); });
  const f = await fixture({ queueProgress: true });
  const worker = startWorker(f);
  worker.catch(() => {});
  try {
    await f.firstProgressEntered.promise;
    await f.sessionStarted.promise;
    f.signalSource.emit('SIGTERM');
    f.firstProgressReply.resolve();
    await worker;
    assert.equal(f.progress.length, 1, 'Only the request already in flight may be sent after stopping');
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'failed');
    assert.equal(f.completions[0].error, 'worker_shutdown');
    assert.ok(f.actions.includes('abort'));
    assert.equal(network.mock.callCount(), 0);
  } finally {
    f.signalSource.emit('SIGTERM');
    f.firstProgressReply.resolve();
    await worker;
    await f.close();
  }
});
