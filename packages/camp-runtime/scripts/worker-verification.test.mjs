import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal } from '../src/durable-state.mjs';
import { recoverWorker } from '../src/worker-recovery.mjs';
import { serverProtocol, getTaskRequirements, checkWorkerCompatibility, serializeVerificationPolicy, parseVerificationReport } from '../../camp-protocol/src/index.js';
import { unmatchedTaskKind } from '../src/worker-protocol.mjs';

const candidate = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'layer', refId: `32${'c'.repeat(64)}`, layerId: `32${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
const policy = { id: 'core', revision: 1, name: 'Fixed checks', maxRepairAttempts: 1, checks: [{ id: 'test', label: 'Tests', argv: ['node', '--test'], timeoutMs: 1000 }] };
const digest = createHash('sha256').update(serializeVerificationPolicy(policy)).digest('hex');
const report = parseVerificationReport({ candidate, policyDigest: digest, checks: [{ id: 'test', argv: ['node', '--test'], exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 5, stdout: 'passed', stderr: '', outputTruncated: false }] });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-verifier-worker-'));
  const workerId = `verifier-${randomUUID()}`;
  const actions = [], completions = [], declarations = [];
  const run = { id: randomUUID(), executor: 'verification', operationId: randomUUID(), taskId: null, role: null, agentId: null, roomId: 'room', goalId: 'goal', goalAttempt: 1, epoch: 1, leaseExpiresAt: new Date(Date.now() + 45000).toISOString(), workflow: 'serial', protocolVersion: 2, taskKind: 'verification', inputCandidate: candidate, goalBaseline: candidate, baseRef: candidate.refId, verificationPolicy: { policy, digest }, project: {} };
  const state = { run: { ...run, workerId, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  const runtime = { home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}`, folder: join(home, runId) }), async prepareProject() { return { projectId: candidate.projectId, imageId: candidate.imageId }; }, async cleanupAttempt() { actions.push('cleanup'); }, async prepareRun() { assert.fail('verification must not launch an agent LayerFS workspace'); } };
  let allocated = false;
  const route = async (path, body) => {
    if (path === '/protocol') return serverProtocol();
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path === '/claim') {
      declarations.push(body.protocol);
      if (allocated) return { run: null, compatibility: null, requirements: null };
      allocated = true;
      const requirements = getTaskRequirements(run);
      run.workerProtocol = { version: 2, declaration: body.protocol, requirements };
      return { run, requirements, compatibility: checkWorkerCompatibility(body.protocol, requirements) };
    }
    if (path.endsWith('/heartbeat')) return { run, cancelRequested: state.run.cancelRequested };
    if (path.endsWith('/state')) return state;
    if (path.endsWith('/complete')) {
      actions.push('complete'); completions.push(body);
      if (body.status === 'completed') {
        assert.deepEqual(Object.keys(body).sort(), ['epoch', 'inputCandidate', 'status', 'summary', 'verification', 'workerId'].sort());
        assert.deepEqual(parseVerificationReport(body.verification), report);
      }
      state.run.status = body.status; state.leaseValid = false;
      return { replayed: false };
    }
    if (path.endsWith('/cleanup')) return { cleanupState: 'confirmed' };
    throw new Error(`Unexpected verification request ${path}`);
  };
  const env = { CAMP_API_URL: 'http://unused.invalid', CAMP_WORKER_TOKEN: 'fixture-only', CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', CAMP_DSH_PLUGIN: '/missing-plugin', CAMP_MODEL_MAX_REQUESTS: '-1' };
  return { home, env, runtime, route, state, run, actions, completions, declarations, admitExecution: async () => {}, checkCapacity: async () => {}, log: () => {}, createSession() { assert.fail('verification must not start ACP or import DSH'); }, createChangeSet() { assert.fail('verification completion must not publish a changeSet'); }, async close() { await rm(home, { recursive: true, force: true }); } };
}

