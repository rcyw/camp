import type { CampRun, CampTask } from "./campApi";

export function leaseExpired(run: CampRun | undefined): boolean {
  return run?.status === "running" && run.leaseValid === false;
}

export function campRunStatusLabel(run: CampRun) {
  return run.status === "running" && run.cancelRequestedAt ? "camp.status.cancelling"
    : leaseExpired(run) ? "camp.status.leaseExpired" : `camp.status.${run.status}` as const;
}

type TaskStatusLabel = `camp.status.${CampTask["executionStatus"]}` | "camp.status.leaseExpired" | "camp.status.cancelling";

export function campTaskStatusLabel(task: CampTask, runs: CampRun[]): TaskStatusLabel {
  const active = runs.find(run => run.taskId === task.id && run.status === "running");
  return active?.cancelRequestedAt ? "camp.status.cancelling"
    : leaseExpired(active) ? "camp.status.leaseExpired"
    : `camp.status.${task.executionStatus}`;
}
