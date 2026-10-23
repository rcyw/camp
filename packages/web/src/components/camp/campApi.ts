import api from "../../api/client";
import type {
  CampArtifact, CampBudget, CampCandidate, CampCleanupState, CampFinalSummary,
  CampGoalStatus, CampMetrics, CampNegotiatedProtocol, CampPlan, CampQuestion, CampResultManifest,
  CampRole, CampRunStatus, CampTaskKind, CampTaskRequirements, CampTaskStatus,
  CampWorkItem, CampWorkerCompatibility, CampWorkerDeclaration, CampWorkflow,
  CampChangeSet, CampOperationStatus, CampVerificationPolicy, CampVerificationPolicySnapshot, CampVerificationReceipt,
  CampPreflightReport, CampPlanMode, CampIntegrationInput, CampIntegrationReceipt,
} from "../../../../camp-protocol/src/index.js";

// Keep component imports stable while the wire contract has one definition.
export type {
  CampArtifact, CampBudget, CampCandidate, CampCleanupState, CampCompletion,
  CampFinalSummary, CampGoalStatus, CampMetrics, CampNegotiatedProtocol, CampPlan, CampPlanItem,
  CampQuestion, CampQuestionStatus, CampReference, CampResultManifest,
  CampReview, CampReviewRecord, CampReviewTarget, CampRole, CampRunStatus,
  CampTaskKind, CampTaskRequirements, CampTaskStatus, CampWorkItem,
  CampWorkerCompatibility, CampWorkerDeclaration, CampWorkflow,
  CampChangeSet, CampChangeEntry, CampChangeSide, CampOperationStatus,
  CampVerificationPolicy, CampVerificationPolicySnapshot, CampVerificationReceipt,
  CampPreflightReport, CampPreflightCheck, CampPreflightCheckId,
  CampPlanMode, CampIntegrationInput, CampIntegrationReport, CampIntegrationReceipt,
} from "../../../../camp-protocol/src/index.js";
export type CampStatus = CampRunStatus;
export type CampResult = CampResultManifest;
export type CampOutcome = NonNullable<CampArtifact["outcome"]>;

