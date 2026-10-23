import { activeStorageOperation } from "./storage";
import { CAMP_PROTOCOL_VERSION, CAMP_SUPPORTED_PROTOCOL_VERSIONS, checkWorkerCompatibility, getTaskRequirements, parseChangeSet, parseWorkerDeclaration, type CampWorkerDeclaration, type CampTaskRequirements, type CampWorkerCompatibility, type CampClaimAdmission } from "../../../../camp-protocol/src/index.js";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { agents, campEvents, campFinalizations, campGoals, campOperations, campQuestions, campRooms, campRuns, campTasks, campWorkerTokens, channelAgents, serverAgentMembers, tasks } from "../../db/schema";
import { createMessage } from "../messageService";
import { checkedVerificationReport, finishVerification, requireVerificationGate } from "./verification";
import { checkedIntegrationReport, finishIntegration } from "./integration";
import { physicalPoolCompatibility, pinExecutionPool, poolCompatibility, roomOccupancy } from "./executionPool";
import { observeWorker } from "./workerCompatibility";
import { withCampTaskMutation } from "./taskAuthority";
import { assignTask, createTasks, forceUpdateTaskStatus, updateTaskStatus } from "../taskService";
import { hashCampToken, lockRoom, lockRoomChannel, lockRoomTaskIdentities, newCampToken, roomMessages, withCampRoomAdmin } from "./rooms";
import { refreshGoal, stopGoal } from "./goals";
import { currentPlan } from "./plans";
import { blockingQuestion, completeClarification, requireClarificationResult, suspendForQuestion } from "./questions";
import { advanceSerial, requireSerialCompletion } from "./workflow";
import { candidateIdentity, completionCandidates, sameCandidate, sameReviewTarget, selectDependencyCandidate } from "./candidates";
import { assertCompletionArtifactBudget, assertReportedArtifactBudget } from "./payloadLimits";
import { completionFingerprint } from "./completionFingerprint";
import { CampError, type CampArtifact, type CampClaimedRun, type CampCompletion, type CampDependency, type CampPrincipal, type CampReview, type CampReviewTarget, type CampRole } from "./types";

export const CAMP_LEASE_SECONDS = 45;
const nextLease = () => sql`clock_timestamp() + interval '45 seconds'`;
const fail = (message = "This run no longer owns the task lease") => new CampError(409, "stale_run", message);
type Run = typeof campRuns.$inferSelect;
type Room = typeof campRooms.$inferSelect;
type AgentRun = Run & { executor: "agent"; taskId: string; operationId: null; role: CampRole; agentId: string };
type OperationRun = Run & { executor: "verification" | "integration"; taskId: null; operationId: string; role: null; agentId: null };
type VerificationRun = Run & { executor: "verification"; taskId: null; operationId: string; role: null; agentId: null };
export function requireAgentRun(run: Run): asserts run is AgentRun {
  if (run.executor !== "agent" || !run.taskId || !run.agentId || !run.role || run.operationId !== null) throw new CampError(403, "agent_run_required", "This operation belongs only to a model execution");
}
export function requireVerificationRun(run: Run): asserts run is VerificationRun {
  if (run.executor !== "verification" || !run.operationId || run.taskId !== null || run.agentId !== null || run.role !== null) throw new CampError(403, "verification_run_required", "This operation belongs only to a trusted verifier");
}
function requireOperationRun(run: Run): asserts run is OperationRun {
  if (run.executor === "agent" || !run.operationId || run.taskId !== null || run.agentId !== null || run.role !== null) throw new CampError(403, "operation_run_required", "This execution belongs only to a trusted operation");
}
async function integrationContext(tx: DatabaseExecutor, room: Room, run: Run) {
  requireOperationRun(run);
  const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, run.operationId));
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, operation.goalId));
  if (operation.kind !== "integration" || !operation.integrationInput || !operation.inputDigest || !run.workerProtocol || ![3, 4, 5].includes(run.workerProtocol.version)) throw fail("The integration contract is missing");
  return { id: run.id, executor: "integration" as const, operationId: operation.id, taskId: null, role: null, agentId: null, taskKind: "integration" as const, roomId: room.id, goalId: goal.id, goalAttempt: operation.goalAttempt, epoch: run.epoch, leaseExpiresAt: run.leaseExpiresAt.toISOString(), workflow: "serial" as const, planMode: goal.planMode, protocolVersion: run.workerProtocol?.version ?? goal.protocolVersion!, workerProtocol: run.workerProtocol, inputCandidate: operation.inputCandidate, goalBaseline: goal.protocolVersion === 5 ? goal.baseCandidate! : operation.integrationInput.base, scope: operation.scope, planItemKey: operation.planItemKey, baseRef: operation.inputCandidate.refId, integrationInput: operation.integrationInput, inputDigest: operation.inputDigest, project: room.project };
}
async function verificationContext(tx: DatabaseExecutor, room: Room, run: Run) {
  requireVerificationRun(run);
  const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, run.operationId));
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, operation.goalId));
  if (operation.kind !== "verification" || !operation.verificationPolicy) throw fail("The verification contract is missing");
  return { id: run.id, executor: "verification" as const, operationId: operation.id, taskId: null, role: null, agentId: null, taskKind: "verification" as const, roomId: room.id, goalId: goal.id, goalAttempt: operation.goalAttempt, epoch: run.epoch, leaseExpiresAt: run.leaseExpiresAt.toISOString(), workflow: "serial" as const, protocolVersion: run.workerProtocol?.version ?? goal.protocolVersion, workerProtocol: run.workerProtocol, inputCandidate: operation.inputCandidate, goalBaseline: goal.baseCandidate, baseRef: operation.inputCandidate.refId, verificationPolicy: operation.verificationPolicy, project: room.project };
}
async function claimedContext(tx: DatabaseExecutor, room: Room, run: Run, runToken: string) {
  return run.executor === "integration" ? integrationContext(tx, room, run) : run.executor === "verification" ? verificationContext(tx, room, run) : { ...await executionContext(tx, room, run), runToken };
}


function reviewArtifact(artifact: CampArtifact, fallbackSummary: string): CampReview {
  const { outcome, evidence, summary } = artifact;
  const validEvidence = typeof evidence === "string"
    ? evidence.trim().length > 0 && evidence.length <= 16000
    : Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 50 && evidence.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 16000);
  if ((outcome !== "approved" && outcome !== "changes_requested") || !validEvidence) {
    throw new CampError(400, "invalid_review", "A review needs an approved or changes_requested outcome and nonempty evidence");
  }
  return { outcome, evidence: evidence as string | string[], summary: typeof summary === "string" && summary.trim() ? summary : fallbackSummary, ...(artifact.candidate ? { candidate: artifact.candidate as CampReviewTarget } : {}) };
}

async function runReports(tx: DatabaseExecutor, runId: string) {
  const events = await tx.select().from(campEvents).where(and(eq(campEvents.runId, runId), isNotNull(campEvents.artifact))).orderBy(desc(campEvents.seq)).limit(31);
  const review = events.find(event => event.artifact?.type === "review");
  return { review: review?.artifact ? reviewArtifact(review.artifact, review.content) : null, artifacts: events.reverse().flatMap(event => event.artifact ? [event.artifact] : []) };
}

function completionFields(run: Run) {
  return { id: run.id, executor: run.executor, operationId: run.operationId, verification: run.verification, integration: run.integration, changeSet: run.changeSet, roomId: run.roomId, taskId: run.taskId, status: run.status, epoch: run.epoch, summary: run.summary, artifacts: run.artifacts, outcome: run.outcome, inputCandidate: run.inputCandidate, candidate: run.candidate, questionId: run.questionId };
}

