import { CampProtocolError, parseCandidate } from "../../../../camp-protocol/src/index.js";
import { CampError, type CampArtifact, type CampCandidate, type CampCompletion, type CampTaskKind } from "./types";

/** Legacy dependencies may annotate a single parent repeatedly, never merge
 * several parents by whichever artifact happened to be returned last. */
export function selectDependencyCandidate(artifacts: CampArtifact[]): CampArtifact | null {
  const parents = artifacts.filter(value => value.type === "layerfs" && typeof (value.refId ?? value.commitId ?? value.layerId) === "string");
  let selected: CampArtifact | null = null;
  const ref = (value: CampArtifact) => value.refId ?? value.commitId ?? value.layerId;
  const complete = (value: CampArtifact) => { try { return candidateIdentity(value); } catch { return null; } };
  for (const parent of parents) {
    if (selected && (ref(selected) !== ref(parent) || ["projectId", "rootId", "imageId"].some(field => selected![field] !== undefined && parent[field] !== undefined && selected![field] !== parent[field]))) throw new CampError(409, "ambiguous_input_candidate", "Dependencies contain different workspace candidates; select one explicit input instead of an implicit merge");
    if (!selected || (!complete(selected) && complete(parent))) selected = parent;
  }
  return selected;
}

export function candidateIdentity(value: unknown): CampCandidate {
  if (!value || typeof value !== "object") throw new CampError(409, "candidate_required", "The trusted worker must attest the input and output candidate");
  try { return parseCandidate(value, { requireTagged: false, allowLegacy: true }); }
  catch (error) {
    if (error instanceof CampProtocolError) throw new CampError(error.status, error.code, error.message);
    throw error;
  }
}
export function sameCandidate(left: CampCandidate | null | undefined, right: CampCandidate | null | undefined) {
  return Boolean(left && right && left.projectId === right.projectId && left.refKind === right.refKind && left.refId === right.refId && left.rootId === right.rootId && (!left.imageId || !right.imageId || left.imageId === right.imageId));
}
export function sameReviewTarget(left: unknown, right: unknown) {
  const identity = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const target = value as Record<string, unknown>, refId = target.refId ?? target.commitId ?? target.layerId;
    if (typeof target.projectId !== "string" || typeof refId !== "string" || (target.commitId !== undefined && target.commitId !== refId) || (target.layerId !== undefined && target.layerId !== refId) || (target.refKind === "layer" && target.commitId !== undefined) || (target.refKind === "commit" && target.layerId !== undefined)) return null;
    return { projectId: target.projectId, refId, refKind: target.refKind };
  };
  const a = identity(left), b = identity(right);
  return Boolean(a && b && a.projectId === b.projectId && a.refId === b.refId && (!a.refKind || !b.refKind || a.refKind === b.refKind));
}
export function completionCandidates(expected: CampCandidate | null, kind: CampTaskKind, input: CampCompletion) {
  const baseline = candidateIdentity(input.inputCandidate);
  const candidate = candidateIdentity(input.candidate);
  if (expected && !sameCandidate(expected, baseline)) throw new CampError(409, "input_candidate_mismatch", "The worker input does not match the server-selected parent");
  if (candidate.projectId !== baseline.projectId || (candidate.imageId && baseline.imageId && candidate.imageId !== baseline.imageId)) throw new CampError(409, "candidate_project_mismatch", "Candidate output belongs to another project or runtime image");
  if (candidate.baseRef && candidate.baseRef !== baseline.refId) throw new CampError(409, "candidate_parent_mismatch", "The output must originate from the selected input reference");
  if (kind !== "build" && candidate.rootId !== baseline.rootId) throw new CampError(409, "readonly_candidate_changed", "This task may inspect and report but cannot change the accepted workspace content");
  return { inputCandidate: baseline, candidate };
}
