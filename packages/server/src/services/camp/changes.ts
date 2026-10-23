import { and, asc, desc, eq, or } from "drizzle-orm";
import { getDb } from "../../db/index";
import { campGoals, campOperations, campRuns, campTasks } from "../../db/schema";
import { sameCandidate } from "./candidates";
import { CampError } from "./types";

async function goalInRoom(roomId: string, goalId: string) {
  const [goal] = await getDb().select().from(campGoals).where(and(eq(campGoals.id, goalId), eq(campGoals.roomId, roomId)));
  if (!goal) throw new CampError(404, "goal_not_found", "Goal not found");
  return goal;
}
async function producingRun(roomId: string, goalId: string, runId: string) {
  const goal = await goalInRoom(roomId, goalId);
  const [row] = await producers(roomId, goalId).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, roomId), producerScope(goalId)));
  if (!row || !row.run.candidate) throw new CampError(404, "version_not_found", "This producer version does not belong to the goal");
  return { goal, ...row };
}
const producerScope = (goalId: string) => or(and(eq(campRuns.executor, "agent"), eq(campTasks.goalId, goalId), eq(campTasks.kind, "build")), and(eq(campRuns.executor, "integration"), eq(campOperations.goalId, goalId), eq(campOperations.kind, "integration")));
const producers = (_roomId: string, _goalId: string) => getDb().select({ run: campRuns, binding: campTasks, operation: campOperations }).from(campRuns).leftJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).leftJoin(campOperations, eq(campOperations.id, campRuns.operationId));
export async function goalVersions(roomId: string, goalId: string) {
  const goal = await goalInRoom(roomId, goalId);
  const rows = await producers(roomId, goalId).where(and(eq(campRuns.roomId, roomId), producerScope(goalId))).orderBy(asc(campRuns.createdAt), asc(campRuns.id));
  const versions = rows.filter(row => row.run.candidate && row.run.status !== "running").map(({ run, binding, operation }) => ({ id: run.id, runId: run.id, kind: run.executor === "integration" ? "integration" as const : "run" as const, operationId: run.operationId, candidate: run.candidate!, taskKind: run.executor === "integration" ? "integration" as const : "build" as const, planItemKey: binding?.planItemKey ?? operation?.planItemKey ?? null, scope: operation?.scope ?? null, goalAttempt: binding?.goalAttempt ?? operation!.goalAttempt, createdAt: run.createdAt, status: run.status, changeSetAvailable: run.changeSet !== null }));
  return { versions: [...goal.baseCandidate ? [{ id: "baseline", runId: null, kind: "baseline" as const, candidate: goal.baseCandidate, taskKind: null, planItemKey: null, goalAttempt: goal.attempt, createdAt: goal.createdAt, status: "baseline", changeSetAvailable: false }] : [], ...versions], reason: goal.baseCandidate ? null : "baseline_unavailable" };
}
export async function versionChanges(roomId: string, goalId: string, runId: string) {
  const { run } = await producingRun(roomId, goalId, runId);
  return { available: run.changeSet !== null, reason: run.changeSet ? null : "change_set_unavailable", runId: run.id, candidate: run.candidate, changeSet: run.changeSet };
}
export async function versionVerification(roomId: string, goalId: string, runId: string) {
  const { goal, run, binding, operation: producer } = await producingRun(roomId, goalId, runId);
  const operations = await getDb().select().from(campOperations).where(and(eq(campOperations.kind, "verification"), eq(campOperations.goalId, goalId), eq(campOperations.goalAttempt, binding?.goalAttempt ?? producer!.goalAttempt))).orderBy(desc(campOperations.createdAt), desc(campOperations.id));
  const operation = operations.find(row => sameCandidate(row.inputCandidate, run.candidate) && row.verificationPolicy?.digest === goal.verificationPolicy?.digest);
  return { status: !operation ? "unavailable" : operation.status === "completed" ? operation.receipt?.status ?? "failed" : operation.status === "queued" ? "pending" : operation.status, operationId: operation?.id ?? null, receipt: operation?.receipt ?? null };
}