test('real HTTP keyless roleless worker submits only the backend verification completion fields', async () => {
  const f = await fixture();
  let handlerError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const result = await f.route(req.url.slice('/api/camp/worker'.length), chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { handlerError = error; res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  f.env.CAMP_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await startWorker({ ...f, verifyCandidate: async ({ onResult, candidate: actual }) => { assert.deepEqual(actual, candidate); await onResult(report); return report; } });
    if (handlerError) throw handlerError;
    assert.equal(f.completions.length, 1);
    assert.match(f.completions[0].summary, /verification finished/);
    assert.doesNotMatch(f.completions[0].summary, /verification passed/);
    assert.deepEqual(f.declarations[0].taskKinds, ['verification', 'integration']);
    assert.ok(f.actions.indexOf('cleanup') < f.actions.indexOf('complete'));
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    const [record] = await journal.list();
    assert.equal(record.executor, 'verification'); assert.equal(record.phase, 'settled');
    assert.deepEqual(record.completion.payload, f.completions[0]);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('verification cancellation stops execution, cleans resources and never submits a successful report', async () => {
  const f = await fixture();
  try {
    await startWorker({ ...f, request: f.route, heartbeatIntervalMs: 5, verifyCandidate: async ({ signal }) => {
      f.state.run.cancelRequested = true;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    assert.equal(f.completions.length, 1); assert.equal(f.completions[0].status, 'cancelled');
    assert.equal('verification' in f.completions[0], false);
    assert.ok(f.actions.indexOf('cleanup') < f.actions.indexOf('complete'));
  } finally { await f.close(); }
});

test('a prepared verification outbox replays its exact report after server commit and response loss', async () => {
  const f = await fixture();
  try {
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready();
    const record = await journal.recordClaim(f.run, { runtime: f.runtime.runIdentity(`${f.run.id}-e1`) });
    const payload = { workerId: f.env.CAMP_WORKER_ID, epoch: 1, status: 'completed', summary: 'Saved trusted report', inputCandidate: candidate, verification: report };
    await journal.stageCompletion(record, payload);
    f.state.run.status = 'completed'; f.state.leaseValid = false;
    await recoverWorker({ journal, runtime: f.runtime, request: f.route });
    assert.deepEqual(f.completions, [payload]);
    const [stored] = await journal.list(); assert.equal(stored.phase, 'settled'); assert.equal(stored.cleanupKnown, true);
  } finally { await f.close(); }
});

test('a persistent keyless HTTP worker waits across plan, verification and final review without exiting', async () => {
  const f = await fixture(), signalSource = new EventEmitter(), events = [];
  delete f.env.CAMP_WORKER_ONCE;
  let phase = 'plan', handlerError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const path = req.url.slice('/api/camp/worker'.length), body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      let result;
      if (path === '/claim' && phase !== 'verification') {
        const taskKind = phase === 'plan' ? 'plan' : 'final_review';
        const requirements = getTaskRequirements({ ...f.run, taskKind, inputCandidate: phase === 'plan' ? null : candidate });
        result = { run: null, requirements, compatibility: checkWorkerCompatibility(body.protocol, requirements) };
        if (phase === 'plan') phase = 'verification'; else signalSource.emit('SIGTERM');
      } else {
        result = await f.route(path, body);
        if (path.endsWith('/complete')) phase = 'final_review';
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { handlerError = error; res.writeHead(500).end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); f.env.CAMP_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await startWorker({ ...f, signalSource, log: event => events.push(event), verifyCandidate: async ({ onResult }) => { await onResult(report); return report; } });
    if (handlerError) throw handlerError;
    assert.equal(f.completions.length, 1); assert.equal(f.completions[0].status, 'completed');
    assert.deepEqual(events.filter(event => event.event === 'worker_waiting_for_task_kind').map(event => event.requiredTaskKind), ['plan', 'final_review']);
    assert.equal(events.some(event => event.event === 'worker_protocol_rejected'), false);
    const journal = await new WorkerJournal({ home: f.home, apiUrl: f.env.CAMP_API_URL, workerId: f.env.CAMP_WORKER_ID }).ready(); assert.equal(await journal.pendingClaim(), null);
  } finally { signalSource.emit('SIGTERM'); await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('specialized idle never conceals a missing same-kind harness or unsupported protocol', () => {
  const declaration = { protocolVersions: [2], taskKinds: ['verification'] };
  const incompatible = { status: 'incompatible', code: 'capability_missing', missingHarnesses: ['operator'] };
  assert.equal(unmatchedTaskKind({ compatibility: incompatible, requirements: { protocolVersion: 2, taskKind: 'verification' } }, declaration), false);
  assert.equal(unmatchedTaskKind({ compatibility: { ...incompatible, code: 'protocol_unsupported' }, requirements: { protocolVersion: 99, taskKind: 'plan' } }, declaration), false);
  assert.equal(unmatchedTaskKind({ compatibility: incompatible, requirements: { protocolVersion: 2, taskKind: 'unknown' } }, declaration), false);
});