export async function authenticateCampToken(token: string): Promise<CampPrincipal> {
  if (token.startsWith("camp_worker_")) {
    const [row] = await getDb().select().from(campWorkerTokens).where(and(eq(campWorkerTokens.tokenHash, hashCampToken(token)), isNull(campWorkerTokens.revokedAt), gt(campWorkerTokens.expiresAt, sql`clock_timestamp()`)));
    if (row) return { kind: "worker", roomId: row.roomId, tokenId: row.id };
  } else if (token.startsWith("camp_run_")) {
    const [row] = await getDb().select({ id: campRuns.id, roomId: campRuns.roomId, epoch: campRuns.epoch, agentId: campRuns.agentId }).from(campRuns).where(and(eq(campRuns.executor, "agent"), eq(campRuns.runTokenHash, hashCampToken(token)), eq(campRuns.status, "running"), isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
    if (row) {
      const [room] = await getDb().select().from(campRooms).where(eq(campRooms.id, row.roomId));
      if (room && row.agentId && await roleAvailable(getDb(), room, row.agentId)) return { kind: "run", roomId: row.roomId, runId: row.id, epoch: row.epoch };
    }
  }
  throw new CampError(401, "camp_auth_required", "A valid Camp credential is required");
}

export function requireWorker(principal: CampPrincipal) {
  if (principal.kind !== "worker") throw new CampError(403, "worker_scope_required", "This operation requires the trusted worker credential");
}

export async function validateWorker(tx: DatabaseExecutor, principal: CampPrincipal) {
  requireWorker(principal);
  if (principal.kind !== "worker") return;
  const [token] = await tx.select({ id: campWorkerTokens.id }).from(campWorkerTokens).where(and(eq(campWorkerTokens.id, principal.tokenId), eq(campWorkerTokens.roomId, principal.roomId), isNull(campWorkerTokens.revokedAt), gt(campWorkerTokens.expiresAt, sql`clock_timestamp()`))).for("share");
  if (!token) throw new CampError(401, "camp_auth_required", "The worker credential was revoked or expired");
}

function assertMutation(result: Awaited<ReturnType<typeof updateTaskStatus>>) {
  if (typeof result === "string") throw fail(result);
  return result.row;
}

async function taskState(roomId: string, taskId: string, desired: "in_progress" | "done" | "closed", agentId: string) {
  const [current] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  if (!current || current.claimedByType !== "agent" || current.claimedById !== agentId) throw fail("The task assignment changed");
  if (current.status === desired) return current;
  return assertMutation(await withCampTaskMutation(roomId, taskId, () => updateTaskStatus(taskId, desired, agentId, "agent")));
}

async function dependencies(tx: DatabaseExecutor, taskIds: string[]): Promise<CampDependency[]> {
  if (!taskIds.length) return [];
  const completed = await tx.select().from(campRuns).where(and(inArray(campRuns.taskId, taskIds), eq(campRuns.status, "completed"))).orderBy(desc(campRuns.createdAt));
  return taskIds.map(taskId => {
    const run = completed.find(row => row.taskId === taskId);
    return { taskId, summary: run?.summary ?? "", artifacts: run?.artifacts ?? [] };
  });
}

async function effectiveExecutionInput(tx: DatabaseExecutor, binding: typeof campTasks.$inferSelect, goal: typeof campGoals.$inferSelect) {
  const previous = await dependencies(tx, binding.dependsOn);
  const legacyParent = binding.inputCandidate ?? selectDependencyCandidate(previous.flatMap(dep => dep.artifacts));
  const legacyRef = legacyParent ? (legacyParent.refId ?? legacyParent.commitId ?? legacyParent.layerId) as string : undefined;
  let inputCandidate = binding.inputCandidate ?? (goal.workflow === "serial" ? goal.baseCandidate : null);
  if (goal.workflow === "legacy" && !inputCandidate && legacyParent) { try { inputCandidate = candidateIdentity(legacyParent); } catch { /* Legacy callers may not have supplied root/image identities. */ } }
  return { previous, legacyParent, legacyRef, inputCandidate };
}

async function executionContext(tx: DatabaseExecutor, room: Room, run: Run) {
  requireAgentRun(run);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId));
  const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
  if (!task || !binding) throw fail();
  const role = room.roles.find(row => row.role === run.role);
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
  if (!goal || goal.attempt !== binding.goalAttempt) throw fail("The goal attempt changed");
  const { previous, legacyParent, legacyRef, inputCandidate: selectedInput } = await effectiveExecutionInput(tx, binding, goal);
  const inputCandidate = run.inputCandidate ?? selectedInput;
  const questions = await tx.select().from(campQuestions).where(and(eq(campQuestions.goalId, goal.id), eq(campQuestions.goalAttempt, goal.attempt))).orderBy(asc(campQuestions.createdAt));
  const question = binding.questionId ? questions.find(value => value.id === binding.questionId) ?? null : null;
  const pending = questions.find(value => value.taskId === binding.taskId && value.activeRunId === run.id && value.status === "pending" && !value.resumedAt) ?? null;
  const plan = await currentPlan(tx, goal.id, goal.attempt);
  const [finalization] = await tx.select().from(campFinalizations).where(and(eq(campFinalizations.goalId, goal.id), eq(campFinalizations.goalAttempt, goal.attempt)));
  const reviewTask = binding.kind === "review" || binding.kind === "final_review";
  const verificationReceipt = ["final_review", "summary"].includes(binding.kind) && inputCandidate ? await requireVerificationGate(tx, goal, inputCandidate) : null;
  const prompt = [
    `You are the ${run.role} in Camp room ${room.name}.`, role?.instructions,
    `Original goal: ${goal.title}`, goal.description,
    `Task: ${task.title}`, task.description,
    "Stay within this role. Report progress and candidate artifacts. The trusted worker owns claim, completion and handoff. Never publish to main automatically.",
    reviewTask ? "Review and test the selected candidate. Before finishing, call camp_review with outcome approved or changes_requested, a summary, and a nonempty evidence string describing the checks. The verdict binds the server-selected candidate. A prose verdict cannot complete this review." : undefined,
    goal.workflow === "serial" && binding.kind === "plan" ? plan ? `This attempt already has an immutable plan. Do not replace it: ${JSON.stringify(plan)}` : goal.planMode === "bounded_dag" ? "Submit a bounded DAG using camp_submit_plan revision 2: one to six nodes, every node has dependsOnKeys (zero to two direct parent keys), at most two sinks, no cycles, missing parents or transitively redundant edges. The trusted scheduler resolves approved inputs and merges. Then finish." : ["same_baseline_pair", "parallel_pair"].includes(goal.planMode) ? "Submit exactly two independent plan items with camp_submit_plan. Both builds start from the same immutable baseline, so neither item may depend on the other item. Then finish." : "Inspect the original goal and submit one to five ordered, independently reviewable items with camp_submit_plan. Each item needs key/title/description/acceptance/verification. Then finish this planning turn." : undefined,
    goal.workflow === "serial" && binding.kind !== "build" ? "This task is read-only: inspect and run checks without changing workspace content. The worker will reject a changed content root." : undefined,
    verificationReceipt ? `Independent operator verification receipt (server-owned): ${JSON.stringify(verificationReceipt)}. Use these actual termination results as evidence; model prose cannot replace this gate.` : undefined,
    binding.kind === "summary" ? "Before ending, call camp_finalize with the final delivery summary, evidence, and remaining limitations. The server supplies the reviewed candidate; do not choose a candidate ID." : undefined,
    binding.kind === "clarification" ? `Answer or escalate only the assigned question, then finish. Use camp_answer_question or camp_escalate_question. Do not ask a second question or submit a review verdict. Assigned question: ${JSON.stringify(question)}` : undefined,
    goal.workflow === "serial" && binding.kind !== "clarification" ? "If a blocking decision is needed, use camp_ask_question and finish the turn immediately. Do not wait for the answer; the worker will checkpoint and suspend this task. Previously answered questions are context, not new work." : undefined,
    ...questions.filter(value => value.taskId === binding.taskId && value.answer).map(value => `Resolved question ${value.id}: ${value.content}\nAnswer: ${value.answer}`),
    ...previous.map(dep => `Previous stage (${dep.taskId}): ${dep.summary}\nArtifacts: ${JSON.stringify(dep.artifacts)}`),
  ].filter(Boolean).join("\n\n");
  const target = inputCandidate ?? (goal.workflow === "legacy" ? legacyParent : null);
  const reviewTarget = reviewTask && target && typeof target.projectId === "string" ? { projectId: target.projectId, ...(target.refId ? { refId: target.refId as string, refKind: target.refKind as "layer" | "commit" } : {}), ...(target.commitId ? { commitId: target.commitId } : {}), ...(target.layerId ? { layerId: target.layerId as string } : {}), ...(target.branch ? { branch: target.branch } : {}) } : null;
  return { id: run.id, executor: "agent" as const, operationId: null, goalBaseline: goal.baseCandidate, planMode: goal.planMode, verificationPolicy: goal.verificationPolicy, taskId: run.taskId, roomId: room.id, goalId: binding.goalId, goalAttempt: binding.goalAttempt, epoch: run.epoch, leaseExpiresAt: run.leaseExpiresAt.toISOString(), role: run.role, agentId: run.agentId, prompt, project: room.project, dependencies: previous, reviewTarget, workflow: goal.workflow, protocolVersion: run.workerProtocol?.version ?? goal.protocolVersion, workerProtocol: run.workerProtocol, taskKind: binding.kind, planItemKey: binding.planItemKey, inputCandidate, verificationReceipt, baseRef: inputCandidate?.refId ?? (goal.workflow === "legacy" ? legacyRef : undefined) ?? room.project.baseRef ?? "main", plan, finalCandidate: goal.finalCandidate, finalization: finalization?.result ?? null, questions, question, assignedQuestion: question, blockingQuestion: pending };
}

