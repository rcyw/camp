import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campEvents, campGoals, campRooms, campRuns, campTasks } from "../../db/schema";
import { createTasks, forceUpdateTaskStatus } from "../taskService";
import { CampError, DEFAULT_CAMP_BUDGET, type CampBudget, type CampGoalAttemptSummary } from "./types";

type Goal = typeof campGoals.$inferSelect;
type Room = typeof campRooms.$inferSelect;
export function normalizeBudget(input?: Partial<CampBudget>): CampBudget {
  const budget = { ...DEFAULT_CAMP_BUDGET, ...input };
  for (const [name, maximum] of [["maxRuns", 100], ["maxReviewRounds", 20], ["maxDurationSeconds", 86400]] as const) {
    if (!Number.isSafeInteger(budget[name]) || budget[name] < 1 || budget[name] > maximum) throw new CampError(400, "invalid_budget", `${name} must be an integer between 1 and ${maximum}`);
  }
  return budget;
}

export async function createAttemptTasks(tx: DatabaseExecutor, room: Room, goal: Goal, creatorType: "user" | "agent", creatorId: string, dependencies: string[] = []) {
  return createTasks(room.channelId, creatorType, creatorId, goal.roles.map(role => ({ title: `${role}: ${goal.title}`, description: goal.description ?? undefined })), {
    beforeCommit: async (executor, created) => {
      let previous = dependencies;
      for (const [index, task] of created.tasks.entries()) {
        await executor.insert(campTasks).values({ taskId: task.id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role: goal.roles[index], dependsOn: previous });
        previous = [task.id];
      }
    },
  });
}

export async function blockQueuedTasks(tx: DatabaseExecutor, room: Room, goal: Goal, status: "blocked" | "cancelled" = "blocked") {
  const queued = await tx.select().from(campTasks).where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt), eq(campTasks.status, "queued")));
  for (const binding of queued) {
    const actor = room.roles.find(role => role.role === binding.role)?.agentId;
    const result = await forceUpdateTaskStatus(binding.taskId, "closed", actor ? "agent" : "user", actor ?? goal.createdByUserId);
    if (typeof result === "string") throw new CampError(409, "task_changed", result);
    await tx.update(campTasks).set({ status }).where(eq(campTasks.taskId, binding.taskId));
  }
}

/** A stopped goal never leaves runnable descendants behind. Running sandboxes
 * remain running until the worker acknowledges cleanup or their lease expires. */
export async function stopGoal(tx: DatabaseExecutor, room: Room, goal: Goal, reason: string, cancelled = false) {
  const active = await tx.select({ id: campRuns.id }).from(campRuns).innerJoin(campTasks, eq(campTasks.taskId, campRuns.taskId))
    .where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt), eq(campRuns.status, "running")));
  if (active.length) await tx.update(campRuns).set({ cancelRequestedAt: sql`coalesce(${campRuns.cancelRequestedAt}, clock_timestamp())` }).where(inArray(campRuns.id, active.map(run => run.id)));
  await blockQueuedTasks(tx, room, goal, cancelled ? "cancelled" : "blocked");
  const status = cancelled ? active.length ? "cancelling" : "cancelled" : "needs_attention";
  await tx.update(campGoals).set({ status, reason, completedAt: active.length ? null : sql`clock_timestamp()` }).where(eq(campGoals.id, goal.id));
  if (goal.status !== status || goal.reason !== reason) await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, type: status, content: reason });
}

export async function refreshGoal(tx: DatabaseExecutor, room: Room, goalId: string) {
  const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, goalId), eq(campGoals.roomId, room.id)));
  if (!goal) throw new CampError(409, "goal_missing", "The task's goal is unavailable");
  const bindings = await tx.select().from(campTasks).where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt)));
  const active = bindings.some(task => task.status === "running");
  if (goal.status === "cancelling") {
    if (!active) await tx.update(campGoals).set({ status: "cancelled", completedAt: sql`clock_timestamp()` }).where(eq(campGoals.id, goal.id));
    return;
  }
  if (goal.status === "needs_attention" || goal.status === "cancelled") {
    await blockQueuedTasks(tx, room, goal, goal.status === "cancelled" ? "cancelled" : "blocked");
    if (!active && !goal.completedAt) await tx.update(campGoals).set({ completedAt: sql`clock_timestamp()` }).where(eq(campGoals.id, goal.id));
    return;
  }
  if (bindings.some(task => ["failed", "cancelled", "blocked"].includes(task.status))) {
    await stopGoal(tx, room, goal, bindings.some(task => task.status === "failed") ? "run_failed" : "dependency_blocked");
  } else if (bindings.length && bindings.every(task => task.status === "completed")) {
    await tx.update(campGoals).set({ status: "completed", reason: null, completedAt: sql`clock_timestamp()` }).where(eq(campGoals.id, goal.id));
  } else {
    await tx.update(campGoals).set({ status: goal.startedAt ? "running" : "queued" }).where(eq(campGoals.id, goal.id));
  }
}

