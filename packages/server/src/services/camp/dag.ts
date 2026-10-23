import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { CAMP_DAG_INTEGRATION_ALGORITHM, parseIntegrationInput, serializeIntegrationInput, type CampCandidate, type CampDagPlanItem, type CampIntegrationParent, type CampIntegrationReceipt } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campDagEdges, campDagNodes, campGoals, campOperations, campPlans, campRooms, campRuns, campTasks } from "../../db/schema";
import { candidateDescendsFrom, candidateLineage, resolveCandidateSources } from "./dagLineage";
import { sameCandidate } from "./candidates";
import { enqueueStage } from "./workflow";
import { enqueueVerification } from "./verification";
import { stopGoal } from "./goals";
import { recordReviewedItem } from "./integration";
import { CampError, type CampReview } from "./types";
import type { DagDelivery } from "./dagTypes";
type Goal = typeof campGoals.$inferSelect;
type Room = typeof campRooms.$inferSelect;
type Node = typeof campDagNodes.$inferSelect;
type Binding = typeof campTasks.$inferSelect;
export const emptyDagDelivery = (): DagDelivery => ({ status: "waiting_nodes", candidate: null, sourceRunId: null, operationId: null, inputSources: [], inputResolution: null });
export async function initializeDagNodes(tx: DatabaseExecutor, planId: string, goal: Goal, items: CampDagPlanItem[]) {
  const nodes = await tx.insert(campDagNodes).values(items.map((item, ordinal) => ({ planId, goalId: goal.id, goalAttempt: goal.attempt, key: item.key, ordinal }))).returning();
  const ids = new Map(nodes.map(node => [node.key, node.id]));
  const edges = items.flatMap(item => item.dependsOnKeys.map(key => ({ fromNodeId: ids.get(key)!, toNodeId: ids.get(item.key)! })));
  if (edges.length) await tx.insert(campDagEdges).values(edges);
}
export async function dagNodes(tx: DatabaseExecutor, goal: Pick<Goal, "id" | "attempt">) { return tx.select().from(campDagNodes).where(and(eq(campDagNodes.goalId, goal.id), eq(campDagNodes.goalAttempt, goal.attempt))).orderBy(asc(campDagNodes.ordinal)); }
const source = (node: Node): CampIntegrationParent => {
  if (!node.approvedProducer) throw new CampError(409, "dag_parent_unapproved", "Every dependency must have a candidate-bound approval");
  const { key, runId, epoch, candidate } = node.approvedProducer; return { key, runId, epoch, candidate };
};
async function buildNode(tx: DatabaseExecutor, room: Room, goal: Goal, node: Node, item: CampDagPlanItem, candidate: CampCandidate, predecessor?: string, feedback?: string) {
  if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return; }
  const taskId = await enqueueStage(tx, room, goal, { kind: "build", candidate, predecessor, item, feedback });
  await tx.update(campDagNodes).set({ status: "ready", activeTaskId: taskId }).where(eq(campDagNodes.id, node.id));
}
async function integration(tx: DatabaseExecutor, room: Room, goal: Goal, sources: CampIntegrationParent[], base: CampCandidate, node?: Node) {
  const [existing] = await tx.select().from(campOperations).where(and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt), eq(campOperations.kind, "integration"), eq(campOperations.scope, node ? "node_input" : "goal"), node ? eq(campOperations.planItemKey, node.key) : undefined));
  if (existing) return existing;
  if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return null; }
  const input = parseIntegrationInput({ schemaVersion: 1, algorithm: CAMP_DAG_INTEGRATION_ALGORITHM, policy: "reject-overlap-v1", base, parents: sources });
  const [operation] = await tx.insert(campOperations).values({ roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, kind: "integration", scope: node ? "node_input" : "goal", planItemKey: node?.key, inputCandidate: base, integrationInput: input, inputDigest: createHash("sha256").update(serializeIntegrationInput(input)).digest("hex") }).returning();
  return operation;
}
async function planFor(tx: DatabaseExecutor, goal: Goal) {
  const [plan] = await tx.select().from(campPlans).where(and(eq(campPlans.goalId, goal.id), eq(campPlans.goalAttempt, goal.attempt)));
  if (!plan || plan.revision !== 2) throw new CampError(409, "dag_plan_required", "This graph requires its immutable revision 2 plan");
  return plan.items as CampDagPlanItem[];
}
/** Single Room lock serializes readiness, idempotent fan-in creation and all
 * budget debits; no model can select or replace a node's approved parent. */
