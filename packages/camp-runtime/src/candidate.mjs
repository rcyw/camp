import { parseCandidate } from '../../camp-protocol/src/index.js';

export const projectIdentity = /^p-[a-f0-9]{16}$/;

export function checkedCandidate(value, { projectId, imageId, requireImage = false, requireTagged = false } = {}) {
  return parseCandidate(value, { projectId, imageId, requireImage, requireTagged, allowLegacy: true, preserveExtras: true });
}

export function checkedManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.resultReady !== true || typeof manifest.roomId !== 'string' || typeof manifest.goalId !== 'string') throw new Error('A ready goal result manifest is required');
  return { ...manifest, candidate: checkedCandidate(manifest.candidate, { requireImage: true }) };
}
