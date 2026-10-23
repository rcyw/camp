import { CampError } from "./types";

export const CAMP_ARTIFACTS_MAX_BYTES = 128 * 1024;
export const CAMP_REPORTED_ARTIFACTS_MAX_BYTES = 64 * 1024;
export const CAMP_REPORTED_ARTIFACTS_MAX_COUNT = 30;
export function assertCompletionArtifactBudget(artifacts: unknown[]) {
  if (Buffer.byteLength(JSON.stringify(artifacts)) > CAMP_ARTIFACTS_MAX_BYTES) throw new CampError(400, "artifact_budget_exhausted", "The combined completion annotations exceed 128 KiB");
}
export function assertReportedArtifactBudget(artifacts: unknown[]) {
  if (artifacts.length > CAMP_REPORTED_ARTIFACTS_MAX_COUNT || Buffer.byteLength(JSON.stringify(artifacts)) > CAMP_REPORTED_ARTIFACTS_MAX_BYTES) throw new CampError(400, "artifact_budget_exhausted", "A run may report at most 30 annotations and 64 KiB in total");
}
