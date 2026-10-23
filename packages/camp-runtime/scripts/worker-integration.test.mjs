import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker } from '../src/worker.mjs';
import { recoverWorker } from '../src/worker-recovery.mjs';
import { WorkerJournal } from '../src/durable-state.mjs';
import { integrationCompletion } from '../src/integration-completion.mjs';
import { parseIntegrationInput, serializeIntegrationInput, parseIntegrationReport, serverProtocol, getTaskRequirements, checkWorkerCompatibility } from '../../camp-protocol/src/index.js';

const candidate = hex => ({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), imageId: 'sha256:' + 'b'.repeat(64), refKind: 'commit', refId: '12' + hex.repeat(64), commitId: '12' + hex.repeat(64), rootId: hex.repeat(64) });
const input = parseIntegrationInput({ schemaVersion: 1, algorithm: 'layerfs-three-way-v1', policy: 'reject-overlap-v1', base: candidate('c'), parents: [{ key: 'left', runId: randomUUID(), epoch: 1, candidate: candidate('d') }, { key: 'right', runId: randomUUID(), epoch: 2, candidate: candidate('e') }] });
const digest = createHash('sha256').update(serializeIntegrationInput(input)).digest('hex');
const merged = parseIntegrationReport({ schemaVersion: 1, inputDigest: digest, algorithm: input.algorithm, policy: input.policy, status: 'merged', candidate: candidate('f'), conflicts: [], truncated: false });
const changes = { schemaVersion: 1, base: input.base, target: merged.candidate, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } };

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-integration-worker-'));
  const env = { CAMP_API_URL: 'http://fixture.invalid', CAMP_WORKER_TOKEN: 'fixture-room-token', CAMP_WORKER_ID: randomUUID(), CAMP_WORKER_ONCE: '1', CAMP_DSH_PLUGIN: '/does-not-exist' };
  const events = [], completions = [], claims = [], logs = [];
  const run = { id: randomUUID(), roomId: randomUUID(), goalId: randomUUID(), goalAttempt: 1, executor: 'integration', operationId: randomUUID(), taskId: null, role: null, agentId: null, taskKind: 'integration', epoch: 1, protocolVersion: 3, workflow: 'serial', leaseExpiresAt: new Date(Date.now() + 45000).toISOString(), inputCandidate: input.base, goalBaseline: input.base, integrationInput: input, project: {} };
  const state = { run: { ...run, workerId: env.CAMP_WORKER_ID, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  const runtime = { home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}`, folder: join(home, runId) }), async prepareProject() { return { projectId: input.base.projectId, imageId: input.base.imageId }; }, async cleanupAttempt() { events.push('cleanup'); }, async prepareRun() { assert.fail('Integration cannot launch an agent workspace'); } };
  const journal = await new WorkerJournal({ home, apiUrl: env.CAMP_API_URL, workerId: env.CAMP_WORKER_ID }).ready();
  let allocated = false, integrations = 0;
  const options = { env, runtime, journal, admitExecution: async () => {}, checkCapacity: async () => {}, log: value => logs.push(value), createSession: () => assert.fail('Integration cannot start ACP'), createChangeSet: async () => changes,
    async integrateCandidates({ onIntent, onResult }) { integrations++; await onIntent(); await onResult(merged); return merged; },
    async request(path, body) {
      if (path === '/protocol') return serverProtocol();
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path === '/claim') { claims.push(body); if (allocated) return { run: null, requirements: null, compatibility: null }; allocated = true; const requirements = getTaskRequirements(run); run.workerProtocol = { version: 3, declaration: body.protocol, requirements }; return { run, requirements, compatibility: checkWorkerCompatibility(body.protocol, requirements) }; }
      if (path.endsWith('/heartbeat')) return { run, cancelRequested: state.run.cancelRequested };
      if (path.endsWith('/state')) return state;
      if (path.endsWith('/complete')) { assert.ok(events.includes('cleanup')); completions.push(body); state.run.status = body.status; state.leaseValid = false; return { replayed: completions.length > 1 }; }
      if (path.endsWith('/cleanup')) return { cleanupState: 'confirmed' };
      throw new Error('Unexpected fixture route');
    },
  };
  return { home, env, runtime, journal, run, state, options, events, completions, claims, logs, get integrations() { return integrations; }, async record() { return journal.recordClaim(run, { runtime: runtime.runIdentity(`${run.id}-e${run.epoch}`) }); }, close: () => rm(home, { recursive: true, force: true }) };
}

test('a keyless worker integrates and stages exact evidence before cleanup without ACP or a run token', async () => {
  const f = await fixture();
  try {
    await startWorker(f.options);
    assert.equal(f.integrations, 1); assert.equal(f.completions.length, 1);
    assert.deepEqual(f.claims[0].protocol.taskKinds, ['verification', 'integration']);
    assert.equal(f.completions[0].candidate.refId, merged.candidate.refId);
    const [record] = await f.journal.list(); assert.equal(record.phase, 'settled'); assert.equal(record.executor, 'integration');
    assert.deepEqual(f.completions[0], record.completion.payload);
    assert.ok(!JSON.stringify(record).includes(f.env.CAMP_WORKER_TOKEN));
  } finally { await f.close(); }
});

test('an integration conflict is an exact business result without a fallback candidate or Diff', async () => {
  const f = await fixture();
  try {
    const conflict = parseIntegrationReport({ ...merged, status: 'conflict', candidate: null, conflicts: [{ path: 'shared.js', reason: 'overlap' }] });
    f.options.createChangeSet = () => assert.fail('Conflict cannot compute a result Diff');
    f.options.integrateCandidates = async ({ onResult }) => { await onResult(conflict); return conflict; };
    await startWorker(f.options);
    assert.equal(f.completions[0].status, 'completed'); assert.equal(f.completions[0].integration.status, 'conflict');
    assert.equal('candidate' in f.completions[0], false); assert.equal('changeSet' in f.completions[0], false);
  } finally { await f.close(); }
});

test('cleanup interruption after a validated outbox replays that payload without merging twice', async () => {
  const f = await fixture();
  try {
    let merges = 0;
    f.options.integrateCandidates = async ({ onIntent, onResult }) => { merges++; await onIntent(); await onResult(merged); throw Object.assign(new Error('Result already staged; cleanup interrupted'), { cleanupKnown: false }); };
    await startWorker(f.options);
    const [record] = await f.journal.list(); assert.equal(merges, 1); assert.equal(record.phase, 'settled');
    assert.equal(f.completions.length, 1); assert.equal(createHash('sha256').update(JSON.stringify(f.completions[0])).digest('hex'), record.completion.digest);
  } finally { await f.close(); }
});

test('native uncertainty is reported as inspection required and blocks subsequent allocation', async () => {
  const f = await fixture();
  try {
    f.options.integrateCandidates = async ({ onIntent }) => { await onIntent(); throw Object.assign(new Error('Native outcome is unknown'), { requiresInspection: true, code: 'camp_integration_inspection_required' }); };
    await assert.rejects(startWorker(f.options), { code: 'camp_integration_inspection_required' });
    assert.equal(f.claims.length, 1); assert.equal(f.completions[0].error, 'camp_integration_inspection_required');
    const [record] = await f.journal.list(); assert.equal(record.requiresInspection, true); assert.equal(record.cleanupKnown, true);
  } finally { await f.close(); }
});

test('recovery rebuilds only fully persisted validated evidence and never invokes another merge', async () => {
  const f = await fixture();
  try {
    const record = await f.record();
    await f.journal.update(record, { integrationReport: merged, integrationChangeSet: changes, phase: 'integration_result_recorded' });
    await recoverWorker({ ...f.options, inspectIntegration: async () => ({ status: 'validated', report: merged }) });
    assert.equal(f.completions.length, 1); assert.deepEqual(f.completions[0], integrationCompletion(record));
    assert.equal(f.integrations, 0);
  } finally { await f.close(); }
});

test('native-only recovery cleans owned resources then fences unknown integration rather than retrying', async () => {
  const f = await fixture();
  try {
    const record = await f.record(); await f.journal.update(record, { phase: 'integrating' });
    await assert.rejects(recoverWorker({ ...f.options, inspectIntegration: async () => ({ status: 'requires_inspection', phase: 'merging' }) }), { code: 'camp_integration_inspection_required' });
    assert.equal(f.completions[0].error, 'camp_integration_inspection_required'); assert.equal(f.integrations, 0);
    const [retained] = await f.journal.list(); assert.equal(retained.requiresInspection, true); assert.equal(retained.cleanupKnown, true);
    assert.equal(f.claims.length, 0);
  } finally { await f.close(); }
});

test('inspection still permits an exact failed outbox and cleanup acknowledgement after a lost response', async () => {
  const f = await fixture();
  try {
    const record = await f.record();
    const payload = { workerId: f.env.CAMP_WORKER_ID, epoch: 1, status: 'failed', summary: 'Native operation requires inspection', error: 'camp_integration_inspection_required' };
    await f.journal.update(record, { cleanupKnown: true, requiresInspection: true, failureCompletion: payload });
    await f.journal.prepareCompletion(record, payload);
    const digestBefore = record.completion.digest;
    // Simulate a committed failure whose HTTP response never reached the host.
    f.events.push('cleanup'); f.state.run.status = 'failed'; f.state.leaseValid = false;
    await assert.rejects(recoverWorker(f.options), { code: 'camp_integration_inspection_required' });
    assert.deepEqual(f.completions, [payload]);
    const [stored] = await f.journal.list(); assert.equal(stored.completion.digest, digestBefore); assert.equal(stored.phase, 'settled'); assert.equal(stored.requiresInspection, true); assert.ok(stored.cleanupAck.acknowledgedAt);
    assert.equal(f.integrations, 0); assert.equal(f.claims.length, 0);
    await assert.rejects(recoverWorker(f.options), { code: 'camp_integration_inspection_required' });
    assert.equal(f.completions.length, 1);
  } finally { await f.close(); }
});

test('cancellation cannot erase native uncertainty from the persisted cancellation acknowledgement', async () => {
  const f = await fixture();
  try {
    const record = await f.record(); await f.journal.update(record, { phase: 'integrating' });
    f.state.run.cancelRequested = true;
    await assert.rejects(recoverWorker({ ...f.options, inspectIntegration: async () => ({ status: 'requires_inspection', phase: 'merging' }) }), { code: 'camp_integration_inspection_required' });
    assert.equal(f.completions.length, 1); assert.equal(f.completions[0].status, 'cancelled'); assert.equal(f.completions[0].error, 'camp_integration_inspection_required');
    const [retained] = await f.journal.list(); assert.equal(retained.requiresInspection, true); assert.equal(retained.completion.payload.status, 'failed'); assert.equal(retained.cancellationAck.payload.error, 'camp_integration_inspection_required');
    assert.equal(f.integrations, 0); assert.equal(f.claims.length, 0);
  } finally { await f.close(); }
});

test('cancellation after staging preserves the successful outbox and submits a separate cancellation', async () => {
  const f = await fixture();
  try {
    f.options.integrateCandidates = async ({ onResult }) => { await onResult(merged); f.state.run.cancelRequested = true; return merged; };
    await startWorker(f.options);
    assert.equal(f.completions[0].status, 'cancelled');
    const [record] = await f.journal.list(); assert.equal(record.completion.payload.status, 'completed'); assert.equal(record.cancellationAck.payload.status, 'cancelled');
    assert.equal(record.completion.digest, createHash('sha256').update(JSON.stringify(record.completion.payload)).digest('hex'));
  } finally { await f.close(); }
});
