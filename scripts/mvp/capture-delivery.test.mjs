import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCapturedDelivery } from './capture-delivery.mjs';

const base = { type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'a'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64) };
const candidate = hex => ({ ...base, refKind: 'commit', refId: '12' + hex.repeat(64), rootId: hex.repeat(64) });
const original = candidate('b'), repaired = candidate('c');
function fixture(final = repaired) {
  return { goal: { id: 'goal', roomId: 'room', status: 'completed', resultReady: true, attempt: 1, planMode: 'parallel_pair', finalCandidate: final, baseHeadRevision: 2 }, manifest: { schemaVersion: 1, goalId: 'goal', roomId: 'room', status: 'completed', resultReady: true, goalAttempt: 1, planMode: 'parallel_pair', candidate: final }, versions: [{ id: 'baseline', runId: null, kind: 'baseline', candidate: base }, { id: 'integration', runId: 'integration', kind: 'integration', candidate: original }, { id: 'repair', runId: 'repair', kind: 'run', candidate: final }], acceptedHead: { goalId: 'goal', revision: 3, candidate: final } };
}
test('a repaired delivery selects the final producer while the original integration remains separate evidence', () => {
  const selected = selectCapturedDelivery(fixture());
  assert.equal(selected.version.runId, 'repair'); assert.equal(selected.candidate.refId, repaired.refId);
});
test('an unchanged Layer delivery picks its latest producer rather than the baseline or an equal earlier output', () => {
  const value = fixture(base); value.versions[1] = { ...value.versions[1], candidate: base };
  assert.equal(selectCapturedDelivery(value).version.runId, 'repair');
  value.versions.pop(); assert.equal(selectCapturedDelivery(value).version.runId, 'integration');
});
test('a historical accepted result stays inspectable after another goal advances the room head', () => {
  const value = fixture(); value.acceptedHead = { goalId: 'newer-goal', revision: 4, candidate: original };
  assert.equal(selectCapturedDelivery(value).candidate.refId, repaired.refId);
});
test('mismatched final roots, room heads, attempts and missing producing evidence fail closed', () => {
  const final = fixture(); final.goal.finalCandidate = { ...repaired, rootId: 'd'.repeat(64) };
  assert.throws(() => selectCapturedDelivery(final), /final accepted candidate/);
  const head = fixture(); head.acceptedHead.candidate = original;
  assert.throws(() => selectCapturedDelivery(head), /room head/);
  const attempt = fixture(); attempt.manifest.goalAttempt = 2;
  assert.throws(() => selectCapturedDelivery(attempt), /goal attempt/);
  const missing = fixture(); missing.versions.pop();
  assert.throws(() => selectCapturedDelivery(missing), /producing run/);
});
