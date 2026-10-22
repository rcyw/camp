import type { CampRun, CampTask } from "./campApi";

export function leaseExpired(run: CampRun | undefined): boolean {
  return Boolean(run?.status === "running" && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= Date.now());
}

type TaskStatusLabel = `camp.status.${CampTask["executionStatus"]}` | "camp.status.leaseExpired" | "camp.status.cancelling";

export function campTaskStatusLabel(task: CampTask, runs: CampRun[]): TaskStatusLabel {
  const active = runs.find(run => run.taskId === task.id && run.status === "running");
  return leaseExpired(active) ? "camp.status.leaseExpired"
    : active?.cancelRequestedAt ? "camp.status.cancelling"
    : `camp.status.${task.executionStatus}`;
}