export async function roleAvailable(tx: DatabaseExecutor, room: Room, agentId: string) {
  const [identity] = await tx.select({ id: agents.id }).from(agents)
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(serverAgentMembers, and(eq(serverAgentMembers.agentId, agents.id), eq(serverAgentMembers.serverId, room.serverId)))
    .where(and(eq(agents.id, agentId), eq(agents.serverId, room.serverId), eq(agents.runtime, "external"), isNull(agents.deletedAt), eq(channelAgents.channelId, room.channelId))).for("share");
  return Boolean(identity);
}

/** Caller owns the room row lock. Both claims and the server-owned sweeper use
 * this same transition, so recovery does not depend on a worker polling. */
export async function reconcileCampRoom(tx: DatabaseExecutor, room: Room) {
  if (await activeStorageOperation(tx, room.id)) return;
  const channel = await lockRoomChannel(tx, room);
  await lockRoomTaskIdentities(tx, room);
  let goals = await tx.select().from(campGoals).where(eq(campGoals.roomId, room.id));
  for (const goal of goals) {
    if (!["queued", "running", "waiting_question"].includes(goal.status)) continue;
    if (goal.workflow === "serial" && goal.baseHeadRevision !== room.acceptedRevision) { await stopGoal(tx, room, goal, "stale_baseline"); continue; }
    if (!channel) { await stopGoal(tx, room, goal, "channel_unavailable"); continue; }
    const [expired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
    if (expired) { await stopGoal(tx, room, goal, "duration_budget_exhausted"); continue; }
    const bindings = await tx.select().from(campTasks).where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt)));
    let canonicalChanged = false;
    for (const binding of bindings.filter(task => ["queued", "running", "waiting_question"].includes(task.status))) {
      const [canonical] = await tx.select().from(tasks).where(eq(tasks.id, binding.taskId)).for("update");
      const agentId = room.roles.find(role => role.role === binding.role)?.agentId;
      const unassigned = binding.status === "queued" && canonical?.status === "todo" && canonical.claimedByType === null && canonical.claimedById === null;
      const sameOwner = canonical?.claimedByType === "agent" && canonical.claimedById === agentId && (canonical.status === "in_progress" || (binding.status === "queued" && canonical.status === "todo"));
      if (unassigned || sameOwner) continue;
      if (binding.status !== "running") await tx.update(campTasks).set({ status: "blocked" }).where(eq(campTasks.taskId, binding.taskId));
      canonicalChanged = true;
    }
    if (canonicalChanged) { await stopGoal(tx, room, goal, "canonical_task_changed"); continue; }
    const operations = await tx.select().from(campOperations).where(and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt)));
    const hasActive = bindings.some(task => task.status === "running") || operations.some(operation => operation.status === "running");
    if (!hasActive && (bindings.some(task => task.status === "queued" || task.status === "waiting_question") || operations.some(operation => operation.status === "queued")) && goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); continue; }
    const requiredRoles = new Set(bindings.filter(task => ["running", "queued", "waiting_question"].includes(task.status)).map(task => task.role));
    for (const role of requiredRoles) {
      const identity = room.roles.find(config => config.role === role);
      if (!identity || !await roleAvailable(tx, room, identity.agentId)) { await stopGoal(tx, room, goal, "role_unavailable"); break; }
    }
  }
  const expired = await tx.select().from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.status, "running"), lte(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
  for (const run of expired) {
    if (run.executor !== "agent") {
      requireOperationRun(run);
      const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, run.operationId));
      if (!operation) continue;
      const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, operation.goalId));
      const cancelled = run.cancelRequestedAt !== null;
      const stopped = !goal || !["queued", "running"].includes(goal.status) || goal.attempt !== operation.goalAttempt;
      const inspection = operation.kind === "integration";
      // Lease expiry cannot prove whether the native Store mutation finished.
      // A cancellation or budget reason is a separate fact, never clearance.
      if (inspection && goal) await tx.update(campGoals).set({ integrationInspectionRequired: true }).where(eq(campGoals.id, goal.id));
      const terminal = inspection || operation.infrastructureFailures + 1 >= 3;
      await tx.update(campRuns).set({ status: cancelled ? "cancelled" : "failed", error: cancelled ? "cancelled_after_lease_expiry" : "lease_expired", completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, run.id));
      await tx.update(campOperations).set({ status: cancelled ? "cancelled" : stopped ? "blocked" : terminal ? "failed" : "queued", infrastructureFailures: operation.infrastructureFailures + (cancelled ? 0 : 1) }).where(eq(campOperations.id, operation.id));
      await tx.insert(campEvents).values({ roomId: room.id, goalId: operation.goalId, runId: run.id, type: cancelled ? "cancelled" : "lease_expired", content: `${operation.kind} lease expired; execution is fenced and cleanup remains unconfirmed` });
      if (goal && terminal && !stopped && !cancelled) await stopGoal(tx, room, goal, inspection ? "integration_inspection_required" : "run_attempts_exhausted");
      continue;
    }
    requireAgentRun(run);

    const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
    if (!binding) continue;
    const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
    const cancelled = run.cancelRequestedAt !== null;
    const stopped = !goal || !["queued", "running", "waiting_question"].includes(goal.status) || goal.attempt !== binding.goalAttempt;
    const terminal = binding.infrastructureFailures + 1 >= 3;
    await tx.update(campRuns).set({ status: cancelled ? "cancelled" : "failed", error: cancelled ? "cancelled_after_lease_expiry" : "lease_expired", completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, run.id));
    await tx.update(campTasks).set({ status: cancelled ? "cancelled" : stopped ? "blocked" : terminal ? "failed" : "queued", infrastructureFailures: cancelled ? binding.infrastructureFailures : binding.infrastructureFailures + 1 }).where(eq(campTasks.taskId, run.taskId));
    if (terminal || cancelled || stopped) {
      const [canonical] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId)).for("update");
      if (canonical?.claimedByType === "agent" && canonical.claimedById === run.agentId && canonical.status === "in_progress") assertMutation(await withCampTaskMutation(room.id, run.taskId, () => forceUpdateTaskStatus(run.taskId, "closed", "agent", run.agentId)));
    }
    await tx.insert(campEvents).values({ roomId: room.id, goalId: binding.goalId, runId: run.id, type: cancelled ? "cancelled" : "lease_expired", content: cancelled ? "Worker lease expired after cancellation; cleanup is unconfirmed and this task will not retry automatically" : terminal ? "Run lease expired; retry limit reached; cleanup is unconfirmed" : "Run lease expired; API ownership is fenced, old sandbox cleanup is unconfirmed" });
    if (goal && terminal && !stopped && !cancelled) await stopGoal(tx, room, goal, "run_attempts_exhausted");
  }
  goals = await tx.select().from(campGoals).where(eq(campGoals.roomId, room.id));
  const allBindings = await tx.select().from(campTasks).where(eq(campTasks.roomId, room.id));
  const byTask = new Map(allBindings.map(binding => [binding.taskId, binding]));
  for (const goal of goals) {
    if (["queued", "running", "waiting_question"].includes(goal.status) && allBindings.some(binding => binding.goalId === goal.id && binding.goalAttempt === goal.attempt && binding.status === "queued" && binding.dependsOn.some(id => !byTask.has(id) || ["failed", "cancelled", "blocked"].includes(byTask.get(id)!.status)))) {
      await stopGoal(tx, room, goal, "dependency_blocked");
    }
    await refreshGoal(tx, room, goal.id);
  }
}

