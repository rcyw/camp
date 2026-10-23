import { createHash } from "node:crypto";
import { parseChangeSet, parseIntegrationReport, parseVerificationReport } from "../../../../camp-protocol/src/index.js";
import { candidateIdentity } from "./candidates";
import { CampError, type CampCompletion } from "./types";

/** Hash the accepted request, not projections or artifacts added by the server.
 * Missing optional fields and their existing wire defaults are equivalent. */
export function completionFingerprint(input: CampCompletion): string {
  const value = {
    status: input.status, summary: input.summary, artifacts: input.artifacts ?? [],
    sessionId: input.sessionId ?? null, error: input.error ?? null, outcome: input.outcome ?? null,
    inputCandidate: input.inputCandidate ? candidateIdentity(input.inputCandidate) : null,
    candidate: input.candidate ? candidateIdentity(input.candidate) : null,
    questionId: input.questionId ?? null,
    changeSet: input.changeSet ? parseChangeSet(input.changeSet) : null,
    verification: input.verification ? parseVerificationReport(input.verification) : null,
    ...(input.integration === undefined ? {} : { integration: parseIntegrationReport(input.integration) }),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  } catch { throw new CampError(400, "invalid_completion", "Completion annotations must be bounded JSON data"); }
  return createHash("sha256").update(serialized).digest("hex");
}
