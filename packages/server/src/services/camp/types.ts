/** Camp's worker protocol. The room credential stays on the trusted worker. */
import type { CampCandidate, CampTaskKind, CampWorkflow } from "./serialTypes";
export * from "./serialTypes";
import type { CampRole, CampBudget, CampGoalStatus, CampArtifact, CampNegotiatedProtocol, CampVerificationPolicySnapshot } from "../../../../camp-protocol/src/index.js";
export { CAMP_ROLES, DEFAULT_CAMP_BUDGET } from "../../../../camp-protocol/src/index.js";
export type { CampRole, CampBudget, CampGoalStatus, CampArtifact, CampReviewTarget, CampReview, CampCompletion, CampNegotiatedProtocol, CampWorkerDeclaration, CampTaskRequirements, CampWorkerCompatibility, CampVerificationPolicy, CampVerificationPolicySnapshot, CampVerificationReport, CampVerificationReceipt, CampChangeSet, CampPlanMode, CampIntegrationInput, CampIntegrationReport, CampIntegrationReceipt, CampExecutionPool } from "../../../../camp-protocol/src/index.js";
export type CampProject = { name: string; repoPath?: string; storePath?: string; baseRef?: string };
export type CampRoleConfig = { role: CampRole; agentId: string; instructions?: string };
export type CampGoalAttemptSummary = { attempt: number; budget: CampBudget; status: CampGoalStatus; reason: string | null; usage: { runs: number; reviewRounds: number; elapsedSeconds: number }; startedAt: string | null; deadlineAt: string | null; completedAt: string | null };
export type CampDependency = { taskId: string; summary: string; artifacts: CampArtifact[] };
export type CampReviewedItem = { key: string; runId: string; epoch: number; candidate: CampCandidate; reviewRunId: string };
export type CampAgentClaimedRun = {
  executor: "agent";
  operationId: null;
  id: string;
  taskId: string;
  roomId: string;
  goalId: string;
  goalAttempt: number;
  epoch: number;
  leaseExpiresAt: string;
  role: CampRole;
  agentId: string;
  prompt: string;
  project: CampProject;
  dependencies: CampDependency[];
  workflow: CampWorkflow;
  planMode: import("../../../../camp-protocol/src/index.js").CampPlanMode;
  protocolVersion: number | null;
  workerProtocol: CampNegotiatedProtocol | null;
  taskKind: Exclude<CampTaskKind, "verification" | "integration">;
  planItemKey: string | null;
  inputCandidate: CampCandidate | null;
  goalBaseline: CampCandidate | null;
  verificationPolicy: CampVerificationPolicySnapshot | null;
  baseRef: string;
  blockingQuestion: { id: string; content: string; status: string; [key: string]: unknown } | null;
  /** Current run only: cannot claim, renew a lease, or complete work. */
  runToken: string;
};
export type CampVerificationClaimedRun = {
  executor: "verification"; operationId: string; taskId: null; role: null; agentId: null; taskKind: "verification";
  id: string; roomId: string; goalId: string; goalAttempt: number; epoch: number; leaseExpiresAt: string;
  project: CampProject; workflow: "serial"; protocolVersion: number | null; workerProtocol: CampNegotiatedProtocol | null;
  inputCandidate: CampCandidate; goalBaseline: CampCandidate | null; baseRef: string; verificationPolicy: CampVerificationPolicySnapshot;
};
export type CampIntegrationClaimedRun = {
  executor: "integration"; operationId: string; taskId: null; role: null; agentId: null; taskKind: "integration";
  id: string; roomId: string; goalId: string; goalAttempt: number; epoch: number; leaseExpiresAt: string;
  project: CampProject; workflow: "serial"; protocolVersion: number; workerProtocol: CampNegotiatedProtocol;
  inputCandidate: CampCandidate; goalBaseline: CampCandidate; baseRef: string;
  integrationInput: import("../../../../camp-protocol/src/index.js").CampIntegrationInput; inputDigest: string;
};
export type CampClaimedRun = CampAgentClaimedRun | CampVerificationClaimedRun | CampIntegrationClaimedRun;
export type CampPrincipal =
  | { kind: "worker"; roomId: string; tokenId: string }
  | { kind: "run"; roomId: string; runId: string; epoch: number };
export class CampError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
