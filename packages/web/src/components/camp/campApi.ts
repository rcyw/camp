import api from "../../api/client";

export type CampRole = "planner" | "builder" | "reviewer";
export type CampStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CampGoalStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "needs_attention";
export interface CampBudget { maxRuns: number; maxReviewRounds: number; maxDurationSeconds: number }
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
}
export type CampOutcome = "approved" | "changes_requested" | "handoff";
export interface CampArtifact {
  type: string;
  path?: string;
  summary?: string;
  evidence?: string | string[];
  candidate?: { projectId: string; commitId: string };
  outcome?: CampOutcome;
  branch?: string;
  commitId?: string;
  rootId?: string;
  sandboxId?: string;
  imageId?: string;
}
export interface CampRoom {
  id: string;
  channelId: string;
  name: string;
  project: { name: string; repoPath?: string; baseRef?: string };
  roles: Array<{ role: CampRole; agentId: string; instructions?: string }>;
}
export interface CampTask {
  id: string;
  goalId?: string | null;
  goalAttempt?: number;
  title: string;
  role: CampRole;
  executionStatus: CampStatus | "blocked";
  dependsOn: string[];
}
export interface CampRun {
  id: string;
  goalId?: string | null;
  goalAttempt?: number;
  taskId: string;
  role: CampRole;
  epoch: number;
  status: CampStatus;
  leaseExpiresAt?: string;
  summary: string | null;
  error: string | null;
  sessionId: string | null;
  cancelRequestedAt?: string | null;
  cleanupState?: "unknown" | "confirmed" | "pending";
  outcome?: CampOutcome | null;
  artifacts: CampArtifact[];
}
export interface CampSnapshot {
  room: CampRoom;
  /** Optional while a browser reloads across a server migration. */
  goals?: CampGoal[];
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
  async submit(roomId: string, title: string, description: string, budget?: CampBudget): Promise<void> {
    await api.post(`/camp/rooms/${roomId}/tasks`, { title, description, ...(budget ? { budget } : {}) });
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
};

export function campError(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("response" in error)) return null;
  const response = error.response;
  if (!response || typeof response !== "object" || !("data" in response)) return null;
  const data = response.data;
  if (!data || typeof data !== "object") return null;
  if ("error" in data && typeof data.error === "string") return data.error;
  if ("message" in data && typeof data.message === "string") return data.message;
  return null;
}
