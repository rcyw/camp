import assert from 'node:assert/strict';
import { parseCandidate } from '../../packages/camp-protocol/src/index.js';

/** A capture must inspect the delivered candidate, which may be a later
 * whole-goal repair rather than the original trusted integration result. */
export function candidateIdentity(value) {
  const candidate = parseCandidate(value);
  return JSON.stringify([candidate.projectId, candidate.imageId, candidate.refKind, candidate.refId, candidate.rootId]);
}

export function selectCapturedDelivery({ goal, manifest, versions, acceptedHead }) {
  assert.ok(goal.status === 'completed' && goal.resultReady === true && manifest.status === 'completed' && manifest.resultReady === true, 'Capture requires an accepted completed delivery');
  assert.ok(manifest.schemaVersion === 1 && manifest.roomId === goal.roomId && manifest.goalId === goal.id, 'The delivery manifest must belong to the captured room and goal');
  if (manifest.goalAttempt !== undefined) assert.equal(manifest.goalAttempt, goal.attempt, 'The delivery manifest must preserve the current goal attempt');
  if (manifest.planMode !== undefined) assert.equal(manifest.planMode, goal.planMode, 'The delivery manifest must preserve the frozen plan mode');
  const candidate = parseCandidate(manifest.candidate), identity = candidateIdentity(candidate);
  assert.equal(candidateIdentity(goal.finalCandidate), identity, 'The manifest must identify the final accepted candidate');
  if (acceptedHead?.goalId === goal.id) {
    assert.equal(candidateIdentity(acceptedHead.candidate), identity, 'The current room head must match this goal’s delivery');
    if (Number.isSafeInteger(goal.baseHeadRevision)) assert.equal(acceptedHead.revision, goal.baseHeadRevision + 1, 'Accepting this goal advances the room revision exactly once');
  }
  // Versions are returned oldest first. Equal-content/no-op producers remain
  // separate facts: choose the newest producer, never the baseline row.
  const version = [...versions].reverse().find(value => value.kind !== 'baseline' && value.runId && candidateIdentity(value.candidate) === identity);
  assert.ok(version, 'The exact delivered candidate needs a producing run in version history');
  return { candidate, version };
}
