/** Camp's worker protocol. The room credential stays on the trusted worker. */
export const CAMP_ROLES = ["planner", "builder", "reviewer"] as const;
export type CampRole = typeof CAMP_ROLES[number];
export type CampProject = { name: string; repoPath?: string; storePath?: string; baseRef?: string };
export type CampRoleConfig = { role: CampRole; agentId: string; instructions?: string };
export type CampBudget = { maxRuns: number; maxReviewRounds: number; maxDurationSeconds: number };
export const DEFAULT_CAMP_BUDGET: CampBudget = { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 };
export type CampGoalStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "needs_attention";
export type CampGoalAttemptSummary = { attempt: number; budget: CampBudget; status: CampGoalStatus; reason: string | null; usage: { runs: number; reviewRounds: number; elapsedSeconds: number }; startedAt: string | null; deadlineAt: string | null; completedAt: string | null };
export type CampArtifact = {
  type: string;
  branch?: string;
  commitId?: string;
  rootId?: string;
  projectId?: string;
  runId?: string;
  sandboxId?: string;
  imageId?: string;
  baseRef?: string;
  profile?: string;
  [key: string]: unknown;
};
export type CampDependency = { taskId: string; summary: string; artifacts: CampArtifact[] };
export type CampReviewTarget = { projectId: string; commitId: string; branch?: string };
export type CampReview = { outcome: "approved" | "changes_requested"; evidence: string | string[]; summary: string; candidate?: CampReviewTarget };
export type CampCompletion = {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts?: CampArtifact[];
  sessionId?: string;
  error?: string;
  outcome?: "approved" | "changes_requested" | "handoff";
};
export type CampClaimedRun = {
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
  /** Current run only: cannot claim, renew a lease, or complete work. */
  runToken: string;
};
export type CampPrincipal =
  | { kind: "worker"; roomId: string; tokenId: string }
  | { kind: "run"; roomId: string; runId: string; epoch: number };
export class CampError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
