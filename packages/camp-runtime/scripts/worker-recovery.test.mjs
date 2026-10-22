import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerJournal } from '../src/durable-state.mjs';
import { dispatchOutbox, recoverWorker } from '../src/worker-recovery.mjs';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-recover-'));
  const journal = await new WorkerJournal({ home, apiUrl: 'http://test', workerId: 'original-worker' }).ready();
  const runtime = { cleanups: [], runIdentity(runId) { return { runId, prefix: `prefix-${runId}` }; }, async cleanupAttempt(prefix) { this.cleanups.push(prefix); } };
  const record = await journal.recordClaim({ id: 'original-run', epoch: 3, roomId: 'room', role: 'builder' }, { runtime: runtime.runIdentity('original-run-e3') });
  const state = { run: { id: 'original-run', roomId: 'room', workerId: 'original-worker', epoch: 3, status: 'running', cancelRequested: false }, leaseValid: true, replaced: false };
  return { home, journal, runtime, record, state, async close() { await rm(home, { recursive: true, force: true }); } };
}

test('completion response lost after server commit is replayed exactly after journal reopen', async () => {
  const f = await fixture();
  try {
    await f.journal.update(f.record, { cleanupKnown: true });
    const payload = { workerId: 'original-worker', epoch: 3, status: 'completed', summary: 'the exact result' };
    await f.journal.prepareCompletion(f.record, payload);
    const bodies = [];
    let effects = 0;
    await assert.rejects(dispatchOutbox({ ...f, request: async (path, body) => { bodies.push(JSON.stringify(body)); if (effects === 0) effects++; throw new TypeError('response lost'); } }), error => error.completionOutcomeUnknown === true);
    const reopened = await new WorkerJournal({ home: f.home, apiUrl: 'http://test', workerId: 'original-worker' }).ready();
    const [record] = await reopened.list();
    f.state.run.status = 'completed';
    f.state.leaseValid = false;
    await dispatchOutbox({ journal: reopened, record, state: f.state, request: async (path, body) => { bodies.push(JSON.stringify(body)); return { replayed: true }; } });
    assert.equal(effects, 1);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(record.phase, 'settled');
    assert.equal(record.completion.payload.workerId, 'original-worker');
    assert.equal(record.completion.payload.epoch, 3);
  } finally { await f.close(); }
});

for (const reason of ['expired', 'replaced', 'new-epoch']) {
  test(`${reason} completion is fenced before any POST`, async () => {
    const f = await fixture();
    try {
      await f.journal.update(f.record, { cleanupKnown: true });
      await f.journal.prepareCompletion(f.record, { workerId: 'original-worker', epoch: 3, status: 'completed', summary: 'late' });
      if (reason === 'expired') f.state.leaseValid = false;
      if (reason === 'replaced') f.state.replaced = true;
      if (reason === 'new-epoch') f.state.run.epoch = 4;
      let calls = 0;
      assert.equal(await dispatchOutbox({ ...f, request: async () => { calls++; } }), 'fenced');
      assert.equal(calls, 0);
      assert.equal(f.record.phase, 'fenced');
    } finally { await f.close(); }
  });
}

test('a valid foreign owner is never killed or completed by reconciliation', async () => {
  const f = await fixture();
  try {
    f.state.run.workerId = 'other-worker';
    let posts = 0;
    await recoverWorker({ ...f, request: async (path, body) => { if (body) posts++; return path.startsWith('/reconcile') ? { runs: [] } : f.state; } });
    assert.deepEqual(f.runtime.cleanups, []);
    assert.equal(posts, 0);
    assert.equal((await f.journal.list())[0].phase, 'ownership_conflict');
  } finally { await f.close(); }
});

test('cancel recovery acknowledges only after owned sandbox removal', async () => {
  const f = await fixture();
  try {
    f.state.run.cancelRequested = true;
    await recoverWorker({ ...f, request: async (path, body) => {
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path.endsWith('/state')) return f.state;
      assert.deepEqual(f.runtime.cleanups, ['prefix-original-run-e3']);
      if (path.endsWith('/cleanup')) return { cleanupState: 'confirmed' };
      assert.equal(body.status, 'cancelled');
      return { replayed: false };
    } });
    assert.equal((await f.journal.list())[0].phase, 'settled');
  } finally { await f.close(); }
});

