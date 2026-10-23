import { finishDagIntegration, requireDagGate } from "./dag";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseIntegrationInput, parseIntegrationReport, serializeIntegrationInput, type CampCandidate, type CampIntegrationReceipt } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campGoals, campOperations, campRooms, campRuns, campTasks } from "../../db/schema";
import { sameCandidate } from "./candidates";
import { stopGoal } from "./goals";
import { enqueueVerification } from "./verification";
import { CampError, type CampPlanItem, type CampReviewedItem } from "./types";

type Goal = typeof campGoals.$inferSelect;
type Operation = typeof campOperations.$inferSelect;
type Room = typeof campRooms.$inferSelect;
export const needsIntegration = (goal: Pick<Goal, "planMode">) => ["same_baseline_pair", "parallel_pair", "bounded_dag"].includes(goal.planMode);

/** The reviewer cannot choose a producer. Follow the canonical task dependency
 * and require the exact completed build which produced its selected input. */
export async function recordReviewedItem(tx: DatabaseExecutor, goal: Goal, binding: typeof campTasks.$inferSelect, reviewRunId: string, candidate: CampCandidate): Promise<Record<string, CampReviewedItem>> {
  if (!binding.planItemKey || binding.dependsOn.length !== 1) throw new CampError(409, "integration_lineage_invalid", "An item review must bind one producer task");
  const [producer] = await tx.select().from(campTasks).where(and(eq(campTasks.taskId, binding.dependsOn[0]), eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt), eq(campTasks.kind, "build")));
  if (!producer || producer.planItemKey !== binding.planItemKey) throw new CampError(409, "integration_lineage_invalid", "The reviewed producer does not belong to this plan item");
  const matches = (await tx.select().from(campRuns).where(and(eq(campRuns.taskId, producer.taskId), eq(campRuns.executor, "agent"), eq(campRuns.status, "completed")))).filter(run => sameCandidate(run.candidate, candidate));
  if (matches.length !== 1) throw new CampError(409, "integration_lineage_invalid", "The reviewed candidate must have one immutable build producer");
  const reviewedItems = { ...goal.reviewedItems, [binding.planItemKey]: { key: binding.planItemKey, runId: matches[0].id, epoch: matches[0].epoch, candidate, reviewRunId } };
  await tx.update(campGoals).set({ reviewedItems }).where(eq(campGoals.id, goal.id));
  return reviewedItems;
}
export async function enqueueIntegration(tx: DatabaseExecutor, room: Room, goal: Goal, items: CampPlanItem[], reviewedItems: Record<string, CampReviewedItem>) {
  if (!needsIntegration(goal) || ![3, 4].includes(goal.protocolVersion ?? 0) || items.length !== 2 || !goal.baseCandidate || items.some(item => !reviewedItems[item.key])) throw new CampError(409, "integration_parents_required", "Both ordered items must have reviewed immutable producers");
  if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return; }
  const input = parseIntegrationInput({ schemaVersion: 1, algorithm: "layerfs-three-way-v1", policy: "reject-overlap-v1", base: goal.baseCandidate, parents: items.map(item => { const { key, runId, epoch, candidate } = reviewedItems[item.key]; return { key, runId, epoch, candidate }; }) });
  const inputDigest = createHash("sha256").update(serializeIntegrationInput(input)).digest("hex");
  await tx.insert(campOperations).values({ kind: "integration", roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, inputCandidate: input.base, integrationInput: input, inputDigest });
}
export function checkedIntegrationReport(operation: Operation, value: unknown) {
  const report = parseIntegrationReport(value);
  if (operation.kind !== "integration" || !operation.integrationInput || report.inputDigest !== operation.inputDigest || report.algorithm !== operation.integrationInput.algorithm || report.policy !== operation.integrationInput.policy) throw new CampError(409, "integration_input_mismatch", "Integration must bind its frozen two-parent input");
  if (report.candidate && (report.candidate.projectId !== operation.inputCandidate.projectId || report.candidate.imageId !== operation.inputCandidate.imageId || report.candidate.baseRef !== operation.inputCandidate.refId)) throw new CampError(409, "integration_candidate_mismatch", "Integration must produce a candidate from the frozen base in the same project and image");
  return report;
}
export async function finishIntegration(tx: DatabaseExecutor, room: Room, goal: Goal, operation: Operation, runId: string, value: unknown) {
  const report = checkedIntegrationReport(operation, value);
  const receipt: CampIntegrationReceipt = { ...report, operationId: operation.id, runId, integratedAt: new Date().toISOString() };
  await tx.update(campOperations).set({ status: "completed", integrationReport: receipt }).where(eq(campOperations.id, operation.id));
  if (goal.planMode === "bounded_dag") { await finishDagIntegration(tx, room, goal, operation, runId, receipt); return receipt; }
  if (report.status === "merged" && report.candidate) {
    await tx.update(campGoals).set({ currentCandidate: report.candidate }).where(eq(campGoals.id, goal.id));
    await enqueueVerification(tx, room, goal, report.candidate);
  } else await stopGoal(tx, room, goal, `integration_${report.status}`);
  return receipt;
}
type IntegrationGateOperation = { id?: string; goalId?: string; kind?: string; goalAttempt?: number; status: string; integrationInput?: Operation["integrationInput"]; integrationReport?: Operation["integrationReport"]; inputDigest?: string | null };
export function integrationGatePassed(goal: Goal, operations: readonly IntegrationGateOperation[]) {
  if (!needsIntegration(goal)) return true;
  if (goal.integrationInspectionRequired) return false;
  if (goal.planMode === "bounded_dag") return goal.dagDelivery?.status === "ready" && goal.dagDelivery.candidate !== null && operations.filter(operation => operation.kind === "integration" && operation.goalId === goal.id && operation.goalAttempt === goal.attempt).every(operation => operation.status === "completed" && operation.integrationReport?.status === "merged");
  const matches = operations.filter(operation => operation.kind === "integration" && operation.goalId === goal.id && operation.goalAttempt === goal.attempt);
  if (matches.length !== 1 || matches[0].status !== "completed") return false;
  const operation = matches[0], receipt = operation.integrationReport;
  if (!receipt || receipt.status !== "merged" || !receipt.candidate || receipt.operationId !== operation.id) return false;
  try {
    const input = parseIntegrationInput(operation.integrationInput);
    const digest = createHash("sha256").update(serializeIntegrationInput(input)).digest("hex");
    return sameCandidate(input.base, goal.baseCandidate) && digest === operation.inputDigest && receipt.inputDigest === digest && receipt.algorithm === input.algorithm && receipt.policy === input.policy && receipt.conflicts.length === 0 && !receipt.truncated && receipt.candidate.projectId === input.base.projectId && receipt.candidate.imageId === input.base.imageId && input.parents.every(parent => {
      const reviewed = goal.reviewedItems[parent.key];
      return reviewed && reviewed.runId === parent.runId && reviewed.epoch === parent.epoch && sameCandidate(reviewed.candidate, parent.candidate);
    });
  } catch { return false; }
}
export async function requireIntegrationGate(tx: DatabaseExecutor, goal: Goal) {
  if (!needsIntegration(goal)) return null;
  if (goal.planMode === "bounded_dag") return requireDagGate(tx, goal);
  const operations = await tx.select().from(campOperations).where(and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt), eq(campOperations.kind, "integration")));
  if (!integrationGatePassed(goal, operations)) throw new CampError(409, "integration_required", "The frozen two-parent integration must succeed before whole-goal acceptance");
  return { input: operations[0].integrationInput!, receipt: operations[0].integrationReport! };
}
export async function goalIntegrationSnapshot(goal: Goal, supplied?: readonly (IntegrationGateOperation & { goalId: string })[]) {
  const operations = (supplied ?? await getDb().select().from(campOperations).where(eq(campOperations.goalId, goal.id))).filter(operation => operation.kind === "integration" && operation.goalId === goal.id && operation.goalAttempt === goal.attempt);
  const latest = goal.planMode === "bounded_dag" ? operations.find(operation => "scope" in operation && operation.scope === "goal") : operations[0];
  const stoppedWithoutExecution = !latest && ["completed", "cancelled", "needs_attention"].includes(goal.status);
  const status = !needsIntegration(goal) ? "not_required" : !latest ? stoppedWithoutExecution ? "not_run" : "pending" : latest.status === "completed" ? latest.integrationReport?.status ?? "failed" : latest.status;
  const graphStatus = goal.planMode !== "bounded_dag" ? status : ["completed", "cancelled", "needs_attention"].includes(goal.status) && goal.dagDelivery?.status !== "ready" ? !operations.length ? "not_run" : latest?.integrationReport?.status ?? "blocked" : goal.dagDelivery?.status === "ready" ? operations.length ? "merged" : "not_required" : status === "not_run" ? status : "pending";
  return { required: needsIntegration(goal), status: graphStatus, operations };
}