export type CampClaimIntent = { claimId: string; runToken: string };

/** Every Camp lifecycle operation locks its room first, then uses Raft task writers. */
export async function claimRunDetailed(principal: CampPrincipal, workerId: string, intent?: CampClaimIntent, declaration?: CampWorkerDeclaration, restoreOnly = false): Promise<{ run: CampClaimedRun | null; closed?: boolean; unbound?: boolean; admission?: CampClaimAdmission; compatibility?: CampWorkerCompatibility | null; requirements?: CampTaskRequirements | null }> {
  requireWorker(principal);
  if (restoreOnly && !intent) throw new CampError(400, "claim_intent_required", "Restore-only claims require the original claim identifier and credential");
  return getDb().transaction(async tx => {
    const [existingRoom] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId)).for("update");
    if (!existingRoom) throw new CampError(404, "room_not_found", "Room not found");
    await validateWorker(tx, principal);
    const room = existingRoom;
    if (intent) {
      const [claimed] = await tx.select().from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.claimId, intent.claimId)));
      if (claimed) {
        if (claimed.workerId !== workerId || claimed.runTokenHash !== hashCampToken(intent.runToken)) throw new CampError(409, "claim_conflict", "This claim identifier is already bound to another worker or run credential");
        const [live] = await tx.select({ id: campRuns.id }).from(campRuns).where(and(eq(campRuns.id, claimed.id), eq(campRuns.status, "running"), isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
        if (!live) return { run: null, closed: true };
        await fencedRun(tx, principal, claimed.id, workerId, claimed.epoch);
        // A response-loss replay returns the original negotiated contract. A
        // replacement binary may inspect/recover it, but cannot renegotiate the
        // already-owned run or replace its immutable declaration snapshot.
        return { run: await claimedContext(tx, room, claimed, intent.runToken), ...(claimed.workerProtocol ? { compatibility: checkWorkerCompatibility(claimed.workerProtocol.declaration, claimed.workerProtocol.requirements), requirements: claimed.workerProtocol.requirements } : {}) };
      }
    }
    if (restoreOnly) return { run: null, unbound: true };
    if (await activeStorageOperation(tx, room.id)) return { run: null, compatibility: null, requirements: null, admission: { status: "waiting", reason: "storage_maintenance" } };
    const protocol = declaration === undefined ? null : parseWorkerDeclaration(declaration);
    if (room.storageId) {
      const compatibility = physicalPoolCompatibility(room, workerId, protocol, { status: "compatible", code: "compatible", protocolVersion: null, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] });
      if (compatibility.status === "incompatible") return { run: null, compatibility, requirements: null };
    }
    await lockRoom(tx, room.id);
    await reconcileCampRoom(tx, room);
    let incompatibility: CampWorkerCompatibility | null = null;
    let incompatibleRequirements: CampTaskRequirements | null = null;
    const waiting: { value?: { compatibility: CampWorkerCompatibility; requirements: CampTaskRequirements; admission: CampClaimAdmission } } = {};
    const waitFor = (compatibility: CampWorkerCompatibility, requirements: CampTaskRequirements, reason: CampClaimAdmission["reason"]) => {
      waiting.value ??= { compatibility, requirements, admission: { status: "waiting", reason } };
    };
    const bindings = await tx.select().from(campTasks).where(eq(campTasks.roomId, room.id)).orderBy(sql`CASE WHEN ${campTasks.kind} = 'clarification' THEN 0 WHEN ${campTasks.kind} = 'review' THEN 1 ELSE 2 END`, sql`(SELECT task_number FROM tasks WHERE id = ${campTasks.taskId})`, asc(campTasks.taskId));
    const occupied = await roomOccupancy(tx, room.id);
    const operations = await tx.select().from(campOperations).where(and(eq(campOperations.roomId, room.id), eq(campOperations.status, "queued"))).orderBy(asc(campOperations.createdAt), asc(campOperations.id));
    for (const operation of operations) {
      const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, operation.goalId), eq(campGoals.attempt, operation.goalAttempt)));
      if (!goal || !["queued", "running"].includes(goal.status)) continue;
      const requirements = getTaskRequirements({ protocolVersion: goal.protocolVersion, workflow: "serial", taskKind: operation.kind, inputCandidate: operation.inputCandidate, verificationPolicy: operation.verificationPolicy });
      const compatibility = poolCompatibility(room, goal, workerId, protocol, checkWorkerCompatibility(protocol, requirements));
      if (compatibility.status !== "compatible") { incompatibility ??= compatibility; incompatibleRequirements ??= requirements; continue; }
      if (occupied.length) {
        waitFor(compatibility, requirements, occupied.some(run => run.status !== "running") ? "cleanup_pending" : "room_capacity");
        continue;
      }
      if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); continue; }
      await pinExecutionPool(tx, room, goal, protocol);
      const runToken = intent?.runToken ?? newCampToken("run"), epoch = operation.attempt + 1;
      const [run] = await tx.insert(campRuns).values({ executor: operation.kind, operationId: operation.id, roomId: room.id, epoch, workerId, claimId: intent?.claimId, runTokenHash: hashCampToken(runToken), workerProtocol: { version: compatibility.protocolVersion!, declaration: protocol!, requirements }, leaseExpiresAt: nextLease(), inputCandidate: operation.inputCandidate }).returning();
      await tx.update(campOperations).set({ status: "running", attempt: epoch }).where(eq(campOperations.id, operation.id));
      await tx.update(campGoals).set({ status: "running", runCount: goal.runCount + 1 }).where(eq(campGoals.id, goal.id));
      await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: run.id, type: `${operation.kind}_claimed`, content: `Trusted ${operation.kind} started without a model role` });
      await observeWorker(tx, room.id, workerId, protocol, compatibility, requirements, run.id);
      return { run: await claimedContext(tx, room, run, runToken), compatibility, requirements };
    }
    for (const binding of bindings) {
      if (binding.status !== "queued" || binding.dependsOn.some(id => bindings.find(other => other.taskId === id)?.status !== "completed")) continue;
      const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, binding.goalId), eq(campGoals.attempt, binding.goalAttempt)));
      if (!goal || !["queued", "running", "waiting_question"].includes(goal.status)) continue;
      const { inputCandidate: selectedInput } = await effectiveExecutionInput(tx, binding, goal);
      const missingFrozenVersion = goal.workflow === "serial" && goal.protocolVersion === null;
      const requirements = getTaskRequirements({ protocolVersion: missingFrozenVersion ? CAMP_PROTOCOL_VERSION : goal.protocolVersion ?? (protocol ? [...CAMP_SUPPORTED_PROTOCOL_VERSIONS].filter(version => version <= 2 && protocol.protocolVersions.includes(version)).sort((a, b) => b - a)[0] ?? 2 : null), workflow: goal.workflow, taskKind: binding.kind, inputCandidate: selectedInput, verificationPolicy: goal.verificationPolicy });
      // A corrupt or incompletely migrated serial goal must remain visible as
      // incompatible; never infer and allocate a rolling execution contract.
      if (missingFrozenVersion) {
        incompatibility ??= { status: "incompatible", code: "protocol_unsupported", protocolVersion: null, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] };
        incompatibleRequirements ??= { ...requirements, protocolVersion: null };
        continue;
      }
      const compatibility = poolCompatibility(room, goal, workerId, protocol, checkWorkerCompatibility(protocol, requirements));
      if (compatibility.status === "incompatible") {
        incompatibility ??= compatibility; incompatibleRequirements ??= requirements;
        continue;
      }
      if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); continue; }
      const parallel = ["parallel_pair", "bounded_dag"].includes(goal.planMode);
      const occupiedLane = occupied.find(run => run.workerId === workerId || run.taskId === binding.taskId);
      if (occupiedLane) { waitFor(compatibility, requirements, occupiedLane.status === "running" ? "lane_busy" : "cleanup_pending"); continue; }
      if (goal.workflow === "serial" && (parallel ? occupied.length >= 2 || occupied.some(run => run.executor !== "agent") : occupied.length > 0)) {
        waitFor(compatibility, requirements, occupied.some(run => run.status !== "running") ? "cleanup_pending" : occupied.some(run => run.executor !== "agent") ? "system_operation_busy" : "room_capacity");
        continue;
      }
      const role = room.roles.find(row => row.role === binding.role);
      if (!role) continue;
      const roleRuns = occupied.filter(run => run.agentId === role.agentId);
      const parallelBuild = parallel && binding.kind === "build" && roleRuns.every(run => bindings.find(value => value.taskId === run.taskId)?.kind === "build");
      if (roleRuns.length >= (parallelBuild ? 2 : 1)) { waitFor(compatibility, requirements, "role_busy"); continue; }
      if (!await roleAvailable(tx, room, role.agentId)) continue;
      const [canonical] = await tx.select().from(tasks).where(eq(tasks.id, binding.taskId)).for("update");
      const unassigned = canonical?.claimedByType === null && canonical.claimedById === null && canonical.status === "todo";
      const sameOwner = canonical?.claimedByType === "agent" && canonical.claimedById === role.agentId;
      if (!canonical || !["todo", "in_progress"].includes(canonical.status) || (!unassigned && !sameOwner)) {
        // Preserve an unexpected canonical owner rather than silently taking it
        // over. Block this binding before stopping descendants so cleanup does
        // not close the independently changed canonical row either.
        await tx.update(campTasks).set({ status: "blocked" }).where(eq(campTasks.taskId, binding.taskId));
        await stopGoal(tx, room, goal, "canonical_task_changed");
        continue;
      }
      assertMutation(await withCampTaskMutation(room.id, binding.taskId, () => assignTask(binding.taskId, { type: "agent", id: role.agentId }, "agent", role.agentId)));
      await taskState(room.id, binding.taskId, "in_progress", role.agentId);
      await pinExecutionPool(tx, room, goal, protocol);
      const runToken = intent?.runToken ?? newCampToken("run");
      const epoch = binding.attempt + 1;
      await tx.update(campTasks).set({ status: "running", attempt: epoch }).where(eq(campTasks.taskId, binding.taskId));
      const [run] = await tx.insert(campRuns).values({ roomId: room.id, taskId: binding.taskId, role: binding.role, agentId: role.agentId, epoch, workerId, claimId: intent?.claimId, workerProtocol: protocol ? { version: compatibility.protocolVersion!, declaration: protocol, requirements } : null, runTokenHash: hashCampToken(runToken), leaseExpiresAt: nextLease(), inputCandidate: selectedInput }).returning();
      await tx.update(campQuestions).set({ activeRunId: run.id }).where(and(eq(campQuestions.taskId, binding.taskId), eq(campQuestions.goalAttempt, goal.attempt), eq(campQuestions.status, "pending"), isNull(campQuestions.resumedAt)));
      await tx.update(campGoals).set({ status: "running", runCount: goal.runCount + 1, startedAt: sql`coalesce(${campGoals.startedAt}, clock_timestamp())`, deadlineAt: sql`coalesce(${campGoals.deadlineAt}, clock_timestamp() + ${goal.budget.maxDurationSeconds} * interval '1 second')` }).where(eq(campGoals.id, goal.id));
      await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: run.id, type: "claimed", content: `${role.role} started task ${binding.taskId}` });
      await observeWorker(tx, room.id, workerId, protocol, compatibility, requirements, run.id);
      return { run: { ...await executionContext(tx, room, run), runToken }, compatibility, requirements };
    }
    // A compatible candidate waiting on physical or role capacity is more
    // useful than a different, earlier task this binary cannot execute. Keep
    // that positive observation rather than erasing it on every idle poll.
    const observation = waiting.value ?? { compatibility: incompatibility, requirements: incompatibleRequirements };
    await observeWorker(tx, room.id, workerId, protocol, observation.compatibility, observation.requirements);
    return { run: null, ...observation };
  });
}