// Public room projections remain browser DTOs, composed from shared domain types.
export interface CampGoal {
  id: string;
  roomId: string;
  title: string;
  description: string | null;
  status: CampGoalStatus;
  reason: string | null;
  attempt: number;
  budget: CampBudget;
  usage: { runs: number; reviewRounds: number; elapsedSeconds: number };
  activeRuns: number;
  canRetry: boolean;
  canCancel: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workflow?: CampWorkflow;
  planMode?: CampPlanMode;
  protocolVersion?: number | null;
  verificationPolicy?: CampVerificationPolicySnapshot | null;
  verification?: CampGoalVerification;
  integration?: CampGoalIntegration;
  integrationInspectionRequired?: boolean;
  resultReady?: boolean;
  baseHeadRevision?: number;
  fromGoalId?: string | null;
  currentCandidate?: CampCandidate | null;
  baseCandidate?: CampCandidate | null;
  finalCandidate?: CampCandidate | null;
  summary?: CampFinalSummary | null;
  plan?: CampPlan | null;
  items?: CampWorkItem[];
  questions?: CampQuestion[];
  metrics?: CampMetrics;
}
export interface CampRoom {
  id: string;
  channelId: string;
  name: string;
  project: { name: string; repoPath?: string; baseRef?: string; storePath?: string };
  roles: Array<{ role: CampRole; agentId: string; instructions?: string }>;
  acceptedHead?: { revision: number; goalId: string | null; candidate: CampCandidate | null };
  verificationPolicy?: CampVerificationPolicySnapshot | null;
}
export interface CampTask {
  id: string;
  goalId?: string | null;
  goalAttempt?: number;
  title: string;
  role: CampRole;
  executionStatus: CampTaskStatus;
  kind?: CampTaskKind;
  planItemKey?: string | null;
  dependsOn: string[];
}
export interface CampRun {
  id: string;
  goalId?: string | null;
  goalAttempt?: number;
  taskId: string | null;
  role: CampRole | null;
  executor?: "agent" | "verification" | "integration";
  operationId?: string | null;
  epoch: number;
  status: CampRunStatus;
  leaseExpiresAt?: string;
  summary: string | null;
  error: string | null;
  sessionId: string | null;
  cancelRequestedAt?: string | null;
  cleanupState?: CampCleanupState;
  outcome?: CampOutcome | null;
  artifacts: CampArtifact[];
  taskKind?: CampTaskKind;
  planItemKey?: string | null;
  inputCandidate?: CampCandidate | null;
  candidate?: CampCandidate | null;
  workerProtocol?: CampNegotiatedProtocol | null;
}
export type CampVerificationReceiptSummary = Omit<CampVerificationReceipt, "checks"> & {
  checks: Array<Omit<CampVerificationReceipt["checks"][number], "argv" | "stdout" | "stderr">>;
};
export interface CampVerificationOperation {
  id: string;
  goalId: string;
  goalAttempt: number;
  kind: "verification";
  inputCandidate: CampCandidate;
  policyDigest: string;
  status: CampOperationStatus;
  attempt: number;
  infrastructureFailures: number;
  createdAt: string;
  latestRunId: string | null;
  receipt: CampVerificationReceiptSummary | null;
}
export interface CampGoalVerification {
  required: boolean;
  policyDigest: string | null;
  status: "not_required" | "not_run" | "pending" | "running" | "passed" | "failed" | "cancelled" | "blocked";
  repairsUsed: number;
  maxRepairAttempts: number;
  operations: CampVerificationOperation[];
}
export interface CampIntegrationOperation {
  id: string;
  goalId: string;
  goalAttempt: number;
  kind: "integration";
  status: CampOperationStatus;
  attempt: number;
  infrastructureFailures: number;
  createdAt: string;
  latestRunId: string | null;
  integrationInput: CampIntegrationInput;
  inputDigest: string;
  integrationReport: CampIntegrationReceipt | null;
}
export interface CampGoalIntegration {
  required: boolean;
  status: "not_required" | "pending" | "queued" | "running" | "merged" | "conflict" | "rejected" | "failed" | "cancelled" | "blocked";
  operations: CampIntegrationOperation[];
}
export interface CampVersion {
  id: string;
  runId: string | null;
  kind: "baseline" | "run" | "integration";
  candidate: CampCandidate;
  taskKind: null | "build" | "integration";
  operationId?: string | null;
  planItemKey: string | null;
  goalAttempt: number;
  createdAt: string;
  status: string;
  changeSetAvailable: boolean;
}
export interface CampVersionChanges {
  available: boolean;
  reason: string | null;
  runId: string;
  candidate: CampCandidate;
  changeSet: CampChangeSet | null;
}
export interface CampVersionVerification {
  status: "pending" | "running" | "passed" | "failed" | "cancelled" | "blocked" | "unavailable";
  operationId: string | null;
  receipt: CampVerificationReceipt | null;
}
export interface CampWorkerRecord {
  workerId: string;
  declaration: CampWorkerDeclaration | null;
  compatibility: CampWorkerCompatibility | null;
  requirements: CampTaskRequirements | null;
  lastSeenAt: string;
  lastClaimAt: string | null;
  lastRunId: string | null;
  preflight?: CampReadiness | null;
}
export interface CampReadiness {
  selfReported: true;
  observedAt: string;
  workerId: string;
  projectDigest: string;
  report: CampPreflightReport;
}
export interface CampSetup {
  projectDigest: string;
  projectMutable: boolean;
  readiness: CampReadiness | null;
}
export interface CampSnapshot {
  room: CampRoom;
  /** Optional while a browser reloads across a server migration. */
  goals?: CampGoal[];
  defaultBudget?: { serial: CampBudget; legacy: CampBudget };
  supportedPlanModes?: CampPlanMode[];
  questions?: CampQuestion[];
  canSubmit?: boolean;
  canManage?: boolean;
  roomBusy?: boolean;
  workers?: CampWorkerRecord[];
  operations?: Array<CampVerificationOperation | CampIntegrationOperation>;
  setup?: CampSetup;
  tasks: CampTask[];
  runs: CampRun[];
  events: Array<{ id: string; seq: number; runId: string | null; type: string; content: string; createdAt: string }>;
}

