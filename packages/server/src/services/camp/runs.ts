import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { agents, campEvents, campGoals, campRooms, campRuns, campTasks, campWorkerTokens, channelAgents, channels, serverAgentMembers, tasks } from "../../db/schema";
import { createMessage } from "../messageService";
import { assignTask, createTasks, forceUpdateTaskStatus, updateTaskStatus } from "../taskService";
import { hashCampToken, lockRoom, newCampToken, roomMessages, withCampRoomAdmin } from "./rooms";
import { refreshGoal, stopGoal } from "./goals";
import { CampError, type CampArtifact, type CampClaimedRun, type CampCompletion, type CampDependency, type CampPrincipal, type CampReview, type CampReviewTarget, type CampRole } from "./types";

export const CAMP_LEASE_SECONDS = 45;
const nextLease = () => sql`clock_timestamp() + interval '45 seconds'`;
const fail = (message = "This run no longer owns the task lease") => new CampError(409, "stale_run", message);
type Run = typeof campRuns.$inferSelect;
type Room = typeof campRooms.$inferSelect;

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
  const events = await tx.select().from(campEvents).where(and(eq(campEvents.runId, runId), isNotNull(campEvents.artifact))).orderBy(desc(campEvents.seq)).limit(30);
  const review = events.find(event => event.artifact?.type === "review");
  return { review: review?.artifact ? reviewArtifact(review.artifact, review.content) : null, artifacts: events.reverse().flatMap(event => event.artifact ? [event.artifact] : []) };
}

function completionFields(run: Run) {
  return { id: run.id, roomId: run.roomId, taskId: run.taskId, status: run.status, epoch: run.epoch, summary: run.summary, artifacts: run.artifacts, outcome: run.outcome };
}

export async function authenticateCampToken(token: string): Promise<CampPrincipal> {
  if (token.startsWith("camp_worker_")) {
    const [row] = await getDb().select().from(campWorkerTokens).where(and(eq(campWorkerTokens.tokenHash, hashCampToken(token)), isNull(campWorkerTokens.revokedAt), gt(campWorkerTokens.expiresAt, sql`clock_timestamp()`)));
    if (row) return { kind: "worker", roomId: row.roomId, tokenId: row.id };
  } else if (token.startsWith("camp_run_")) {
    const [row] = await getDb().select({ id: campRuns.id, roomId: campRuns.roomId, epoch: campRuns.epoch, agentId: campRuns.agentId }).from(campRuns).where(and(eq(campRuns.runTokenHash, hashCampToken(token)), eq(campRuns.status, "running"), isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
    if (row) {
      const [room] = await getDb().select().from(campRooms).where(eq(campRooms.id, row.roomId));
      if (room && await roleAvailable(getDb(), room, row.agentId)) return { kind: "run", roomId: row.roomId, runId: row.id, epoch: row.epoch };
    }
  }
  throw new CampError(401, "camp_auth_required", "A valid Camp credential is required");
}

export function requireWorker(principal: CampPrincipal) {
  if (principal.kind !== "worker") throw new CampError(403, "worker_scope_required", "This operation requires the trusted worker credential");
}

async function validateWorker(tx: DatabaseExecutor, principal: CampPrincipal) {
  requireWorker(principal);
  if (principal.kind !== "worker") return;
  const [token] = await tx.select({ id: campWorkerTokens.id }).from(campWorkerTokens).where(and(eq(campWorkerTokens.id, principal.tokenId), eq(campWorkerTokens.roomId, principal.roomId), isNull(campWorkerTokens.revokedAt), gt(campWorkerTokens.expiresAt, sql`clock_timestamp()`))).for("share");
  if (!token) throw new CampError(401, "camp_auth_required", "The worker credential was revoked or expired");
}

function assertMutation(result: Awaited<ReturnType<typeof updateTaskStatus>>) {
  if (typeof result === "string") throw fail(result);
  return result.row;
}

async function taskState(taskId: string, desired: "in_progress" | "done" | "closed", agentId: string) {
  const [current] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  if (!current || current.claimedByType !== "agent" || current.claimedById !== agentId) throw fail("The task assignment changed");
  if (current.status === desired) return current;
  return assertMutation(await updateTaskStatus(taskId, desired, agentId, "agent"));
}

async function dependencies(tx: DatabaseExecutor, taskIds: string[]): Promise<CampDependency[]> {
  if (!taskIds.length) return [];
  const completed = await tx.select().from(campRuns).where(and(inArray(campRuns.taskId, taskIds), eq(campRuns.status, "completed"))).orderBy(desc(campRuns.createdAt));
  return taskIds.map(taskId => {
    const run = completed.find(row => row.taskId === taskId);
    return { taskId, summary: run?.summary ?? "", artifacts: run?.artifacts ?? [] };
  });
}

async function executionContext(tx: DatabaseExecutor, room: Room, run: Run) {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId));
  const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
  if (!task || !binding) throw fail();
  const role = room.roles.find(row => row.role === run.role);
  const previous = await dependencies(tx, binding.dependsOn);
  const prompt = [
    `You are the ${run.role} in Camp room ${room.name}.`, role?.instructions,
    `Task: ${task.title}`, task.description,
    "Stay within this role. Report progress and candidate artifacts. The trusted worker owns claim, completion and handoff. Never publish to main automatically.",
    run.role === "reviewer" ? "Review and test the builder's candidate. Before finishing, call the camp_review tool with outcome approved or changes_requested, a summary, and a nonempty evidence string describing the checks. A prose verdict cannot complete this review." : undefined,
    ...previous.map(dep => `Previous stage (${dep.taskId}): ${dep.summary}\nArtifacts: ${JSON.stringify(dep.artifacts)}`),
  ].filter(Boolean).join("\n\n");
  const target = previous.flatMap(dep => dep.artifacts).reverse().find(artifact => artifact.type === "layerfs" && typeof artifact.projectId === "string" && typeof artifact.commitId === "string");
  const reviewTarget = run.role === "reviewer" && target ? { projectId: target.projectId!, commitId: target.commitId!, ...(target.branch ? { branch: target.branch } : {}) } : null;
  return { id: run.id, taskId: run.taskId, roomId: room.id, goalId: binding.goalId, goalAttempt: binding.goalAttempt, epoch: run.epoch, leaseExpiresAt: run.leaseExpiresAt.toISOString(), role: run.role, agentId: run.agentId, prompt, project: room.project, dependencies: previous, reviewTarget };
}