export async function scheduleDag(tx: DatabaseExecutor, room: Room, goal: Goal, predecessor?: string) {
  if (!goal.baseCandidate || !["queued", "running", "waiting_question"].includes(goal.status)) return;
  const items = await planFor(tx, goal), nodes = await dagNodes(tx, goal), byKey = new Map(nodes.map(node => [node.key, node]));
  const graph = await candidateLineage(tx, goal);
  for (const node of nodes) {
    if (node.status !== "waiting_dependencies") continue;
    const item = items.find(value => value.key === node.key)!;
    const parents = item.dependsOnKeys.map(key => byKey.get(key)!);
    if (parents.some(parent => parent.status !== "approved")) continue;
    const sources = parents.map(source);
    let resolved;
    try { resolved = resolveCandidateSources(graph, goal.baseCandidate, sources); }
    catch (error) { if (error instanceof CampError) { await stopGoal(tx, room, goal, error.code); return; } throw error; }
    if (resolved.candidate) {
      await tx.update(campDagNodes).set({ inputCandidate: resolved.candidate, inputSources: sources, inputResolution: resolved.resolution }).where(eq(campDagNodes.id, node.id));
      await buildNode(tx, room, goal, node, item, resolved.candidate, predecessor);
    } else {
      const operation = await integration(tx, room, goal, sources, resolved.mergeBase!, node); if (!operation) return;
      await tx.update(campDagNodes).set({ status: "waiting_integration", inputSources: sources, inputResolution: "integration", inputOperationId: operation.id }).where(eq(campDagNodes.id, node.id));
    }
  }
  if (!nodes.every(node => node.status === "approved") || goal.dagDelivery?.status === "ready" || goal.dagDelivery?.status === "waiting_integration") return;
  const sinkKeys = items.filter(item => !items.some(other => other.dependsOnKeys.includes(item.key))).map(item => item.key), sources = sinkKeys.map(key => source(byKey.get(key)!));
  let resolved;
  try { resolved = resolveCandidateSources(graph, goal.baseCandidate, sources); }
  catch (error) { if (error instanceof CampError) { await stopGoal(tx, room, goal, error.code); return; } throw error; }
  if (resolved.candidate) {
    const delivery: DagDelivery = { status: "ready", candidate: resolved.candidate, sourceRunId: resolved.sourceRunId, operationId: null, inputSources: sources, inputResolution: resolved.resolution };
    await tx.update(campGoals).set({ dagDelivery: delivery, currentCandidate: resolved.candidate }).where(eq(campGoals.id, goal.id));
    await enqueueVerification(tx, room, goal, resolved.candidate);
  } else {
    const operation = await integration(tx, room, goal, sources, resolved.mergeBase!); if (!operation) return;
    await tx.update(campGoals).set({ dagDelivery: { status: "waiting_integration", candidate: null, sourceRunId: null, operationId: operation.id, inputSources: sources, inputResolution: "integration" } }).where(eq(campGoals.id, goal.id));
  }
}
export async function advanceDag(tx: DatabaseExecutor, room: Room, goal: Goal, binding: Binding, run: typeof campRuns.$inferSelect, input: CampCandidate, candidate: CampCandidate, review: CampReview | null) {
  if (binding.kind === "plan") {
    const [updated] = await tx.update(campGoals).set({ baseCandidate: goal.baseCandidate ?? input, currentCandidate: input, dagDelivery: emptyDagDelivery() }).where(eq(campGoals.id, goal.id)).returning(); await scheduleDag(tx, room, updated, binding.taskId); return true;
  }
  if (!binding.planItemKey) return false;
  const [node] = await tx.select().from(campDagNodes).where(and(eq(campDagNodes.goalId, goal.id), eq(campDagNodes.goalAttempt, goal.attempt), eq(campDagNodes.key, binding.planItemKey)));
  if (!node || node.activeTaskId !== binding.taskId) throw new CampError(409, "dag_node_changed", "This task is not the current graph node execution");
  const item = (await planFor(tx, goal)).find(value => value.key === node.key)!;
  if (binding.kind === "build") {
    if (goal.runCount >= goal.budget.maxRuns || goal.reviewRounds >= goal.budget.maxReviewRounds) { await stopGoal(tx, room, goal, goal.runCount >= goal.budget.maxRuns ? "run_budget_exhausted" : "review_budget_exhausted"); return true; }
    const taskId = await enqueueStage(tx, room, goal, { kind: "review", candidate, predecessor: binding.taskId, item }); await tx.update(campDagNodes).set({ status: "reviewing", activeTaskId: taskId }).where(eq(campDagNodes.id, node.id));
  } else if (binding.kind === "review") {
    if (!review) throw new CampError(409, "review_required", "The node needs its candidate-bound verdict");
    if (review.outcome === "changes_requested") {
      if (goal.runCount + 2 > goal.budget.maxRuns || goal.reviewRounds >= goal.budget.maxReviewRounds) { await stopGoal(tx, room, goal, goal.runCount + 2 > goal.budget.maxRuns ? "run_budget_exhausted" : "review_budget_exhausted"); return true; }
      await tx.update(campDagNodes).set({ reworkCount: node.reworkCount + 1 }).where(eq(campDagNodes.id, node.id)); await buildNode(tx, room, goal, node, item, input, binding.taskId, `Address this node's review: ${review.summary}\n${JSON.stringify(review.evidence)}`);
    } else {
      const reviewed = await recordReviewedItem(tx, goal, binding, run.id, input); await tx.update(campDagNodes).set({ status: "approved", approvedProducer: reviewed[node.key] }).where(eq(campDagNodes.id, node.id));
      const [fresh] = await tx.select().from(campGoals).where(eq(campGoals.id, goal.id)); await scheduleDag(tx, room, fresh, binding.taskId);
    }
  } else return false;
  return true;
}
export async function finishDagIntegration(tx: DatabaseExecutor, room: Room, goal: Goal, operation: typeof campOperations.$inferSelect, runId: string, receipt: CampIntegrationReceipt) {
  if (receipt.status !== "merged" || !receipt.candidate) { await stopGoal(tx, room, goal, `integration_${receipt.status}`); return; }
  if (operation.scope === "node_input") {
    const [node] = await tx.select().from(campDagNodes).where(and(eq(campDagNodes.goalId, goal.id), eq(campDagNodes.goalAttempt, goal.attempt), eq(campDagNodes.key, operation.planItemKey!)));
    if (!node || node.inputOperationId !== operation.id || node.status !== "waiting_integration") throw new CampError(409, "dag_node_changed", "The graph node no longer owns this fan-in");
    await tx.update(campDagNodes).set({ inputCandidate: receipt.candidate }).where(eq(campDagNodes.id, node.id));
    const item = (await planFor(tx, goal)).find(value => value.key === node.key)!; await buildNode(tx, room, goal, node, item, receipt.candidate);
  } else {
    if (goal.dagDelivery?.operationId !== operation.id || goal.dagDelivery.status !== "waiting_integration") throw new CampError(409, "dag_delivery_changed", "This integration is not the current final sink selection");
    await tx.update(campGoals).set({ currentCandidate: receipt.candidate, dagDelivery: { ...goal.dagDelivery, status: "ready", candidate: receipt.candidate, sourceRunId: runId } }).where(eq(campGoals.id, goal.id)); await enqueueVerification(tx, room, goal, receipt.candidate);
  }
}
export async function requireDagGate(tx: DatabaseExecutor, goal: Goal) {
  const nodes = await dagNodes(tx, goal), items = await planFor(tx, goal), delivery = goal.dagDelivery;
  if (goal.integrationInspectionRequired || nodes.length !== items.length || nodes.some(node => node.status !== "approved" || !node.approvedProducer) || delivery?.status !== "ready" || !delivery.candidate) throw new CampError(409, "integration_required", "All graph nodes and the final candidate lineage must be approved");
  const operations = await tx.select().from(campOperations).where(and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt), eq(campOperations.kind, "integration")));
  for (const operation of operations) {
    if (operation.status !== "completed" || operation.integrationReport?.status !== "merged" || !operation.integrationReport.candidate || operation.integrationReport.operationId !== operation.id || operation.integrationReport.inputDigest !== operation.inputDigest || operation.integrationInput?.algorithm !== CAMP_DAG_INTEGRATION_ALGORITHM || createHash("sha256").update(serializeIntegrationInput(operation.integrationInput)).digest("hex") !== operation.inputDigest) throw new CampError(409, "integration_required", "Every required graph integration must retain its exact successful receipt");
    const target = operation.scope === "node_input" ? nodes.find(node => node.key === operation.planItemKey) : null;
    if (target ? target.inputOperationId !== operation.id || !sameCandidate(target.inputCandidate, operation.integrationReport.candidate) : delivery.operationId !== operation.id || !sameCandidate(delivery.candidate, operation.integrationReport.candidate)) throw new CampError(409, "integration_required", "Integration receipt is detached from its graph consumer");
  }
  const graph = await candidateLineage(tx, goal);
  for (const node of nodes) {
    const item = items.find(value => value.key === node.key)!;
    const sources = item.dependsOnKeys.map(key => source(nodes.find(value => value.key === key)!));
    if (!isDeepStrictEqual(sources, node.inputSources) || !node.inputCandidate || !candidateDescendsFrom(graph, node.approvedProducer!.candidate, node.inputCandidate)) throw new CampError(409, "integration_required", "An approved node is detached from its frozen input lineage");
    const resolved = resolveCandidateSources(graph, goal.baseCandidate!, sources);
    if (resolved.candidate ? node.inputOperationId !== null || !sameCandidate(resolved.candidate, node.inputCandidate) : !operations.some(operation => operation.id === node.inputOperationId && operation.scope === "node_input" && operation.planItemKey === node.key && sameCandidate(operation.integrationInput?.base, resolved.mergeBase) && isDeepStrictEqual(operation.integrationInput?.parents, sources))) throw new CampError(409, "integration_required", "A node input is missing its exact approved dependency selection");
  }
  if (goal.currentCandidate && !candidateDescendsFrom(graph, goal.currentCandidate, delivery.candidate)) throw new CampError(409, "integration_required", "The current result does not descend from the complete graph delivery");
  const expected = items.filter(item => !items.some(other => other.dependsOnKeys.includes(item.key))).map(item => source(nodes.find(node => node.key === item.key)!));
  if (!isDeepStrictEqual(expected, delivery.inputSources)) throw new CampError(409, "integration_required", "The final result must include every exact approved sink");
  const selected = resolveCandidateSources(graph, goal.baseCandidate!, expected);
  if (selected.candidate && (!sameCandidate(selected.candidate, delivery.candidate) || delivery.operationId !== null)) throw new CampError(409, "integration_required", "The final passthrough selection changed");
  if (!selected.candidate && !operations.some(operation => operation.id === delivery.operationId && operation.scope === "goal" && sameCandidate(operation.integrationInput?.base, selected.mergeBase) && isDeepStrictEqual(operation.integrationInput?.parents, expected))) throw new CampError(409, "integration_required", "The final sinks require their trusted integration");
  return { delivery, operations };
}
export async function dagProjection(goal: Goal) {
  if (goal.planMode !== "bounded_dag") return null;
  const items = await planFor(getDb(), goal).catch(() => []), delivery = goal.dagDelivery ?? emptyDagDelivery();
  return { schemaVersion: 1 as const, sinkKeys: items.filter(item => !items.some(other => other.dependsOnKeys.includes(item.key))).map(item => item.key), delivery };
}
