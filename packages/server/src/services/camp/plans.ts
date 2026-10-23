import { parsePlanSubmission } from "../../../../camp-protocol/src/index.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campEvents, campFinalizations, campGoals, campPlans, campTasks } from "../../db/schema";
import { fencedRun, requireAgentRun } from "./runs";
import { candidateIdentity, sameCandidate } from "./candidates";
import { assertGoalDeadline } from "./goals";
import { CampError, type CampFinalSummary, type CampPlan, type CampPlanItem, type CampPrincipal } from "./types";

export type CampPluginInput = { epoch: number; workerId?: string; runId?: string };

export const bodyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function currentPlan(tx: DatabaseExecutor, goalId: string, attempt: number): Promise<CampPlan | null> {
  const [plan] = await tx.select().from(campPlans).where(and(eq(campPlans.goalId, goalId), eq(campPlans.goalAttempt, attempt)));
  return plan ? { revision: 1, summary: plan.summary, tasks: plan.items } : null;
}
export async function currentRunScope(tx: DatabaseExecutor, principal: CampPrincipal, runId: string, epoch: number, identity?: CampPluginInput) {
  if (identity?.runId !== undefined && identity.runId !== runId) throw new CampError(400, "run_identity_mismatch", "The request run identifier does not match the URL");
  const { room, run } = await fencedRun(tx, principal, runId, identity?.workerId, epoch);
  requireAgentRun(run);
  const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
  if (!goal || goal.attempt !== binding.goalAttempt || !["queued", "running"].includes(goal.status)) throw new CampError(409, "goal_attempt_changed", "The goal attempt is no longer active");
  await assertGoalDeadline(tx, goal.id);
  if (goal.workflow !== "serial") throw new CampError(409, "serial_workflow_required", "This operation belongs to a serial delivery workflow");
  if (goal.baseHeadRevision !== room.acceptedRevision) throw new CampError(409, "stale_baseline", "The Room accepted baseline changed");
  return { room, run, binding, goal };
}
function planBody(input: { planRevision: 1; summary: string; tasks: CampPlanItem[] }): CampPlan {
  const parsed = parsePlanSubmission({ planRevision: input.planRevision, summary: input.summary, tasks: input.tasks });
  return { revision: parsed.planRevision, summary: parsed.summary, tasks: parsed.tasks };
}
export async function submitPlan(principal: CampPrincipal, runId: string, input: CampPluginInput & { planRevision: 1; summary: string; tasks: CampPlanItem[] }) {
  return getDb().transaction(async tx => {
    const { room, run, binding, goal } = await currentRunScope(tx, principal, runId, input.epoch, input);
    if (binding.kind !== "plan" || run.role !== "planner") throw new CampError(403, "plan_task_required", "Only the current plan task can submit an ordered plan");
    const plan = planBody(input), hash = bodyHash(plan);
    if (["same_baseline_pair", "parallel_pair"].includes(goal.planMode) && plan.tasks.length !== 2) throw new CampError(400, "pair_plan_required", "A same-baseline pair requires exactly two independent plan items");
    const [existing] = await tx.select().from(campPlans).where(and(eq(campPlans.goalId, goal.id), eq(campPlans.goalAttempt, goal.attempt)));
    if (existing) {
      if (existing.bodyHash !== hash) throw new CampError(409, "plan_conflict", "This attempt already has a different immutable plan");
      return { plan, replayed: true, room };
    }
    await tx.insert(campPlans).values({ roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, taskId: binding.taskId, submittedRunId: run.id, bodyHash: hash, summary: plan.summary, items: plan.tasks });
    await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: "plan_submitted", content: plan.summary });
    return { plan, replayed: false, room };
  });
}
export async function finalizeGoal(principal: CampPrincipal, runId: string, input: CampPluginInput & { summary: string; evidence?: string; remaining?: string[] }) {
  return getDb().transaction(async tx => {
    const { room, run, binding, goal } = await currentRunScope(tx, principal, runId, input.epoch, input);
    if (binding.kind !== "summary" || run.role !== "planner" || !goal.finalCandidate) throw new CampError(403, "summary_task_required", "Only the final planner summary can finalize delivery");
    const result: CampFinalSummary = { summary: input.summary.trim(), evidence: input.evidence?.trim() || null, remaining: input.remaining?.map(value => value.trim()) ?? [] };
    if (!result.summary || result.summary.length > 16000 || (result.evidence?.length ?? 0) > 16000 || result.remaining.length > 20 || result.remaining.some(value => !value || value.length > 4000)) throw new CampError(400, "invalid_final_summary", "Invalid delivery summary");
    const candidate = candidateIdentity(goal.finalCandidate), hash = bodyHash({ result, candidate });
    if (!sameCandidate(candidate, binding.inputCandidate)) throw new CampError(409, "final_candidate_mismatch", "The final summary must bind the reviewed candidate");
    const [existing] = await tx.select().from(campFinalizations).where(and(eq(campFinalizations.goalId, goal.id), eq(campFinalizations.goalAttempt, goal.attempt)));
    if (existing) {
      if (existing.bodyHash !== hash) throw new CampError(409, "finalize_conflict", "This attempt already has a different immutable summary");
      return { summary: existing.result, candidate, replayed: true, room };
    }
    await tx.insert(campFinalizations).values({ roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, taskId: binding.taskId, submittedRunId: run.id, bodyHash: hash, result, candidate });
    await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: "final_summary_submitted", content: result.summary });
    return { summary: result, candidate, replayed: false, room };
  });
}
