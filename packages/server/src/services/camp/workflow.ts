import { and, eq, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/index";
import { campFinalizations, campGoals, campPlans, campRooms, campRuns, campTasks, campOperations } from "../../db/schema";
import { createTasks } from "../taskService";
import { stopGoal } from "./goals";
import { enqueueVerification, needsVerification, requireVerificationGate } from "./verification";
import { enqueueIntegration, needsIntegration, recordReviewedItem, requireIntegrationGate } from "./integration";
import { sameCandidate } from "./candidates";
import { CampError, type CampCandidate, type CampPlanItem, type CampReview, type CampTaskKind, type CampWorkflow } from "./types";

type Room = typeof campRooms.$inferSelect;
type Goal = typeof campGoals.$inferSelect;
type Binding = typeof campTasks.$inferSelect;
type Run = typeof campRuns.$inferSelect;
const roleFor = (kind: Exclude<CampTaskKind, "verification" | "integration">) => kind === "plan" || kind === "summary" ? "planner" : kind === "build" ? "builder" : "reviewer";

export async function assertRoomAdmission(tx: DatabaseExecutor, room: Room, workflow: CampWorkflow, excludeGoalId?: string) {
  const goals = await tx.select().from(campGoals).where(and(eq(campGoals.roomId, room.id), excludeGoalId ? ne(campGoals.id, excludeGoalId) : undefined));
  const active = await tx.select({ goalId: sql<string>`coalesce(${campTasks.goalId}, ${campOperations.goalId})` }).from(campRuns).leftJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).leftJoin(campOperations, eq(campOperations.id, campRuns.operationId)).where(and(eq(campRuns.roomId, room.id), eq(campRuns.status, "running")));
  if (goals.some(goal => (workflow === "serial" || goal.workflow === "serial") && (["queued", "running", "waiting_question", "cancelling"].includes(goal.status) || active.some(run => run.goalId === goal.id)))) throw new CampError(409, "room_busy", "This Room already has an active delivery goal");
}

export async function enqueueStage(tx: DatabaseExecutor, room: Room, goal: Goal, input: { kind: Exclude<CampTaskKind, "verification" | "integration">; candidate: CampCandidate | null; predecessor?: string; item?: CampPlanItem; feedback?: string; role?: "planner" | "builder" | "reviewer"; questionId?: string }) {
  const role = input.role ?? roleFor(input.kind);
  const description = [
    `Original goal: ${goal.title}`, goal.description,
    input.item ? `Plan item ${input.item.key}: ${input.item.description}\nAcceptance: ${input.item.acceptance}\nVerification: ${input.item.verification}` : undefined,
    input.kind === "final_review" ? "Validate the complete original goal, all planned items, and the integrated candidate. Report concrete evidence with camp_review." : undefined,
    input.kind === "summary" ? "Summarize the delivered original goal with camp_finalize. Report evidence and remaining limitations. The workspace is read-only." : undefined,
    input.feedback,
  ].filter(Boolean).join("\n\n");
  const result = await createTasks(room.channelId, "user", goal.createdByUserId, [{ title: `${input.kind}: ${input.item?.title ?? goal.title}`.slice(0, 500), description }], {
    beforeCommit: async (executor, created) => {
      await executor.insert(campTasks).values({ taskId: created.tasks[0].id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role, kind: input.kind, planItemKey: input.item?.key, inputCandidate: input.candidate, questionId: input.questionId, dependsOn: input.predecessor ? [input.predecessor] : [] });
    },
  });
  return result.tasks[0].id;
}

export async function requireSerialCompletion(tx: DatabaseExecutor, goal: Goal, binding: Binding, review: CampReview | null) {
  if (binding.kind === "plan") {
    const [plan] = await tx.select().from(campPlans).where(and(eq(campPlans.goalId, goal.id), eq(campPlans.goalAttempt, goal.attempt), eq(campPlans.taskId, binding.taskId)));
    if (!plan) throw new CampError(409, "plan_required", "The planner must submit a valid ordered plan before completing");
  }
  if (["review", "final_review"].includes(binding.kind) && !review) throw new CampError(409, "review_required", "A structured candidate-bound verdict is required");
  if (binding.kind === "final_review" || binding.kind === "summary") { await requireIntegrationGate(tx, goal); if (binding.inputCandidate) await requireVerificationGate(tx, goal, binding.inputCandidate); }
  if (binding.kind === "summary") {
    const [finalization] = await tx.select().from(campFinalizations).where(and(eq(campFinalizations.goalId, goal.id), eq(campFinalizations.goalAttempt, goal.attempt), eq(campFinalizations.taskId, binding.taskId)));
    if (!finalization || !sameCandidate(finalization.candidate, goal.finalCandidate)) throw new CampError(409, "final_summary_required", "The planner must finalize the reviewed candidate before completion");
  }
}

/** Only the worker's attested single parent/output can drive the state machine.
 * Model artifacts never select a workspace or advance the Room accepted head. */
