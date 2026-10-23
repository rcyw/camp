import { assertStorageWritable } from "./storage";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { parseVerificationPolicy, parseVerificationReport, serializeVerificationPolicy, type CampCandidate, type CampVerificationReceipt, type CampVerificationReport } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campGoals, campOperations, campRooms, campRuns } from "../../db/schema";
import { integrationGatePassed, requireIntegrationGate } from "./integration";
import { sameCandidate } from "./candidates";
import { withCampRoomAdmin } from "./rooms";
import { enqueueStage } from "./workflow";
import { stopGoal } from "./goals";
import { CampError, type CampVerificationPolicySnapshot } from "./types";

type Goal = typeof campGoals.$inferSelect;
type Room = typeof campRooms.$inferSelect;
type Operation = typeof campOperations.$inferSelect;
type GateOperation = { goalId?: string; kind?: string; goalAttempt?: number; integrationReport?: Operation["integrationReport"]; integrationInput?: Operation["integrationInput"]; inputDigest?: string | null; id: string; createdAt: Date; inputCandidate: CampCandidate; status: string; receipt: Pick<CampVerificationReceipt, "status" | "candidate" | "policyDigest"> | null; verificationPolicy?: { digest: string } | null; policyDigest?: string | null };
const operationDigest = (operation: GateOperation) => operation.policyDigest ?? operation.verificationPolicy?.digest;
export function latestVerificationOperation<T extends GateOperation>(operations: readonly T[], candidate: CampCandidate | null, digest: string | undefined): T | undefined {
  return operations.filter(operation => operation.kind !== "integration" && sameCandidate(operation.inputCandidate, candidate) && operationDigest(operation) === digest).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))[0];
}
export function verificationGatePassed(operation: GateOperation | undefined, candidate: CampCandidate, digest: string | undefined) {
  return Boolean(operation && operation.status === "completed" && sameCandidate(operation.inputCandidate, candidate) && operationDigest(operation) === digest && operation.receipt?.status === "passed" && sameCandidate(operation.receipt.candidate, candidate) && operation.receipt.policyDigest === digest);
}
export const needsVerification = (goal: Pick<Goal, "workflow" | "protocolVersion">) => goal.workflow === "serial" && (goal.protocolVersion ?? 0) >= 2;
export function policySnapshot(value: unknown): CampVerificationPolicySnapshot {
  const policy = parseVerificationPolicy(value);
  return { policy, digest: createHash("sha256").update(serializeVerificationPolicy(policy)).digest("hex") };
}
export async function setVerificationPolicy(roomId: string, userId: string, value: unknown | null, expectedDigest?: string | null) {
  const snapshot = value === null ? null : policySnapshot(value);
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    await assertStorageWritable(tx, room.id);
    if (expectedDigest !== undefined && expectedDigest !== (room.verificationPolicy?.digest ?? null)) throw new CampError(409, "verification_policy_changed", "The verification policy changed; refresh before saving your draft");
    await tx.update(campRooms).set({ verificationPolicy: snapshot }).where(eq(campRooms.id, room.id));
    return snapshot;
  });
}
export async function enqueueVerification(tx: DatabaseExecutor, room: Room, goal: Goal, candidate: CampCandidate) {
  if (!goal.verificationPolicy) throw new CampError(409, "verification_policy_required", "This delivery requires a frozen operator verification policy");
  if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); return; }
  await tx.insert(campOperations).values({ roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, inputCandidate: candidate, verificationPolicy: goal.verificationPolicy });
}
export async function requireVerificationGate(tx: DatabaseExecutor, goal: Goal, candidate: CampCandidate) {
  if (!needsVerification(goal)) return null;
  const rows = await tx.select().from(campOperations).where(and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt), eq(campOperations.kind, "verification"))).orderBy(desc(campOperations.createdAt), desc(campOperations.id));
  const operation = latestVerificationOperation(rows, candidate, goal.verificationPolicy?.digest);
  if (!verificationGatePassed(operation, candidate, goal.verificationPolicy?.digest)) throw new CampError(409, "verification_required", "The exact candidate must pass its frozen operator policy before final acceptance");
  return operation!.receipt!;
}
export function checkedVerificationReport(operation: Operation, value: unknown): CampVerificationReport {
  const report = parseVerificationReport(value), policy = operation.verificationPolicy;
  if (operation.kind !== "verification" || !policy) throw new CampError(409, "verification_operation_required", "The operation must have a frozen verification policy");
  if (!sameCandidate(report.candidate, operation.inputCandidate) || report.policyDigest !== policy.digest) throw new CampError(409, "verification_candidate_mismatch", "Verification must bind this operation's exact candidate and policy");
  if (report.checks.length !== policy.policy.checks.length || report.checks.some((check, index) => check.id !== policy.policy.checks[index].id || !isDeepStrictEqual(check.argv, policy.policy.checks[index].argv))) throw new CampError(409, "verification_checks_mismatch", "Every frozen operator check must appear once in policy order with its exact argv");
  return report;
}
export async function finishVerification(tx: DatabaseExecutor, room: Room, goal: Goal, operation: Operation, runId: string, report: CampVerificationReport) {
  if (operation.kind !== "verification" || !operation.verificationPolicy) throw new CampError(409, "verification_operation_required", "The operation must have a frozen verification policy");
  const policy = operation.verificationPolicy;
  const passed = report.checks.every((check, index) => check.exitCode === 0 && check.signal === null && !check.timedOut && !check.oomKilled && !check.outputTruncated && check.durationMs <= policy.policy.checks[index].timeoutMs);
  const receipt: CampVerificationReceipt = { ...report, schemaVersion: 1, status: passed ? "passed" : "failed", runId, operationId: operation.id, verifiedAt: new Date().toISOString() };
  await tx.update(campOperations).set({ status: passed ? "completed" : "failed", receipt }).where(eq(campOperations.id, operation.id));
  if (passed) {
    await requireIntegrationGate(tx, goal);
    await requireVerificationGate(tx, goal, operation.inputCandidate);
    if (goal.runCount >= goal.budget.maxRuns) await stopGoal(tx, room, goal, "run_budget_exhausted");
    else if (goal.reviewRounds >= goal.budget.maxReviewRounds) await stopGoal(tx, room, goal, "review_budget_exhausted");
    else await enqueueStage(tx, room, goal, { kind: "final_review", candidate: operation.inputCandidate });
  } else if (goal.verificationRepairs < policy.policy.maxRepairAttempts && goal.runCount + 4 <= goal.budget.maxRuns) {
    await tx.update(campGoals).set({ verificationRepairs: goal.verificationRepairs + 1 }).where(eq(campGoals.id, goal.id));
    await enqueueStage(tx, room, goal, { kind: "build", candidate: operation.inputCandidate, feedback: `The independent operator checks failed. Repair the complete goal without changing the verification policy or external harness.\n${JSON.stringify(receipt.checks.map(({ id, exitCode, signal, timedOut, oomKilled, stdout, stderr }) => ({ id, exitCode, signal, timedOut, oomKilled, stdout, stderr })))}` });
  } else await stopGoal(tx, room, goal, goal.runCount + 4 > goal.budget.maxRuns ? "run_budget_exhausted" : "verification_failed");
  return receipt;
}
export function receiptSummary(receipt: CampVerificationReceipt | null) {
  return receipt ? { ...receipt, checks: receipt.checks.map(({ argv: _argv, stdout: _stdout, stderr: _stderr, ...check }) => check) } : null;
}
export async function operationSnapshots(roomId: string) {
  const operations = await getDb().select().from(campOperations).where(eq(campOperations.roomId, roomId)).orderBy(asc(campOperations.createdAt), asc(campOperations.id));
  const runs = operations.length ? await getDb().select({ id: campRuns.id, operationId: campRuns.operationId }).from(campRuns).where(inArray(campRuns.operationId, operations.map(row => row.id))).orderBy(desc(campRuns.createdAt), desc(campRuns.id)) : [];
  const latestRun = new Map<string, string>();
  for (const run of runs) if (run.operationId && !latestRun.has(run.operationId)) latestRun.set(run.operationId, run.id);
  return operations.map(({ verificationPolicy, receipt, ...operation }) => ({ ...operation, policyDigest: verificationPolicy?.digest ?? null, receipt: receiptSummary(receipt), latestRunId: latestRun.get(operation.id) ?? null }));
}
export async function goalVerificationSnapshot(goal: Goal, snapshots?: Awaited<ReturnType<typeof operationSnapshots>>) {
  const operations = (snapshots ?? await operationSnapshots(goal.roomId)).filter(operation => operation.goalId === goal.id && operation.goalAttempt === goal.attempt && operation.kind === "verification");
  const latest = latestVerificationOperation(operations, goal.currentCandidate, goal.verificationPolicy?.digest);
  const stoppedWithoutExecution = !latest && ["completed", "cancelled", "needs_attention"].includes(goal.status);
  const status = !needsVerification(goal) ? "not_required" : !latest ? stoppedWithoutExecution ? "not_run" : "pending" : latest.status === "completed" ? latest.receipt?.status ?? "failed" : latest.status === "queued" ? "pending" : latest.status;
  return { required: needsVerification(goal), policyDigest: goal.verificationPolicy?.digest ?? null, repairsUsed: goal.verificationRepairs, maxRepairAttempts: goal.verificationPolicy?.policy.maxRepairAttempts ?? 0, status, operations };
}

export async function deliveryResultReady(goal: Goal, operations?: readonly GateOperation[]) {
  if (goal.status !== "completed" || !goal.finalCandidate || !goal.summary) return false;
  if (operations && goal.planMode !== "bounded_dag" && !integrationGatePassed(goal, operations)) return false;
  if (!operations || goal.planMode === "bounded_dag") { try { await requireIntegrationGate(getDb(), goal); } catch (error) { if (error instanceof CampError && error.code === "integration_required") return false; throw error; } }
  if (!needsVerification(goal)) return true;
  if (operations) return verificationGatePassed(latestVerificationOperation(operations, goal.finalCandidate, goal.verificationPolicy?.digest), goal.finalCandidate, goal.verificationPolicy?.digest);
  try { await requireVerificationGate(getDb(), goal, goal.finalCandidate); return true; }
  catch (error) { if (error instanceof CampError && error.code === "verification_required") return false; throw error; }
}