export async function roleAvailable(tx: DatabaseExecutor, room: Room, agentId: string) {
  const [identity] = await tx.select({ id: agents.id }).from(agents)
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(serverAgentMembers, and(eq(serverAgentMembers.agentId, agents.id), eq(serverAgentMembers.serverId, room.serverId)))
    .where(and(eq(agents.id, agentId), eq(agents.serverId, room.serverId), eq(agents.runtime, "external"), isNull(agents.deletedAt), eq(channelAgents.channelId, room.channelId)));
  return Boolean(identity);
}

/** Caller owns the room row lock. Both claims and the server-owned sweeper use
 * this same transition, so recovery does not depend on a worker polling. */
export async function reconcileCampRoom(tx: DatabaseExecutor, room: Room) {
  const [channel] = await tx.select({ id: channels.id }).from(channels).where(and(eq(channels.id, room.channelId), isNull(channels.deletedAt), isNull(channels.archivedAt)));
  let goals = await tx.select().from(campGoals).where(eq(campGoals.roomId, room.id));
  for (const goal of goals) {
    if (!["queued", "running"].includes(goal.status)) continue;
    if (!channel) { await stopGoal(tx, room, goal, "channel_unavailable"); continue; }
    const [expired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
    if (expired) { await stopGoal(tx, room, goal, "duration_budget_exhausted"); continue; }
    const bindings = await tx.select().from(campTasks).where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt)));
    const hasActive = bindings.some(task => task.status === "running");
    if (!hasActive && bindings.some(task => task.status === "queued") && goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); continue; }
    const requiredRoles = new Set(bindings.filter(task => task.status === "running" || task.status === "queued").map(task => task.role));
    for (const role of requiredRoles) {
      const identity = room.roles.find(config => config.role === role);
      if (!identity || !await roleAvailable(tx, room, identity.agentId)) { await stopGoal(tx, room, goal, "role_unavailable"); break; }
    }
  }
  const expired = await tx.select().from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.status, "running"), lte(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
  for (const run of expired) {
    const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
    if (!binding) continue;
    const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
    const cancelled = run.cancelRequestedAt !== null;
    const stopped = !goal || !["queued", "running"].includes(goal.status) || goal.attempt !== binding.goalAttempt;
    const terminal = run.epoch >= 3;
    await tx.update(campRuns).set({ status: cancelled ? "cancelled" : "failed", error: cancelled ? "cancelled_after_lease_expiry" : "lease_expired", completedAt: sql`clock_timestamp()` }).where(eq(campRuns.id, run.id));
    await tx.update(campTasks).set({ status: cancelled ? "cancelled" : stopped ? "blocked" : terminal ? "failed" : "queued" }).where(eq(campTasks.taskId, run.taskId));
    if (terminal || cancelled || stopped) assertMutation(await forceUpdateTaskStatus(run.taskId, "closed", "agent", run.agentId));
    await tx.insert(campEvents).values({ roomId: room.id, goalId: binding.goalId, runId: run.id, type: cancelled ? "cancelled" : "lease_expired", content: cancelled ? "Worker lease expired after cancellation; cleanup is unconfirmed and this task will not retry automatically" : terminal ? "Run lease expired; retry limit reached; cleanup is unconfirmed" : "Run lease expired; API ownership is fenced, old sandbox cleanup is unconfirmed" });
    if (goal && terminal && !stopped && !cancelled) await stopGoal(tx, room, goal, "run_attempts_exhausted");
  }
  goals = await tx.select().from(campGoals).where(eq(campGoals.roomId, room.id));
  const allBindings = await tx.select().from(campTasks).where(eq(campTasks.roomId, room.id));
  const byTask = new Map(allBindings.map(binding => [binding.taskId, binding]));
  for (const goal of goals) {
    if (["queued", "running"].includes(goal.status) && allBindings.some(binding => binding.goalId === goal.id && binding.goalAttempt === goal.attempt && binding.status === "queued" && binding.dependsOn.some(id => !byTask.has(id) || ["failed", "cancelled", "blocked"].includes(byTask.get(id)!.status)))) {
      await stopGoal(tx, room, goal, "dependency_blocked");
    }
    await refreshGoal(tx, room, goal.id);
  }
}