export async function claimRun(principal: CampPrincipal, workerId: string, declaration?: CampWorkerDeclaration): Promise<CampClaimedRun | null> {
  return (await claimRunDetailed(principal, workerId, undefined, declaration)).run;
}

async function stateOfRun(tx: DatabaseExecutor, principal: CampPrincipal, runId: string) {
  const [row] = await tx.select({ run: campRuns, goalId: sql<string>`coalesce(${campTasks.goalId}, ${campOperations.goalId})`, goalAttempt: sql<number>`coalesce(${campTasks.goalAttempt}, ${campOperations.goalAttempt})`, latestEpoch: sql<number>`coalesce(${campTasks.attempt}, ${campOperations.attempt})`, taskKind: sql<string>`case when ${campRuns.executor} <> 'agent' then ${campRuns.executor} else ${campTasks.kind} end`, planItemKey: campTasks.planItemKey }).from(campRuns)
    .leftJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).leftJoin(campOperations, eq(campOperations.id, campRuns.operationId)).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, principal.roomId)));
  if (!row) throw new CampError(404, "run_not_found", "Run not found");
  const clock = await tx.execute(sql`select clock_timestamp()::text as now`);
  const now = String(clock.rows[0]?.now);
  const run = row.run;
  const [ack] = await tx.select({ id: campEvents.id }).from(campEvents).where(and(eq(campEvents.runId, run.id), eq(campEvents.type, "cleanup_confirmed"))).limit(1);
  const cleanupState = ack || (run.status !== "running" && run.summary !== null) ? "confirmed" : run.status === "running" ? "pending" : "unknown";
  return { run: { id: run.id, executor: run.executor, operationId: run.operationId, roomId: run.roomId, taskId: run.taskId, goalId: row.goalId, goalAttempt: row.goalAttempt, workerId: run.workerId, epoch: run.epoch, status: run.status, leaseExpiresAt: run.leaseExpiresAt.toISOString(), cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null, cancelRequested: run.cancelRequestedAt !== null, cleanupState, taskKind: row.taskKind, planItemKey: row.planItemKey, inputCandidate: run.inputCandidate, candidate: run.candidate, questionId: run.questionId, workerProtocol: run.workerProtocol, claimId: run.claimId },
    cleanupState, leaseValid: run.status === "running" && run.leaseExpiresAt.getTime() > new Date(now).getTime(), replaced: row.latestEpoch > run.epoch, serverNow: new Date(now).toISOString() };
}

/** Recovery inspection stays available for expired/terminal runs. It grants no
 * lease and never reopens ownership or exposes the run credential hash. */
export async function runState(principal: CampPrincipal, runId: string) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    await validateWorker(tx, principal);
    return stateOfRun(tx, principal, runId);
  });
}

export async function workerStates(principal: CampPrincipal, workerId: string) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    await validateWorker(tx, principal);
    const rows = await tx.select({ id: campRuns.id }).from(campRuns).where(and(eq(campRuns.roomId, principal.roomId), eq(campRuns.workerId, workerId))).orderBy(desc(campRuns.createdAt)).limit(200);
    const runs = [];
    for (const row of rows) runs.push(await stateOfRun(tx, principal, row.id));
    return { runs, serverNow: new Date().toISOString() };
  });
}

export async function confirmRunCleanup(principal: CampPrincipal, runId: string, workerId: string, epoch: number) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    // Recovery must also work after a channel was archived. It carries no new
    // execution authority and leaves the previous run's outcome and lease intact.
    const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId)).for("update");
    if (!room) throw new CampError(404, "room_not_found", "Room not found");
    await validateWorker(tx, principal);
    const state = await stateOfRun(tx, principal, runId);
    if (state.run.workerId !== workerId || state.run.epoch !== epoch) throw fail();
    if (state.run.status === "running" && state.leaseValid && !state.run.cancelRequested) throw new CampError(409, "run_still_active", "Cleanup cannot be confirmed for a normally running live lease");
    if (state.cleanupState !== "confirmed") await tx.insert(campEvents).values({ roomId: room.id, goalId: state.run.goalId, runId, type: "cleanup_confirmed", content: `Trusted worker confirmed resource cleanup for epoch ${epoch}` });
    return { ...await stateOfRun(tx, principal, runId), room };
  });
}

