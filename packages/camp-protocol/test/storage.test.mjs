import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStoragePlan, serializeStoragePlan, parseStorageBackupReceipt, parseStorageRestoreReceipt } from '../src/index.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const candidate = { type: 'layerfs', projectId: 'p-0123456789abcdef', refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64) };
const plan = { schemaVersion: 1, operationId, roomId: '22222222-2222-4222-8222-222222222222', kind: 'migration', storageEpoch: 1, sourceStorageId: 'd'.repeat(64), acceptedRevision: 2, acceptedCandidate: candidate, projectId: candidate.projectId, candidates: [candidate] };
const receipt = { schemaVersion: 1, operationId, manifestDigest: 'e'.repeat(64), storeSha256: 'f'.repeat(64), bytes: 4096, toolchainDigest: '0'.repeat(64), imageId: candidate.imageId, candidateCount: 1, sourceStorageId: plan.sourceStorageId, stopped: true, verified: true };
const restored = { ...receipt, targetStorageId: '1'.repeat(64), verifiedCandidates: 1, historyVerified: true };

test('storage contracts preserve candidate identity and canonicalize plan replay', () => {
  const parsed = parseStoragePlan(plan);
  assert.equal(parsed.acceptedCandidate.refId, candidate.refId);
  assert.equal(parsed.candidates[0].rootId, candidate.rootId);
  assert.equal(serializeStoragePlan(parsed), serializeStoragePlan(plan));
  assert.deepEqual(parseStorageBackupReceipt(receipt), receipt);
  assert.deepEqual(parseStorageRestoreReceipt(restored), restored);
  const reused = { ...plan, backupOperationId: '33333333-3333-4333-8333-333333333333' };
  assert.equal(parseStoragePlan(reused).backupOperationId, reused.backupOperationId);
});

test('storage plan refuses ambiguous or incomplete frozen history', () => {
  for (const patch of [
    { storageEpoch: 0 }, { acceptedRevision: 0 }, { kind: 'online' }, { candidates: [] },
    { candidates: [candidate, candidate] }, { projectId: 'p-fedcba9876543210' },
    { candidates: [{ ...candidate, rootId: '0'.repeat(64) }] },
    { candidates: [{ ...candidate, imageId: 'sha256:' + '0'.repeat(64) }] },
    { candidates: Array.from({ length: 4097 }, () => candidate) },
    { operationId: '../secret' }, { sourceStorageId: 'not-a-hash' },
    { destination: '/host/private' },
    { backupOperationId: operationId }, { kind: 'backup', backupOperationId: '33333333-3333-4333-8333-333333333333' },
  ]) assert.throws(() => parseStoragePlan({ ...plan, ...patch }));
});

test('unverified, oversized and path-bearing receipts cannot become storage evidence', () => {
  for (const patch of [
    { stopped: false }, { verified: false }, { bytes: 0 }, { bytes: 1024 ** 4 + 1 },
    { bytes: NaN }, { candidateCount: 0 }, { candidateCount: 4097 },
    { manifestDigest: 'e'.repeat(63) }, { imageId: 'latest' },
    { apiToken: 'secret' }, { sourcePath: '/private/store.sqlite' },
  ]) assert.throws(() => parseStorageBackupReceipt({ ...receipt, ...patch }));
  for (const patch of [
    { targetStorageId: plan.sourceStorageId }, { verifiedCandidates: 0 },
    { historyVerified: false }, { verifiedCandidates: 2 }, { volume: 'arbitrary' },
  ]) assert.throws(() => parseStorageRestoreReceipt({ ...restored, ...patch }));
});