test('temporary API outage leaves journal pending and does not authorize cleanup', async () => {
  const f = await fixture();
  try {
    await assert.rejects(recoverWorker({ ...f, request: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); } }), /unavailable/);
    assert.deepEqual(f.runtime.cleanups, []);
    assert.equal((await f.journal.list())[0].phase, 'claimed');
  } finally { await f.close(); }
});

test('staged result survives crash during cleanup and is submitted after resource removal', async () => {
  const f = await fixture();
  try {
    const payload = { workerId: 'original-worker', epoch: 3, status: 'completed', summary: 'finished before cleanup', outcome: 'handoff', sessionId: 'original-session', artifacts: [{ type: 'layerfs', commitId: 'saved' }] };
    await f.journal.stageCompletion(f.record, payload);
    assert.equal(f.record.cleanupKnown, false);
    const journal = await new WorkerJournal({ home: f.home, apiUrl: 'http://test', workerId: 'original-worker' }).ready();
    let posts = 0;
    await recoverWorker({ ...f, journal, request: async (path, body) => {
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path.endsWith('/state')) return f.state;
      assert.deepEqual(f.runtime.cleanups, ['prefix-original-run-e3']);
      assert.deepEqual(body, payload);
      posts++;
      return { replayed: false };
    } });
    assert.equal(posts, 1);
    assert.equal((await journal.list())[0].phase, 'settled');
  } finally { await f.close(); }
});

test('staged success followed by cancellation has a separate replayable cancellation ack', async () => {
  const f = await fixture();
  try {
    const original = { workerId: 'original-worker', epoch: 3, status: 'completed', summary: 'immutable success' };
    await f.journal.stageCompletion(f.record, original);
    const digest = f.record.completion.digest;
    f.state.run.cancelRequested = true;
    const bodies = [];
    await assert.rejects(recoverWorker({ ...f, request: async (path, body) => {
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path.endsWith('/state')) return f.state;
      if (path.endsWith('/cleanup')) { f.state.cleanupState = 'confirmed'; return { cleanupState: 'confirmed' }; }
      bodies.push(JSON.stringify(body));
      assert.equal(body.status, 'cancelled');
      f.state.run.status = 'cancelled';
      f.state.leaseValid = false;
      throw new TypeError('cancel response lost after server committed');
    } }), error => error.completionOutcomeUnknown === true);
    const journal = await new WorkerJournal({ home: f.home, apiUrl: 'http://test', workerId: 'original-worker' }).ready();
    await recoverWorker({ ...f, journal, request: async (path, body) => {
      if (path.startsWith('/reconcile')) return { runs: [] };
      if (path.endsWith('/state')) return f.state;
      bodies.push(JSON.stringify(body));
      assert.equal(body.status, 'cancelled');
      return { replayed: true };
    } });
    const [record] = await journal.list();
    assert.deepEqual(record.completion.payload, original);
    assert.equal(record.completion.digest, digest);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(record.phase, 'settled');
    assert.equal(record.settlementStatus, 'cancelled');
    assert.ok(record.cancellationAck.acknowledgedAt);
  } finally { await f.close(); }
});

test('a pending cancel ack cannot reverse a terminal completion or replay old success', async () => {
  const f = await fixture();
  try {
    await f.journal.update(f.record, { cleanupKnown: true });
    await f.journal.stageCompletion(f.record, { workerId: 'original-worker', epoch: 3, status: 'completed', summary: 'original' });
    await f.journal.prepareCancellation(f.record);
    f.state.run.status = 'completed';
    f.state.leaseValid = false;
    let posts = 0;
    assert.equal(await dispatchOutbox({ ...f, request: async () => { posts++; } }), 'fenced');
    await recoverWorker({ ...f, request: async path => { assert.ok(path.startsWith('/reconcile')); return { runs: [] }; } });
    assert.equal(posts, 0);
    assert.ok(f.record.cancellationAck.fencedAt);
  } finally { await f.close(); }
});