export type CampClaimIntent = { claimId: string; runToken: string };

/** Every Camp lifecycle operation locks its room first, then uses Raft task writers. */
export async function claimRunDetailed(principal: CampPrincipal, workerId: string, intent?: CampClaimIntent): Promise<{ run: CampClaimedRun | null; closed?: boolean }> {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    const room = await lockRoom(tx, principal.roomId);
    await validateWorker(tx, principal);
    await reconcileCampRoom(tx, room);
    if (intent) {
      const [claimed] = await tx.select().from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.claimId, intent.claimId)));
      if (claimed) {
        if (claimed.workerId !== workerId || claimed.runTokenHash !== hashCampToken(intent.runToken)) throw new CampError(409, "claim_conflict", "This claim identifier is already bound to another worker or run credential");
        const [live] = await tx.select({ id: campRuns.id }).from(campRuns).where(and(eq(campRuns.id, claimed.id), eq(campRuns.status, "running"), isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`)));
        return live ? { run: { ...await executionContext(tx, room, claimed), runToken: intent.runToken } } : { run: null, closed: true };
      }
    }
    const bindings = await tx.select().from(campTasks).where(eq(campTasks.roomId, room.id)).orderBy(asc(campTasks.createdAt), asc(campTasks.taskId));
    const running = await tx.select({ agentId: campRuns.agentId }).from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.status, "running")));
    for (const binding of bindings) {
      if (binding.status !== "queued" || binding.dependsOn.some(id => bindings.find(other => other.taskId === id)?.status !== "completed")) continue;
      const [goal] = await tx.select().from(campGoals).where(and(eq(campGoals.id, binding.goalId), eq(campGoals.attempt, binding.goalAttempt)));
      if (!goal || !["queued", "running"].includes(goal.status)) continue;
      if (goal.runCount >= goal.budget.maxRuns) { await stopGoal(tx, room, goal, "run_budget_exhausted"); continue; }
      const role = room.roles.find(row => row.role === binding.role);
      if (!role || running.some(run => run.agentId === role.agentId)) continue;
      if (!await roleAvailable(tx, room, role.agentId)) continue;
      const [canonical] = await tx.select().from(tasks).where(eq(tasks.id, binding.taskId));
      if (!canonical || canonical.status === "done" || canonical.status === "closed") {
        await tx.update(campTasks).set({ status: "cancelled" }).where(eq(campTasks.taskId, binding.taskId));
        continue;
      }
      assertMutation(await assignTask(binding.taskId, { type: "agent", id: role.agentId }, "agent", role.agentId));
      await taskState(binding.taskId, "in_progress", role.agentId);
      const runToken = intent?.runToken ?? newCampToken("run");
      const epoch = binding.attempt + 1;
      await tx.update(campTasks).set({ status: "running", attempt: epoch }).where(eq(campTasks.taskId, binding.taskId));
      const [run] = await tx.insert(campRuns).values({ roomId: room.id, taskId: binding.taskId, role: binding.role, agentId: role.agentId, epoch, workerId, claimId: intent?.claimId, runTokenHash: hashCampToken(runToken), leaseExpiresAt: nextLease() }).returning();
      await tx.update(campGoals).set({ status: "running", runCount: goal.runCount + 1, startedAt: sql`coalesce(${campGoals.startedAt}, clock_timestamp())`, deadlineAt: sql`coalesce(${campGoals.deadlineAt}, clock_timestamp() + ${goal.budget.maxDurationSeconds} * interval '1 second')` }).where(eq(campGoals.id, goal.id));
      await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: run.id, type: "claimed", content: `${role.role} started task ${binding.taskId}` });
      return { run: { ...await executionContext(tx, room, run), runToken } };
    }
    return { run: null };
  });
}

export async function claimRun(principal: CampPrincipal, workerId: string): Promise<CampClaimedRun | null> {
  return (await claimRunDetailed(principal, workerId)).run;
}

async function stateOfRun(tx: DatabaseExecutor, principal: CampPrincipal, runId: string) {
  const [row] = await tx.select({ run: campRuns, goalId: campTasks.goalId, goalAttempt: campTasks.goalAttempt, latestEpoch: campTasks.attempt }).from(campRuns)
    .innerJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, principal.roomId)));
  if (!row) throw new CampError(404, "run_not_found", "Run not found");
  const clock = await tx.execute(sql`select clock_timestamp()::text as now`);
  const now = String(clock.rows[0]?.now);
  const run = row.run;
  const [ack] = await tx.select({ id: campEvents.id }).from(campEvents).where(and(eq(campEvents.runId, run.id), eq(campEvents.type, "cleanup_confirmed"))).limit(1);
  const cleanupState = ack || (run.status !== "running" && run.summary !== null) ? "confirmed" : run.status === "running" ? "pending" : "unknown";
  return { run: { id: run.id, roomId: run.roomId, taskId: run.taskId, goalId: row.goalId, goalAttempt: row.goalAttempt, workerId: run.workerId, epoch: run.epoch, status: run.status, leaseExpiresAt: run.leaseExpiresAt.toISOString(), cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null, cancelRequested: run.cancelRequestedAt !== null, cleanupState },
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

async function fencedRun(tx: DatabaseExecutor, principal: CampPrincipal, runId: string, workerId?: string, epoch?: number, allowCancellation = false) {
  const room = await lockRoom(tx, principal.roomId);
  if (principal.kind === "worker") await validateWorker(tx, principal);
  if (principal.kind === "run" && principal.runId !== runId) throw fail();
  const [run] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, room.id), eq(campRuns.status, "running"), allowCancellation ? undefined : isNull(campRuns.cancelRequestedAt), gt(campRuns.leaseExpiresAt, sql`clock_timestamp()`))).for("update");
  if (!run || (workerId !== undefined && run.workerId !== workerId) || (epoch !== undefined && run.epoch !== epoch) || (principal.kind === "run" && principal.epoch !== run.epoch)) throw fail();
  if (principal.kind === "run" && !await roleAvailable(tx, room, run.agentId)) throw new CampError(403, "role_unavailable", "This role is no longer a current channel and server member");
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
    const context = await executionContext(tx, room, run);
    const reports = await runReports(tx, runId);
    // Agent plugins receive the project identity and parent artifacts, never host
    // Store/discovery paths or either credential hash.
    return { run: { ...context, project: { name: room.project.name, baseRef: room.project.baseRef }, review: reports.review }, reviewTarget: context.reviewTarget, ...reports, ...await roomMessages(room.id) };
  });
}

export async function recordRunEvent(principal: CampPrincipal, runId: string, input: { workerId?: string; epoch: number; type: string; content: string; artifact?: CampArtifact; toRole?: CampRole }) {
  return getDb().transaction(async tx => {
    const { room, run } = await fencedRun(tx, principal, runId, input.workerId, input.epoch);
    if (!await roleAvailable(tx, room, run.agentId)) throw new CampError(403, "role_unavailable", "This role is no longer a current channel and server member");
    // Candidate identities authorize the next workspace's base commit. Only
    // the trusted host worker can attest them; model reports are annotations.
    if (principal.kind === "run" && input.artifact && !["file", "review"].includes(input.artifact.type)) {
      throw new CampError(403, "worker_artifact_required", "Run credentials may report only file and review artifacts; runtime candidates require the trusted worker");
    }
    if (input.artifact?.type === "review") {
      if (run.role !== "reviewer") throw new CampError(403, "reviewer_role_required", "Only the current reviewer run may submit a review verdict");
      reviewArtifact(input.artifact, input.content);
      const target = (await executionContext(tx, room, run)).reviewTarget;
      const candidate = input.artifact.candidate as CampReviewTarget | undefined;
      if (!target || !candidate || candidate.projectId !== target.projectId || candidate.commitId !== target.commitId) throw new CampError(409, "review_candidate_mismatch", "The review must name the trusted builder candidate supplied by this run's context");
    }
    const message = await createMessage(room.channelId, "agent", run.agentId, input.content, "chat", undefined, { actionMetadata: { camp: { runId, epoch: run.epoch, kind: input.type, toRole: input.toRole ?? null, artifact: input.artifact ?? null } } });
    const [event] = await tx.insert(campEvents).values({ roomId: room.id, runId, type: input.type, content: input.content, artifact: input.artifact, toRole: input.toRole, messageId: message.id }).returning();
    return { message, event, room };
  });
}

export async function completeRun(principal: CampPrincipal, runId: string, workerId: string, epoch: number, input: CampCompletion) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    const roomForReplay = await lockRoom(tx, principal.roomId);
    await validateWorker(tx, principal);
    const [existing] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, principal.roomId))).for("update");
    if (!existing || existing.workerId !== workerId || existing.epoch !== epoch) throw fail();
    const reports = await runReports(tx, runId);
    const artifacts = [...input.artifacts ?? [], ...reports.artifacts].filter((value, index, all) => all.findIndex(other => isDeepStrictEqual(other, value)) === index);
    const outcome = existing.role === "reviewer" && input.status === "completed" ? reports.review?.outcome ?? input.outcome : input.outcome;
    if (existing.role === "reviewer" && input.status === "completed" && reports.review && input.outcome && input.outcome !== reports.review.outcome) {
      throw new CampError(409, "review_mismatch", "Completion must match the review verdict recorded by this run");
    }
    if (existing.status !== "running") {
      // An acknowledged settlement may be retried after a lost HTTP response.
      // Its exact worker/epoch and semantic result must match; no side effect repeats.
      if (existing.summary !== null && existing.status === input.status && existing.summary === input.summary && existing.sessionId === (input.sessionId ?? null) && existing.error === (input.error ?? null) && existing.outcome === (outcome ?? null) && isDeepStrictEqual(existing.artifacts, artifacts)) {
        return { run: completionFields(existing), room: roomForReplay, replayed: true as const };
      }
      throw fail("This run already settled with a different result");
    }
    const { room, run } = await fencedRun(tx, principal, runId, workerId, epoch, input.status === "cancelled");
    const [binding] = await tx.select().from(campTasks).where(eq(campTasks.taskId, run.taskId));
    const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, binding.goalId));
    if (!goal || goal.attempt !== binding.goalAttempt) throw fail("This goal attempt has been replaced");
    const successful = input.status === "completed";
    if (successful && !["queued", "running"].includes(goal.status)) throw fail("The goal stopped before completion");
    const [durationExpired] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.id, goal.id), lte(campGoals.deadlineAt, sql`clock_timestamp()`)));
    if (successful && durationExpired) throw new CampError(409, "duration_budget_exhausted", "The goal duration budget expired before completion");
    if (successful && run.role === "reviewer") {
      if (!reports.review) throw new CampError(409, "review_required", "The reviewer must submit a structured review with evidence before completion");
      if (input.outcome && input.outcome !== reports.review.outcome) throw new CampError(409, "review_mismatch", "Completion must match the review verdict recorded by this run");
    } else if (run.role !== "reviewer" && input.outcome && input.outcome !== "handoff") {
      throw new CampError(400, "reviewer_role_required", "Only a reviewer may approve or request changes");
    }
    const reviewTarget = (await executionContext(tx, room, run)).reviewTarget;
    for (const artifact of input.artifacts ?? []) {
      if (artifact.type !== "review") continue;
      if (run.role !== "reviewer") throw new CampError(403, "reviewer_role_required", "Only a reviewer may return a review artifact");
      const review = reviewArtifact(artifact, input.summary);
      if (!reviewTarget || review.candidate?.projectId !== reviewTarget.projectId || review.candidate?.commitId !== reviewTarget.commitId) throw new CampError(409, "review_candidate_mismatch", "Completion cannot replace the trusted review candidate");
      if (reports.review && review.outcome !== reports.review.outcome) throw new CampError(409, "review_mismatch", "Completion artifacts must match the recorded review verdict");
    }
    const infrastructureRetry = input.status === "failed" && ["worker_interrupted", "worker_shutdown"].includes(input.error ?? "")
      && run.epoch < 3 && goal.runCount < goal.budget.maxRuns && !durationExpired && ["queued", "running"].includes(goal.status);
    if (!infrastructureRetry) await taskState(run.taskId, successful ? "done" : "closed", run.agentId);
    const [completed] = await tx.update(campRuns).set({ status: input.status, summary: input.summary, artifacts, sessionId: input.sessionId, error: input.error, outcome, completedAt: sql`now()` }).where(eq(campRuns.id, runId)).returning({ id: campRuns.id, roomId: campRuns.roomId, taskId: campRuns.taskId, status: campRuns.status, epoch: campRuns.epoch, summary: campRuns.summary, artifacts: campRuns.artifacts, outcome: campRuns.outcome });
    await tx.update(campTasks).set({ status: infrastructureRetry ? "queued" : input.status }).where(eq(campTasks.taskId, run.taskId));
    if (successful && run.role === "reviewer") await tx.update(campGoals).set({ reviewRounds: goal.reviewRounds + 1 }).where(eq(campGoals.id, goal.id));
    if (successful && run.role === "reviewer" && outcome === "changes_requested") {
      if (goal.reviewRounds + 1 >= goal.budget.maxReviewRounds) {
        await stopGoal(tx, room, goal, "review_budget_exhausted");
      } else if (goal.runCount + 2 > goal.budget.maxRuns) {
        await stopGoal(tx, room, goal, "run_budget_exhausted");
      } else {
        const result = await createTasks(room.channelId, "agent", run.agentId, [
          { title: "builder: address review feedback", description: input.summary },
          { title: "reviewer: verify revised candidate", description: input.summary },
        ]);
        await tx.insert(campTasks).values([
          { taskId: result.tasks[0].id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role: "builder", dependsOn: [run.taskId] },
          { taskId: result.tasks[1].id, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, role: "reviewer", dependsOn: [result.tasks[0].id] },
        ]);
      }
    }
    if (!successful && !infrastructureRetry && ["queued", "running"].includes(goal.status)) await stopGoal(tx, room, goal, input.status === "cancelled" ? "run_cancelled" : run.epoch >= 3 ? "run_attempts_exhausted" : goal.runCount >= goal.budget.maxRuns ? "run_budget_exhausted" : "run_failed");
    await refreshGoal(tx, room, goal.id);
    const message = await createMessage(room.channelId, "agent", run.agentId, input.summary, "chat", undefined, { actionMetadata: { camp: { runId, epoch, kind: "completion", outcome: outcome ?? null, artifacts } } });
    const [event] = await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: outcome ?? input.status, content: input.summary, messageId: message.id }).returning();
    return { run: completed, message, event, room, replayed: false as const };
  });
}

export async function cancelRun(roomId: string, runId: string, userId: string) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [run] = await tx.select().from(campRuns).where(and(eq(campRuns.id, runId), eq(campRuns.roomId, roomId))).for("update");
    if (!run) throw new CampError(404, "run_not_found", "Run not found");
    if (run.status !== "running") throw fail("The run has already ended");
    const [requested] = await tx.update(campRuns).set({ cancelRequestedAt: sql`now()` }).where(eq(campRuns.id, runId)).returning({ id: campRuns.id, status: campRuns.status, cancelRequestedAt: campRuns.cancelRequestedAt });
    await tx.insert(campEvents).values({ roomId, runId, type: "cancel_requested", content: `A human requested cancellation (${userId}); waiting for worker cleanup` });
    return { room, run: requested };
  });
}