export async function goalSnapshots(roomId: string, administrator: boolean) {
  const goals = await getDb().select().from(campGoals).where(eq(campGoals.roomId, roomId)).orderBy(asc(campGoals.createdAt), asc(campGoals.id));
  const active = await getDb().select({ goalId: campTasks.goalId, goalAttempt: campTasks.goalAttempt }).from(campRuns).innerJoin(campTasks, eq(campTasks.taskId, campRuns.taskId))
    .where(and(eq(campRuns.roomId, roomId), eq(campRuns.status, "running")));
  return goals.map(goal => {
    const activeRuns = active.filter(run => run.goalId === goal.id && run.goalAttempt === goal.attempt).length;
    const elapsedSeconds = goal.startedAt ? Math.max(0, Math.floor(((goal.completedAt?.getTime() ?? Date.now()) - goal.startedAt.getTime()) / 1000)) : 0;
    return { ...goal, usage: { runs: goal.runCount, reviewRounds: goal.reviewRounds, elapsedSeconds }, activeRuns,
      canRetry: administrator && goal.attempt < 100 && activeRuns === 0 && ["needs_attention", "cancelled"].includes(goal.status),
      canCancel: administrator && ["queued", "running"].includes(goal.status) };
  });
}

export async function retryGoal(roomId: string, goalId: string, userId: string, expectedAttempt: number, budget?: Partial<CampBudget>) {
  const { withCampRoomAdmin } = await import("./rooms");
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, goalId), eq(campGoals.roomId, roomId))).for("update");
    if (!goal) throw new CampError(404, "goal_not_found", "Goal not found");
    if (goal.attempt !== expectedAttempt) throw new CampError(409, "goal_attempt_changed", "The goal attempt changed; refresh before retrying");
    if (goal.attempt >= 100) throw new CampError(409, "goal_attempt_limit", "This goal reached its 100 manual attempt limit; retain its history and submit a new goal");
    if (!["needs_attention", "cancelled"].includes(goal.status)) throw new CampError(409, "goal_not_retryable", "This goal is not waiting for an explicit retry");
    const [active] = await tx.select({ id: campRuns.id }).from(campRuns).innerJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).where(and(eq(campTasks.goalId, goalId), eq(campRuns.status, "running"))).limit(1);
    if (active) throw new CampError(409, "cleanup_pending", "Wait for the current attempt's worker cleanup before retrying");
    const previous: CampGoalAttemptSummary = { attempt: goal.attempt, budget: goal.budget, status: goal.status, reason: goal.reason, usage: { runs: goal.runCount, reviewRounds: goal.reviewRounds, elapsedSeconds: goal.startedAt ? Math.max(0, Math.floor(((goal.completedAt?.getTime() ?? Date.now()) - goal.startedAt.getTime()) / 1000)) : 0 }, startedAt: goal.startedAt?.toISOString() ?? null, deadlineAt: goal.deadlineAt?.toISOString() ?? null, completedAt: goal.completedAt?.toISOString() ?? null };
    const [next] = await tx.update(campGoals).set({ attempt: goal.attempt + 1, attemptHistory: [...goal.attemptHistory, previous], budget: normalizeBudget(budget ?? goal.budget), status: "queued", reason: null, runCount: 0, reviewRounds: 0, startedAt: null, deadlineAt: null, completedAt: null }).where(eq(campGoals.id, goalId)).returning();
    const result = await createAttemptTasks(tx, room, next, "user", userId, goal.initialDependsOn);
    await tx.insert(campEvents).values({ roomId, goalId, type: "goal_retried", content: `Human retry started attempt ${next.attempt}` });
    return { ...result, goalId };
  });
}

export async function cancelGoal(roomId: string, goalId: string, userId: string) {
  const { withCampRoomAdmin } = await import("./rooms");
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, goalId), eq(campGoals.roomId, roomId))).for("update");
    if (!goal) throw new CampError(404, "goal_not_found", "Goal not found");
    if (!["queued", "running", "cancelling"].includes(goal.status)) throw new CampError(409, "goal_already_stopped", "This goal has already stopped");
    await stopGoal(tx, room, goal, "cancelled_by_human", true);
  });
}
