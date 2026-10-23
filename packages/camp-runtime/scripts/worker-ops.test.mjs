import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkerJournal, acquireWorkerLock } from '../src/durable-state.mjs';
import { reapWorker } from '../src/worker-ops.mjs';

async function fixture(use) {
  const home = await mkdtemp(join(tmpdir(), 'camp-offline-reap-')), workerId = 'offline-' + randomUUID(), apiUrl = 'http://127.0.0.1:1';
  const resources = new Map(), calls = [];
  const runtime = { home, runIdentity: runId => { const hash = createHash('sha256').update(runId).digest('hex').slice(0, 16); return { runId, prefix: `camp-mvp-run-${hash}-`, folder: join(home, 'runs', hash) }; }, dockerCall: async args => { assert.equal(args[0], 'ps'); return { stdout: [...resources].map(([id, name]) => `${id} ${name}`).join('\n') }; }, cleanupAttempt: async prefix => { calls.push(prefix); for (const [id, name] of resources) if (name.startsWith(prefix)) resources.delete(id); } };
  const journal = await new WorkerJournal({ home, workerId, apiUrl }).ready(), id = randomUUID();
  const record = await journal.recordClaim({ id, epoch: 1, roomId: randomUUID(), role: 'builder' }, { runtime: runtime.runIdentity(`${id}-e1`) });
  resources.set('a'.repeat(64), record.runtime.prefix + 'project-0'); resources.set('b'.repeat(64), 'camp-mvp-run-0123456789abcdef-foreign-0');
  try { await use({ home, runtime, workerId, apiUrl, journal, record, resources, calls }); } finally { await rm(home, { recursive: true, force: true }); }
}
test('offline dry-run never rewrites a journal or removes owned and foreign containers', async () => fixture(async kit => {
  const before = await readFile(kit.journal.path(kit.record));
  const result = await reapWorker(kit);
  assert.equal(result.applied, false); assert.equal(result.apiContacted, false); assert.equal(result.attempts[0].action, 'eligible');
  assert.equal(result.unownedContainers.length, 1); assert.equal(kit.calls.length, 0); assert.deepEqual(await readFile(kit.journal.path(kit.record)), before);
}));
test('offline apply preserves the exact successful outbox, leaves foreign resources and defers API confirmation', async () => fixture(async kit => {
  await kit.journal.stageCompletion(kit.record, { workerId: kit.workerId, epoch: 1, status: 'completed', summary: 'Original successful result' });
  const outbox = JSON.stringify(kit.record.completion);
  const result = await reapWorker({ ...kit, apply: true });
  const [after] = await kit.journal.list();
  assert.equal(result.attempts[0].cleaned, true); assert.equal(kit.calls.length, 1); assert.equal(kit.resources.has('b'.repeat(64)), true);
  assert.equal(after.cleanupKnown, true); assert.equal(after.phase, 'completion_pending'); assert.equal(JSON.stringify(after.completion), outbox); assert.equal(after.cleanupAck, undefined);
}));
test('an active worker lock prevents offline apply without touching any resources', async () => fixture(async kit => {
  const lock = await acquireWorkerLock(kit.workerId);
  try { await assert.rejects(reapWorker({ ...kit, apply: true })); assert.equal(kit.calls.length, 0); } finally { await lock.release(); }
}));
test('a previously observed foreign owner is not permission for offline cleanup', async () => fixture(async kit => {
  await kit.journal.update(kit.record, { phase: 'ownership_conflict' });
  const before = await readFile(kit.journal.path(kit.record));
  const result = await reapWorker({ ...kit, apply: true });
  assert.equal(result.attempts[0].action, 'ownership_conflict'); assert.equal(result.attempts[0].cleaned, false);
  assert.equal(kit.calls.length, 0); assert.equal(kit.resources.size, 2); assert.deepEqual(await readFile(kit.journal.path(kit.record)), before);
}));
test('unknown native outcomes and conflicting journal identities fail closed', async () => fixture(async kit => {
  await kit.journal.update(kit.record, { requiresInspection: true });
  assert.equal((await reapWorker({ ...kit, apply: true })).attempts[0].action, 'requires_inspection'); assert.equal(kit.calls.length, 0);
  await kit.journal.update(kit.record, { runtime: { ...kit.record.runtime, prefix: 'camp-mvp-run-0123456789abcdef-' } });
  await assert.rejects(reapWorker({ ...kit, apply: true }), { code: 'camp_reap_identity' }); assert.equal(kit.calls.length, 0);
}));
