import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal } from '../src/durable-state.mjs';
import { createWorkerDeclaration, serverProtocol, getTaskRequirements } from '../../camp-protocol/src/index.js';
const compatibility = { status: 'compatible', code: 'compatible', protocolVersion: 1, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] };

async function fixture({ clarification, cancelDuringStop = false, foreignQuestion = false, modelError = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'camp-yield-'));
  const workerId = `yield-test-${randomUUID()}`;
  const env = { CAMP_API_URL: 'http://127.0.0.1', CAMP_WORKER_TOKEN: 'local-only', DEEPSEEK_API_KEY: 'local-only', CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', CAMP_RUN_TIMEOUT_MS: '10000' };
  const input = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'layer', refId: `32${'c'.repeat(64)}`, layerId: `32${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
  const claim = { id: 'run', roomId: 'room', role: clarification ? 'planner' : 'builder', taskId: 'task', epoch: 1, workflow: 'serial', taskKind: clarification ? 'clarification' : 'build', inputCandidate: input, baseRef: input.refId, workerProtocol: createWorkerDeclaration(), prompt: 'Never completes its turn', project: {}, runToken: 'scoped', leaseExpiresAt: new Date(Date.now() + 45_000).toISOString() };
  claim.protocolVersion = 1;
  claim.workerProtocol = { version: 1, declaration: createWorkerDeclaration(), requirements: getTaskRequirements(claim) };
  const question = { id: 'question', status: 'pending', activeRunId: foreignQuestion ? 'old-run' : claim.id, content: 'Which acceptance boundary?', toRole: 'planner' };
  const assignedQuestion = { id: 'assigned-question', status: clarification, answer: 'Keep the public API stable.', escalationReason: 'A product decision is required.' };
  const state = { run: { ...claim, workerId, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  let supplied = false, stopped = false, stops = 0, snapshots = 0, started = false;
  const actions = [], completions = [], logs = [];
  const runtime = {
    home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}` }),
    async prepareProject() { return input; }, async prepareRun() { return { runId: 'runtime-run', containerId: 'fake', workspacePath: '/workspace' }; },
    async pinInputCandidate() { return input; }, async installDsh() {}, async installPlugin() {}, async sandboxHostAddress() { return '127.0.0.1'; }, async sandboxApiUrl() { return 'http://127.0.0.1'; }, launchSpec() { return {}; },
    async quiesceAgent() { assert.ok(stopped); actions.push('quiesce'); },
    async archiveSession() { assert.ok(stopped); assert.ok(actions.includes('quiesce')); actions.push('archive'); },
    async commitCandidate() { assert.ok(stopped, 'no snapshot while DSH is running'); snapshots++; return { ...input, baseRef: input.refId }; },
    async releaseRun() { assert.ok(stopped); actions.push('release'); }, async abortRun() { assert.ok(stopped); actions.push('abort'); }, async cleanupAttempt() {},
  };
  const request = async (path, body) => {
    actions.push(path);
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path === '/protocol') return serverProtocol();
    if (path === '/claim') { if (supplied) return { run: null, compatibility }; supplied = true; return { run: claim, compatibility }; }
    if (path.endsWith('/heartbeat')) return { run: claim, cancelRequested: state.run.cancelRequested };
    if (path.endsWith('/context')) { assert.ok(started); return clarification ? { assignedQuestion, blockingQuestion: null } : { blockingQuestion: question }; }
    if (path.endsWith('/state')) return state;
    if (path.endsWith('/complete')) { completions.push(body); state.run.status = body.status; state.leaseValid = false; return { replayed: false }; }
    return {};
  };
  const createSession = () => {
    const session = new EventEmitter();
    session.start = async () => { started = true; if (modelError) session.emit('runtime_event', { kind: 'error', message: 'Actual model failure' }); return { ok: true }; };
    session.stop = async () => {
      stops++;
      // ACP cancellation/exit alone is not proof the outer process has stopped.
      session.emit('runtime_event', { kind: 'turn_end', reason: 'cancelled' });
      session.emit('exit', 0);
      if (cancelDuringStop) state.run.cancelRequested = true;
      await delay(40);
      stopped = true;
      actions.push('quiescent');
    };
    return session;
  };
  return { home, env, runtime, request, createSession, admitExecution: async () => {}, checkCapacity: async () => {}, heartbeatIntervalMs: 10, actions, completions, logs, snapshots: () => snapshots, stops: () => stops, log: entry => logs.push(entry), async close() { await rm(home, { recursive: true, force: true }); } };
}

test('durable current-run question forces a never-ending model to yield after process quiescence', async () => {
  const f = await fixture();
  try {
    await startWorker(f);
    assert.equal(f.stops(), 1);
    assert.equal(f.snapshots(), 1);
    assert.equal(f.completions.length, 1);
    const completion = f.completions[0];
    assert.equal(completion.status, 'suspended');
    assert.equal(completion.questionId, 'question');
    assert.equal(completion.summary, 'Waiting for planner: Which acceptance boundary?');
    assert.ok(completion.inputCandidate && completion.candidate);
    assert.ok(f.actions.indexOf('quiescent') < f.actions.indexOf('release'));
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    assert.deepEqual((await journal.list())[0].completion.payload, completion);
    assert.equal(f.logs.find(entry => entry.event === 'controlled_yield').questionId, 'question');
  } finally { await f.close(); }
});
test('cancellation during controlled stop wins over question suspension and snapshot', async () => {
  const f = await fixture({ cancelDuringStop: true });
  try {
    await startWorker(f);
    assert.equal(f.stops(), 1);
    assert.equal(f.snapshots(), 0);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'cancelled');
    assert.equal(f.completions[0].questionId, undefined);
    assert.ok(f.actions.includes('abort'));
  } finally { await f.close(); }
});
for (const clarification of ['answered', 'awaiting_human']) test(`clarification ${clarification} stops an otherwise waiting model and settles a meaningful reply`, async () => {
  const f = await fixture({ clarification });
  try {
    await startWorker(f);
    assert.equal(f.stops(), 1);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'completed');
    assert.equal(f.completions[0].questionId, undefined);
    assert.match(f.completions[0].summary, clarification === 'answered' ? /Answer from planner: Keep the public API stable/ : /Waiting for human: A product decision/);
  } finally { await f.close(); }
});
for (const mode of ['foreignQuestion', 'modelError']) test(`${mode} cannot be relabeled as controlled suspension`, async () => {
  const f = await fixture({ [mode]: true });
  try {
    await startWorker(f);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, 'failed');
    assert.equal(f.completions[0].error, 'dsh_execution_failed');
    assert.equal(f.snapshots(), 0);
  } finally { await f.close(); }
});