export async function fencedRun(tx: DatabaseExecutor, principal: CampPrincipal, runId: string, workerId?: string, epoch?: number, allowCancellation = false, allowRoleCleanup = false) {
  const room = await lockRoom(tx, principal.roomId);
  if (principal.kind === "worker") await validateWorker(tx, principal);
  if (principal.kind === "run" && principal.runId !== runId) throw fail();
  const [run] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, room.id), eq(campRuns.status, "running"), allowCancellation ? undefined : isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`))).for("update");
  if (!run || (workerId !== undefined && run.workerId !== workerId) || (epoch !== undefined && run.epoch !== epoch) || (principal.kind === "run" && principal.epoch !== run.epoch)) throw fail();
  if (run.executor === "agent") {
    requireAgentRun(run);
    const [canonical] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId)).for("update");
    if (!canonical || canonical.claimedByType !== "agent" || canonical.claimedById !== run.agentId || canonical.status !== "in_progress") throw new CampError(409, "canonical_task_changed", "The canonical task assignment or execution state changed; stop the sandbox and use Camp recovery controls");
    // A room credential owns execution, not the role's revoked identity. Hold
    // live membership through the transaction for either credential type.
    // Once cancellation is requested the host may maintain its cleanup lease;
    // a cancelled completion may also settle cleanup immediately. Neither
    // permission permits a successful model result after revocation.
    const cleanupAuthority = principal.kind === "worker" && allowCancellation && (allowRoleCleanup || run.cancelRequestedAt !== null);
    if (!cleanupAuthority && !await roleAvailable(tx, room, run.agentId)) throw new CampError(403, "role_unavailable", "This role is no longer a current channel and server member");
  } else {
    requireWorker(principal); requireOperationRun(run);
    const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, run.operationId));
    if (!operation || operation.kind !== run.executor || operation.status !== "running" || operation.attempt !== run.epoch) throw fail();
  }
  return { room, run };
}

export async function heartbeatRun(principal: CampPrincipal, runId: string, workerId: string, epoch: number) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    const owned = await fencedRun(tx, principal, runId, workerId, epoch, true);
    const [run] = await tx.update(campRuns).set({ leaseExpiresAt: nextLease(), heartbeatAt: sql`now()` }).where(eq(campRuns.id, runId)).returning({ id: campRuns.id, epoch: campRuns.epoch, leaseExpiresAt: campRuns.leaseExpiresAt });
    return { run, cancelRequested: owned.run.cancelRequestedAt !== null };
  });
}

export async function runContext(principal: CampPrincipal, runId: string) {
  return getDb().transaction(async tx => {
    const { room, run } = await fencedRun(tx, principal, runId);
    if (run.executor !== "agent") { requireWorker(principal); const context = await claimedContext(tx, room, run, ""); return { ...context, run: context }; }
    const context = await executionContext(tx, room, run);
    const reports = await runReports(tx, runId);
    // Agent plugins receive the project identity and parent artifacts, never host
    // Store/discovery paths or either credential hash.
    return { run: { ...context, project: { name: room.project.name, baseRef: room.project.baseRef }, review: reports.review }, reviewTarget: context.reviewTarget, planMode: context.planMode, workflow: context.workflow, protocolVersion: context.protocolVersion, workerProtocol: context.workerProtocol, taskKind: context.taskKind, planItemKey: context.planItemKey, inputCandidate: context.inputCandidate, baseRef: context.baseRef, plan: context.plan, finalCandidate: context.finalCandidate, finalization: context.finalization, verificationReceipt: context.verificationReceipt, verificationPolicy: context.verificationPolicy, goalBaseline: context.goalBaseline, questions: context.questions, question: context.question, assignedQuestion: context.assignedQuestion, blockingQuestion: context.blockingQuestion, ...reports, ...await roomMessages(room.id) };
  });
}

export async function recordRunEvent(principal: CampPrincipal, runId: string, input: { workerId?: string; epoch: number; type: string; content: string; artifact?: CampArtifact; toRole?: CampRole }) {
  return getDb().transaction(async tx => {
    const { room, run } = await fencedRun(tx, principal, runId, input.workerId, input.epoch);
    requireAgentRun(run);
    if (!await roleAvailable(tx, room, run.agentId)) throw new CampError(403, "role_unavailable", "This role is no longer a current channel and server member");
    // Candidate identities authorize the next workspace's base commit. Only
    // the trusted host worker can attest them; model reports are annotations.
    if (principal.kind === "run" && input.artifact && !["file", "review"].includes(input.artifact.type)) {
      throw new CampError(403, "worker_artifact_required", "Run credentials may report only file and review artifacts; runtime candidates require the trusted worker");
    }
    if (input.artifact?.type === "review") {
      const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
      if (run.role !== "reviewer" || !["review", "final_review"].includes(binding.kind)) throw new CampError(403, "reviewer_role_required", "Only the current review task may submit a verdict");
      reviewArtifact(input.artifact, input.content);
      const target = (await executionContext(tx, room, run)).reviewTarget;
      const candidate = input.artifact.candidate as CampReviewTarget | undefined;
      if (!sameReviewTarget(target, candidate)) throw new CampError(409, "review_candidate_mismatch", "The review must name the trusted candidate supplied by this run's context");
    }
    if (input.artifact) {
      const prior = await tx.select({ artifact: campEvents.artifact }).from(campEvents).where(and(eq(campEvents.runId, runId), isNotNull(campEvents.artifact))).limit(32);
      if (input.artifact.type === "layerfs") {
        candidateIdentity(input.artifact);
        if (prior.some(event => event.artifact?.type === "layerfs") || Buffer.byteLength(JSON.stringify(input.artifact)) > 16 * 1024) throw new CampError(400, "artifact_budget_exhausted", "A trusted worker may report one bounded runtime candidate per run");
      } else assertReportedArtifactBudget([...prior.flatMap(event => event.artifact && event.artifact.type !== "layerfs" ? [event.artifact] : []), input.artifact]);
    }
    const message = await createMessage(room.channelId, "agent", run.agentId, input.content, "chat", undefined, { actionMetadata: { camp: { runId, epoch: run.epoch, kind: input.type, toRole: input.toRole ?? null, artifact: input.artifact ?? null } } });
    const [event] = await tx.insert(campEvents).values({ roomId: room.id, runId, type: input.type, content: input.content, artifact: input.artifact, toRole: input.toRole, messageId: message.id }).returning();
    return { message, event, room };
  });
}

async function completeVerificationRun(tx: DatabaseExecutor, principal: CampPrincipal, room: Room, existing: Run, workerId: string, epoch: number, input: CampCompletion) {
  requireVerificationRun(existing); requireWorker(principal);
  const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, existing.operationId));
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, operation.goalId));
  if (input.status === "suspended" || input.integration || input.outcome || input.candidate || input.changeSet || input.questionId || input.sessionId || (input.artifacts?.length ?? 0) > 0) throw new CampError(400, "verification_payload_invalid", "A trusted verification cannot impersonate a model task or publish a new candidate");
  const reportedInput = input.inputCandidate ? candidateIdentity(input.inputCandidate) : null;
  const verification = input.verification ? checkedVerificationReport(operation, input.verification) : null;
  if (existing.status !== "running") {
    if (existing.summary !== null && existing.status === input.status && existing.summary === input.summary && existing.error === (input.error ?? null) && isDeepStrictEqual(existing.inputCandidate, reportedInput) && isDeepStrictEqual(existing.verification, verification)) return { run: completionFields(existing), message: null, room, replayed: true as const };
    throw fail("This verification already settled with a different result");
  }
  await fencedRun(tx, principal, existing.id, workerId, epoch, input.status === "cancelled");
  if (!goal || goal.attempt !== operation.goalAttempt) throw fail("This goal attempt was replaced");
  const successful = input.status === "completed", active = ["queued", "running"].includes(goal.status);
  const [expired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
  if (successful && (!active || expired || goal.baseHeadRevision !== room.acceptedRevision)) throw fail("The verification's goal, deadline or baseline changed");
  if (successful && (!verification || !reportedInput || !sameCandidate(reportedInput, operation.inputCandidate))) throw new CampError(409, "verification_receipt_required", "The trusted worker must attest the exact input and all operator check results");
  const infrastructure = input.status === "failed" && ["worker_interrupted", "worker_shutdown"].includes(input.error ?? "");
  const retry = infrastructure && operation.infrastructureFailures + 1 < 3 && goal.runCount < goal.budget.maxRuns && !expired && active && goal.baseHeadRevision === room.acceptedRevision;
  const [completed] = await tx.update(campRuns).set({ status: input.status, summary: input.summary, error: input.error, verification, inputCandidate: reportedInput, completionPayloadHash: completionFingerprint(input), completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, existing.id)).returning();
  let receipt = null;
  if (successful && verification) receipt = await finishVerification(tx, room, goal, operation, existing.id, verification);
  else {
    await tx.update(campOperations).set({ status: retry ? "queued" : input.status === "cancelled" ? "cancelled" : "failed", infrastructureFailures: operation.infrastructureFailures + (infrastructure ? 1 : 0) }).where(eq(campOperations.id, operation.id));
    if (!retry && active) await stopGoal(tx, room, goal, input.status === "cancelled" ? "run_cancelled" : infrastructure ? "run_attempts_exhausted" : "verification_error");
  }
  await refreshGoal(tx, room, goal.id);
  const [event] = await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: existing.id, type: receipt ? `verification_${receipt.status}` : input.status, content: input.summary }).returning();
  return { run: completionFields(completed), message: null, event, room, replayed: false as const };
}

async function completeIntegrationRun(tx: DatabaseExecutor, principal: CampPrincipal, room: Room, existing: Run, workerId: string, epoch: number, input: CampCompletion) {
  requireOperationRun(existing); requireWorker(principal);
  const [operation] = await tx.select().from(campOperations).where(eq(campOperations.id, existing.operationId));
  const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, operation.goalId));
  if (input.status === "suspended" || input.verification || input.outcome || input.questionId || input.sessionId || (input.artifacts?.length ?? 0) > 0) throw new CampError(400, "integration_payload_invalid", "A trusted integration cannot impersonate an agent or verifier");
  const reportedInput = input.inputCandidate ? candidateIdentity(input.inputCandidate) : null;
  const report = input.integration ? checkedIntegrationReport(operation, input.integration) : null;
  const candidate = input.candidate ? candidateIdentity(input.candidate) : null;
  const changeSet = input.changeSet ? parseChangeSet(input.changeSet) : null;
  if (existing.status !== "running") throw fail("This integration already settled without a replayable original payload");
  await fencedRun(tx, principal, existing.id, workerId, epoch, input.status === "cancelled");
  if (!goal || goal.attempt !== operation.goalAttempt || operation.kind !== "integration") throw fail("This goal attempt was replaced");
  const successful = input.status === "completed", active = ["queued", "running"].includes(goal.status);
  const [expired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
  if (successful && (!active || expired || goal.baseHeadRevision !== room.acceptedRevision)) throw fail("The integration's goal, deadline or baseline changed");
  if (successful && (!report || !sameCandidate(reportedInput, operation.inputCandidate))) throw new CampError(409, "integration_receipt_required", "The trusted worker must attest the exact frozen integration input");
  if (report?.status === "merged") {
    if (!sameCandidate(candidate, report.candidate) || !changeSet || !sameCandidate(changeSet.base, goal.protocolVersion === 5 ? goal.baseCandidate : operation.inputCandidate) || !sameCandidate(changeSet.target, report.candidate)) throw new CampError(409, "integration_candidate_mismatch", "The merged candidate and cumulative changes must match the integration report");
  } else if (candidate || changeSet) throw new CampError(400, "integration_payload_invalid", "Only a validated merged report can publish a candidate or changes");
  if (!successful && report) throw new CampError(400, "integration_payload_invalid", "Only completed integration executions may record a business result");
  if (input.error === "camp_integration_inspection_required") {
    if (successful) throw new CampError(400, "integration_payload_invalid", "An uncertain native outcome cannot also publish a validated integration");
    await tx.update(campGoals).set({ integrationInspectionRequired: true }).where(eq(campGoals.id, goal.id));
  }
  const infrastructure = input.status === "failed" && ["worker_interrupted", "worker_shutdown"].includes(input.error ?? "");
  const retry = infrastructure && operation.infrastructureFailures + 1 < 3 && goal.runCount < goal.budget.maxRuns && !expired && active && goal.baseHeadRevision === room.acceptedRevision;
  const [completed] = await tx.update(campRuns).set({ status: input.status, summary: input.summary, error: input.error, integration: report, inputCandidate: reportedInput, candidate, changeSet, completionPayloadHash: completionFingerprint(input), completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, existing.id)).returning();
  let receipt = null;
  if (successful && report) receipt = await finishIntegration(tx, room, goal, operation, existing.id, report);
  else {
    await tx.update(campOperations).set({ status: retry ? "queued" : input.status === "cancelled" ? "cancelled" : "failed", infrastructureFailures: operation.infrastructureFailures + (infrastructure ? 1 : 0) }).where(eq(campOperations.id, operation.id));
    if (!retry && active) await stopGoal(tx, room, goal, input.status === "cancelled" ? "run_cancelled" : input.error === "camp_integration_inspection_required" ? "integration_inspection_required" : infrastructure ? "run_attempts_exhausted" : "integration_error");
  }
  await refreshGoal(tx, room, goal.id);
  const [event] = await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: existing.id, type: receipt ? `integration_${receipt.status}` : input.status, content: input.summary }).returning();
  return { run: completionFields(completed), message: null, event, room, replayed: false as const };
}

export async function completeRun(principal: CampPrincipal, runId: string, workerId: string, epoch: number, input: CampCompletion) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId)).for("update");
    if (!room) throw new CampError(404, "room_not_found", "Room not found");
    await validateWorker(tx, principal);
    const [existing] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, principal.roomId))).for("update");
    if (!existing || existing.workerId !== workerId || existing.epoch !== epoch) throw fail();
    if (existing.status !== "running" && existing.completionPayloadHash !== null) {
      if (existing.completionPayloadHash !== completionFingerprint(input)) throw fail("This run already settled with a different original payload");
      return { run: completionFields(existing), room, replayed: true as const };
    }
    if (existing.executor === "integration") return completeIntegrationRun(tx, principal, room, existing, workerId, epoch, input);
    if (existing.executor === "verification") return completeVerificationRun(tx, principal, room, existing, workerId, epoch, input);
    requireAgentRun(existing);
    if (existing.status !== "running") {
      // Legacy rows have no original request hash. Compare only stored final
      // facts and permit retransmitting annotations already present there;
      // a rolling deployment's live-event display window is not authority.
      const legacyInput = input.inputCandidate ? candidateIdentity(input.inputCandidate) : null;
      const legacyOutput = input.candidate ? candidateIdentity(input.candidate) : null;
      const legacyChanges = input.changeSet ? parseChangeSet(input.changeSet) : null;
      const annotations = [...input.artifacts ?? [], ...legacyOutput ? [legacyOutput] : []];
      if (!input.verification && !input.integration && existing.summary !== null && existing.status === input.status && existing.summary === input.summary && existing.sessionId === (input.sessionId ?? null) && existing.error === (input.error ?? null) && (input.outcome === undefined || existing.outcome === input.outcome) && existing.questionId === (input.questionId ?? null) && isDeepStrictEqual(existing.inputCandidate, legacyInput) && isDeepStrictEqual(existing.candidate, legacyOutput) && isDeepStrictEqual(existing.changeSet, legacyChanges) && annotations.every(value => existing.artifacts.some(stored => isDeepStrictEqual(stored, value)))) return { run: completionFields(existing), room, replayed: true as const };
      throw fail("This legacy run already settled with different final facts");
    }
    const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, existing.taskId));
    const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
    const reports = await runReports(tx, runId);
    const reportedInput = input.inputCandidate ? candidateIdentity(input.inputCandidate) : null;
    const reportedOutput = input.candidate ? candidateIdentity(input.candidate) : null;
    const changeSet = input.changeSet ? parseChangeSet(input.changeSet) : null;
    if (input.integration) throw new CampError(403, "integration_run_required", "A model execution cannot submit trusted integration results");
    if (input.verification) throw new CampError(403, "verification_run_required", "A model execution cannot submit trusted verification results");
    const artifacts = [...input.artifacts ?? [], ...reports.artifacts, ...reportedOutput ? [reportedOutput] : []].filter((value, index, all) => all.findIndex(other => isDeepStrictEqual(other, value)) === index);
    const reviewTask = binding.kind === "review" || binding.kind === "final_review";
    const outcome = reviewTask && input.status === "completed" ? reports.review?.outcome ?? input.outcome : input.outcome;
    if (reviewTask && input.status === "completed" && reports.review && input.outcome && input.outcome !== reports.review.outcome) throw new CampError(409, "review_mismatch", "Completion must match the review verdict recorded by this run");
    assertCompletionArtifactBudget(artifacts);
    const { run } = await fencedRun(tx, principal, runId, workerId, epoch, input.status === "cancelled", input.status === "cancelled");
    requireAgentRun(run);
    if (!goal || goal.attempt !== binding.goalAttempt) throw fail("This goal attempt has been replaced");
    const successful = input.status === "completed", suspended = input.status === "suspended";
    const active = ["queued", "running"].includes(goal.status);
    const staleBaseline = goal.workflow === "serial" && goal.baseHeadRevision !== room.acceptedRevision;
    if ((successful || suspended) && (!active || staleBaseline)) throw new CampError(409, staleBaseline ? "stale_baseline" : "stale_run", "The goal or its accepted baseline changed before completion");
    const [durationExpired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
    if ((successful || suspended) && durationExpired) throw new CampError(409, "duration_budget_exhausted", "The goal duration budget expired before completion");
    let serialCandidates: ReturnType<typeof completionCandidates> | null = null;
    if (goal.workflow === "serial" && (successful || suspended)) serialCandidates = completionCandidates(existing.inputCandidate ?? binding.inputCandidate ?? goal.baseCandidate, binding.kind, input);
    if (successful && goal.workflow === "serial" && (existing.workerProtocol?.version ?? 0) >= 2 && binding.kind === "build" && (!changeSet || !(goal.baseCandidate ?? reportedInput) || !sameCandidate(changeSet.base, goal.baseCandidate ?? reportedInput) || !sameCandidate(changeSet.target, reportedOutput))) throw new CampError(409, "change_set_required", "A completed serial v2 build must attest its cumulative change set from the goal baseline to its exact output");
    if (suspended && goal.workflow !== "serial") throw new CampError(400, "serial_workflow_required", "Question suspension is available only in a serial workflow");
    const pending = goal.workflow === "serial" ? await blockingQuestion(tx, binding.taskId, run.id) : null;
    if (successful && pending) throw new CampError(409, "question_requires_suspend", "Checkpoint and suspend this task before its pending question can be answered");
    if (successful && reviewTask) {
      if (!reports.review) throw new CampError(409, "review_required", "A structured candidate-bound review is required");
    } else if (!reviewTask && input.outcome && input.outcome !== "handoff") throw new CampError(400, "reviewer_role_required", "Only a review task may approve or request changes");
    const reviewTarget = (await executionContext(tx, room, run)).reviewTarget;
    for (const artifact of input.artifacts ?? []) {
      if (artifact.type === "review") {
        if (!reviewTask) throw new CampError(403, "reviewer_role_required", "Only a review task may return a review artifact");
        const review = reviewArtifact(artifact, input.summary);
        if (!sameReviewTarget(reviewTarget, review.candidate)) throw new CampError(409, "review_candidate_mismatch", "Completion cannot replace the trusted review candidate");
        if (reports.review && review.outcome !== reports.review.outcome) throw new CampError(409, "review_mismatch", "Completion artifacts must match the recorded review verdict");
      }
      if (goal.workflow === "serial" && artifact.type === "layerfs" && reportedOutput && (artifact.projectId !== reportedOutput.projectId || (artifact.refId ?? artifact.commitId ?? artifact.layerId) !== reportedOutput.refId || artifact.rootId !== reportedOutput.rootId)) throw new CampError(409, "candidate_artifact_mismatch", "Reported runtime artifacts cannot replace the worker's output candidate");
    }
    if (successful && goal.workflow === "serial") {
      await requireSerialCompletion(tx, goal, binding, reports.review);
      if (binding.kind === "clarification") await requireClarificationResult(tx, binding);
    }
    const infrastructureFailure = input.status === "failed" && ["worker_interrupted", "worker_shutdown"].includes(input.error ?? "");
    const infrastructureRetry = infrastructureFailure && binding.infrastructureFailures + 1 < 3 && goal.runCount < goal.budget.maxRuns && !durationExpired && active && !staleBaseline;
    if (!infrastructureRetry && !suspended) await taskState(room.id, run.taskId, successful ? "done" : "closed", run.agentId);
    const [completed] = await tx.update(campRuns).set({ status: input.status, summary: input.summary, artifacts, changeSet, inputCandidate: reportedInput, candidate: reportedOutput, questionId: input.questionId ?? null, sessionId: input.sessionId, error: input.error, outcome, completionPayloadHash: completionFingerprint(input), completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, runId)).returning();
    await tx.update(campTasks).set({ status: infrastructureRetry ? "queued" : input.status === "suspended" ? "waiting_question" : input.status, infrastructureFailures: binding.infrastructureFailures + (infrastructureFailure ? 1 : 0) }).where(eq(campTasks.taskId, run.taskId));
    if (successful && reviewTask) await tx.update(campGoals).set({ reviewRounds: goal.reviewRounds + 1 }).where(eq(campGoals.id, goal.id));
    if (successful && !goal.baseCandidate && reportedInput) await tx.update(campGoals).set({ baseCandidate: reportedInput }).where(eq(campGoals.id, goal.id));
    if (serialCandidates && !goal.baseCandidate) await tx.update(campGoals).set({ baseCandidate: serialCandidates.inputCandidate }).where(eq(campGoals.id, goal.id));
    if (suspended && serialCandidates) await suspendForQuestion(tx, room, goal, binding, run, input.questionId, serialCandidates.candidate);
    if (successful && goal.workflow === "serial" && serialCandidates) {
      if (binding.kind === "clarification") await completeClarification(tx, room, goal, binding);
      else await advanceSerial(tx, room, goal, binding, run, serialCandidates.inputCandidate, serialCandidates.candidate, reports.review);
    }
    if (successful && goal.workflow === "legacy" && reviewTask && outcome === "changes_requested") {
      if (goal.reviewRounds + 1 >= goal.budget.maxReviewRounds) await stopGoal(tx, room, goal, "review_budget_exhausted");
      else if (goal.runCount + 2 > goal.budget.maxRuns) await stopGoal(tx, room, goal, "run_budget_exhausted");
      else {
        const result = await createTasks(room.channelId, "agent", run.agentId, [{ title: "builder: address review feedback", description: input.summary }, { title: "reviewer: verify revised candidate", description: input.summary }]);
        await tx.insert(campTasks).values([
          { taskId: result.tasks[0].id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role: "builder", kind: "build", dependsOn: [run.taskId] },
          { taskId: result.tasks[1].id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role: "reviewer", kind: "review", dependsOn: [result.tasks[0].id] },
        ]);
      }
    }
    if (!successful && !suspended && !infrastructureRetry && active) await stopGoal(tx, room, goal, input.status === "cancelled" ? "run_cancelled" : staleBaseline ? "stale_baseline" : binding.infrastructureFailures + 1 >= 3 ? "run_attempts_exhausted" : goal.runCount >= goal.budget.maxRuns ? "run_budget_exhausted" : "run_failed");
    await refreshGoal(tx, room, goal.id);
    const message = await createMessage(room.channelId, "agent", run.agentId, input.summary, "chat", undefined, { actionMetadata: { camp: { runId, epoch, kind: "completion", outcome: outcome ?? null, artifacts } } });
    const [event] = await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: outcome ?? input.status, content: input.summary, messageId: message.id }).returning();
    return { run: completionFields(completed), message, event, room, replayed: false as const };
  });
}

export async function cancelRun(roomId: string, runId: string, userId: string) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [run] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, roomId))).for("update");
    if (!run) throw new CampError(404, "run_not_found", "Run not found");
    if (run.status !== "running") throw fail("The run has already ended");
    const [owner] = await tx.select({ goal: campGoals }).from(campGoals).leftJoin(campTasks, eq(campTasks.goalId, campGoals.id)).leftJoin(campOperations, eq(campOperations.goalId, campGoals.id)).where(and(eq(campGoals.roomId, roomId), run.taskId ? eq(campTasks.taskId, run.taskId) : eq(campOperations.id, run.operationId!))).limit(1);
    if (owner && ["parallel_pair", "bounded_dag"].includes(owner.goal.planMode)) await stopGoal(tx, room, owner.goal, "cancelled_by_human", true);
    const [requested] = await tx.update(campRuns).set({ cancelRequestedAt: sql`now()` }).where(eq(campRuns.id, runId)).returning({ id: campRuns.id, status: campRuns.status, cancelRequestedAt: campRuns.cancelRequestedAt });
    await tx.insert(campEvents).values({ roomId, runId, type: "cancel_requested", content: `A human requested cancellation (${userId}); waiting for worker cleanup` });
    return { room, run: requested };
  });
}