export const campApi = {
  async roomForChannel(channelId: string, signal?: AbortSignal): Promise<CampRoom | null> {
    const { data } = await api.get<{ rooms: CampRoom[] }>("/camp/rooms", { params: { channelId }, signal });
    return data.rooms.find(room => room.channelId === channelId) ?? null;
  },
  async snapshot(roomId: string, signal?: AbortSignal): Promise<CampSnapshot> {
    return (await api.get<CampSnapshot>(`/camp/rooms/${roomId}`, { signal })).data;
  },
  async create(channelId: string, name: string, project: CampRoom["project"]): Promise<CampRoom> {
    return (await api.post<CampRoom>("/camp/rooms", { channelId, name, project })).data;
  },
  async submit(roomId: string, title: string, description: string, budget?: CampBudget, fromGoalId?: string, planMode?: CampPlanMode): Promise<void> {
    await api.post(`/camp/rooms/${roomId}/tasks`, { title, description, ...(budget ? { budget } : {}), ...(fromGoalId ? { fromGoalId } : {}), ...(planMode ? { planMode } : {}) });
  },
  async cancel(roomId: string, runId: string): Promise<void> {
    await api.post(`/camp/rooms/${roomId}/runs/${runId}/cancel`);
  },
  async retryGoal(roomId: string, goalId: string, expectedAttempt: number): Promise<CampSnapshot> {
    return (await api.post<CampSnapshot>(`/camp/rooms/${roomId}/goals/${goalId}/retry`, { expectedAttempt })).data;
  },
  async cancelGoal(roomId: string, goalId: string): Promise<CampSnapshot> {
    return (await api.post<CampSnapshot>(`/camp/rooms/${roomId}/goals/${goalId}/cancel`, {})).data;
  },
  async workerToken(roomId: string): Promise<{ token: string; expiresAt: string }> {
    return (await api.post<{ token: string; expiresAt: string }>(`/camp/rooms/${roomId}/worker-token`)).data;
  },
  async answerQuestion(roomId: string, questionId: string, answer: string): Promise<void> {
    await api.post(`/camp/rooms/${roomId}/questions/${questionId}/answer`, { answer });
  },
  async result(roomId: string, goalId: string): Promise<CampResult> {
    return (await api.get<CampResult>(`/camp/rooms/${roomId}/goals/${goalId}/result`)).data;
  },
  async verificationPolicy(roomId: string, policy: CampVerificationPolicy | null, expectedDigest: string | null): Promise<CampSnapshot> {
    return (await api.put<CampSnapshot>(`/camp/rooms/${roomId}/verification-policy`, { policy, expectedDigest })).data;
  },
  async project(roomId: string, project: CampRoom["project"], expectedDigest: string): Promise<CampSnapshot> {
    return (await api.put<CampSnapshot>(`/camp/rooms/${roomId}/project`, { project, expectedDigest })).data;
  },
  async versions(roomId: string, goalId: string, signal?: AbortSignal): Promise<{ versions: CampVersion[]; reason: string | null }> {
    return (await api.get<{ versions: CampVersion[]; reason: string | null }>(`/camp/rooms/${roomId}/goals/${goalId}/versions`, { signal })).data;
  },
  async versionChanges(roomId: string, goalId: string, runId: string, signal?: AbortSignal): Promise<CampVersionChanges> {
    return (await api.get<CampVersionChanges>(`/camp/rooms/${roomId}/goals/${goalId}/versions/${encodeURIComponent(runId)}/changes`, { signal })).data;
  },
  async versionVerification(roomId: string, goalId: string, runId: string, signal?: AbortSignal): Promise<CampVersionVerification> {
    return (await api.get<CampVersionVerification>(`/camp/rooms/${roomId}/goals/${goalId}/versions/${encodeURIComponent(runId)}/verification`, { signal })).data;
  },
};

function campErrorData(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || !("response" in error)) return null;
  const response = error.response;
  if (!response || typeof response !== "object" || !("data" in response)) return null;
  const data = response.data;
  if (!data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}

export function campErrorCode(error: unknown): string | null {
  const data = campErrorData(error);
  return typeof data?.code === "string" ? data.code : null;
}

export function campError(error: unknown): string | null {
  const data = campErrorData(error);
  if (!data) return null;
  if ("error" in data && typeof data.error === "string") return data.error;
  if ("message" in data && typeof data.message === "string") return data.message;
  return null;
}