export async function advanceSerial(tx: DatabaseExecutor, room: Room, previousGoal: Goal, binding: Binding, run: Run, inputCandidate: CampCandidate, candidate: CampCandidate, review: CampReview | null) {
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, previousGoal.id));
  const [plan] = await tx.select().from(campPlans).where(and(eq(campPlans.goalId, goal.id), eq(campPlans.goalAttempt, goal.attempt)));
  if (!plan) throw new CampError(409, "plan_required", "The ordered plan is missing");
  const item = binding.planItemKey ? plan.items.find(value => value.key === binding.planItemKey) : undefined;
  const enqueue = async (kind: Exclude<CampTaskKind, "verification" | "integration">, parent: CampCandidate, nextItem?: CampPlanItem, feedback?: string) => {
    if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return; }
    if (["review", "final_review"].includes(kind) && goal.reviewRounds >= goal.budget.maxReviewRounds) { await stopGoal(tx, room, goal, "review_budget_exhausted"); return; }
    if (kind === "final_review" && needsVerification(goal)) { await enqueueVerification(tx, room, goal, parent); return; }
    await enqueueStage(tx, room, goal, { kind, candidate: parent, predecessor: binding.taskId, item: nextItem, feedback });
  };
  if (binding.kind === "plan") {
    await tx.update(campGoals).set({ baseCandidate: goal.baseCandidate ?? inputCandidate, currentCandidate: inputCandidate }).where(eq(campGoals.id, goal.id));
    await enqueue("build", inputCandidate, plan.items[0]);
  } else if (binding.kind === "build") {
    await tx.update(campGoals).set({ currentCandidate: candidate }).where(eq(campGoals.id, goal.id));
    await enqueue(binding.planItemKey ? "review" : "final_review", candidate, item);
  } else if (binding.kind === "review" || binding.kind === "final_review") {
    if (!review) throw new CampError(409, "review_required", "The review verdict is missing");
    await tx.update(campGoals).set({ currentCandidate: inputCandidate }).where(eq(campGoals.id, goal.id));
    if (review.outcome === "changes_requested") {
      if (goal.reviewRounds >= goal.budget.maxReviewRounds) { await stopGoal(tx, room, goal, "review_budget_exhausted"); return; }
      if (goal.runCount + (binding.kind === "final_review" ? needsVerification(goal) ? 4 : 3 : 2) > goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return; }
      await enqueue("build", inputCandidate, binding.kind === "review" ? item : undefined, `Address ${binding.kind === "final_review" ? "whole-goal" : "this item's"} review feedback:\n${review.summary}\nEvidence: ${JSON.stringify(review.evidence)}`);
    } else if (binding.kind === "final_review") {
      await tx.update(campGoals).set({ finalCandidate: inputCandidate }).where(eq(campGoals.id, goal.id));
      await enqueue("summary", inputCandidate);
    } else {
      const index = plan.items.findIndex(value => value.key === binding.planItemKey);
      if (index < 0) throw new CampError(409, "plan_item_missing", "The reviewed plan item is missing");
      if (goal.reviewRounds >= goal.budget.maxReviewRounds) { await stopGoal(tx, room, goal, "review_budget_exhausted"); return; }
      if (needsIntegration(goal)) {
        const reviewedItems = await recordReviewedItem(tx, goal, binding, run.id, inputCandidate);
        if (index + 1 < plan.items.length) {
          if (!goal.baseCandidate) throw new CampError(409, "integration_base_required", "The common immutable baseline is missing");
          await enqueue("build", goal.baseCandidate, plan.items[index + 1]);
        } else await enqueueIntegration(tx, room, goal, plan.items, reviewedItems);
      } else await enqueue(index + 1 < plan.items.length ? "build" : "final_review", inputCandidate, plan.items[index + 1]);
    }
  } else if (binding.kind === "summary") {
    const [finalization] = await tx.select().from(campFinalizations).where(and(eq(campFinalizations.goalId, goal.id), eq(campFinalizations.goalAttempt, goal.attempt), eq(campFinalizations.taskId, binding.taskId)));
    if (!finalization || !sameCandidate(finalization.candidate, inputCandidate) || !sameCandidate(goal.finalCandidate, inputCandidate)) throw new CampError(409, "final_summary_required", "The accepted candidate and final summary must agree");
    await requireIntegrationGate(tx, goal);
    await requireVerificationGate(tx, goal, inputCandidate);
    const [accepted] = await tx.update(campRooms).set({ acceptedRevision: goal.baseHeadRevision + 1, acceptedGoalId: goal.id, acceptedCandidate: inputCandidate }).where(and(eq(campRooms.id, room.id), eq(campRooms.acceptedRevision, goal.baseHeadRevision))).returning({ id: campRooms.id });
    if (!accepted) throw new CampError(409, "stale_baseline", "The Room accepted baseline changed before delivery");
    await tx.update(campGoals).set({ status: "completed", reason: null, summary: finalization.result, finalCandidate: inputCandidate, currentCandidate: inputCandidate, completedAt: sql`clock_timestamp()` }).where(eq(campGoals.id, goal.id));
  }
}
