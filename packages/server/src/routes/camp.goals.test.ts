import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campEvents, campGoals, campRooms, campRuns, campWorkerTokens, channelAgents, channelConversionFences, channelConversionJobs, channels, serverMembers, tasks } from "../db/schema";
import { reconcileCampPass } from "../services/camp/reconcile";
import { authenticateCampToken, claimRun, recordRunEvent } from "../services/camp/runs";
import { requireCampAdmin, revokeWorkerToken } from "../services/camp/rooms";
import { retryGoal } from "../services/camp/goals";
import type { CampBudget, CampAgentClaimedRun as CampClaimedRun, CampGoalAttemptSummary } from "../services/camp/types";

type Snapshot = { goals: Array<{ id: string; attempt: number; status: string; reason: string | null; usage: { runs: number; reviewRounds: number }; budget: CampBudget; canRetry: boolean; canCancel: boolean; attemptHistory: CampGoalAttemptSummary[] }>; tasks: Array<{ id: string; role: string; goalId: string; goalAttempt: number; status: string; dependsOn: string[] }>; runs: Array<{ id: string; status: string; cleanupState: string }> };
async function fixture({ seed, http, app }: { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } }) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Bounded goals", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text());
  const room = await created.json() as { id: string; roles: Array<{ role: string; agentId: string }> };
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  const { token, tokenId } = await minted.json() as { token: string; tokenId: string };
  const worker = async (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshot = async () => { const response = await user.get(`/api/camp/rooms/${room.id}`); assert.equal(response.status, 200); return await response.json() as Snapshot; };
  const submit = async (input: { title: string; role?: string; dependsOn?: string[]; budget?: Partial<CampBudget> }) => {
    const response = await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, workflow: "legacy" }) });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as Snapshot;
  };
  const claim = async () => { const response = await worker("/claim", { workerId: "worker-a" }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { run: CampClaimedRun | null }).run; };
  const complete = async (run: CampClaimedRun, outcome?: "approved" | "changes_requested") => {
    if (run.role === "reviewer") {
      const context = await (await worker(`/runs/${run.id}/context`, undefined, run.runToken)).json() as { reviewTarget: { projectId: string; commitId: string } };
      const review = await worker(`/runs/${run.id}/events`, { epoch: run.epoch, type: "artifact", content: "Tested candidate", artifact: { type: "review", outcome, evidence: "Candidate tests passed", candidate: context.reviewTarget } }, run.runToken);
      assert.equal(review.status, 201, await review.clone().text());
    }
    const response = await worker(`/runs/${run.id}/complete`, { workerId: "worker-a", epoch: run.epoch, status: "completed", summary: `${run.role} completed`, artifacts: [{ type: "layerfs", projectId: "fixture-project", role: run.role, commitId: `commit-${run.id}` }], outcome });
    assert.equal(response.status, 200, await response.clone().text());
  };
  return { owner, server, channel, user, room, token, tokenId, worker, snapshot, submit, claim, complete };
}

apiTest("Camp exact terminal completion replays after channel archival without reopening execution or writing another event", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit({ title: "Completed before archival", role: "planner" });
  const run = (await kit.claim())!;
  const payload = { workerId: "worker-a", epoch: run.epoch, status: "completed", summary: "The acknowledged result" };
  const first = await kit.worker(`/runs/${run.id}/complete`, payload); assert.equal(first.status, 200, await first.clone().text());
  const eventsBefore = (await db.select().from(campEvents).where(eq(campEvents.runId, run.id))).length;
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, kit.channel.id));
  const replay = await kit.worker(`/runs/${run.id}/complete`, payload); assert.equal(replay.status, 200, await replay.clone().text()); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  const different = await kit.worker(`/runs/${run.id}/complete`, { ...payload, summary: "Different" }); assert.equal(different.status, 409);
  assert.equal((await db.select().from(campEvents).where(eq(campEvents.runId, run.id))).length, eventsBefore);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200);
  await db.update(campWorkerTokens).set({ revokedAt: new Date() }).where(eq(campWorkerTokens.id, kit.tokenId));
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 401, "Exact replay still needs a valid host credential");
});

apiTest("Camp freezes the original completion independently of later report projection and preserves historical hashless replays", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit({ title: "Durable original completion", role: "planner" });
  const run = (await kit.claim())!;
  const annotation = { type: "file", details: { z: [1, 2], a: "original" } };
  const payload = { workerId: "worker-a", epoch: run.epoch, status: "completed", summary: "Saved original request", artifacts: [annotation] };
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200);
  const [saved] = await db.select().from(campRuns).where(eq(campRuns.id, run.id)); assert.match(saved.completionPayloadHash!, /^[a-f0-9]{64}$/);
  // Simulate retained/backfilled events and a changed projection window. These
  // are not new facts in the already-committed original request.
  await db.insert(campEvents).values(Array.from({ length: 32 }, (_, index) => ({ roomId: kit.room.id, runId: run.id, type: "historical_annotation", content: `Historical ${index}`, artifact: { type: "file", path: `historical-${index}` } })));
  const eventCount = (await db.select().from(campEvents).where(eq(campEvents.runId, run.id))).length;
  const reordered = { artifacts: [{ details: { a: "original", z: [1, 2] }, type: "file" }], summary: payload.summary, status: "completed", epoch: run.epoch, workerId: "worker-a" };
  const replay = await kit.worker(`/runs/${run.id}/complete`, reordered); assert.equal(replay.status, 200, await replay.clone().text()); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...payload, artifacts: [{ ...annotation, details: { ...annotation.details, z: [2, 1] } }] })).status, 409);
  assert.equal((await db.select().from(campEvents).where(eq(campEvents.runId, run.id))).length, eventCount);
  await db.update(campRuns).set({ completionPayloadHash: null }).where(eq(campRuns.id, run.id));
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200, "Historical rows use their final stored facts, not the latest event window");
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...payload, artifacts: [...payload.artifacts, { type: "file", path: "new" }] })).status, 409);
  const [legacy] = await db.select().from(campRuns).where(eq(campRuns.id, run.id)); assert.equal(legacy.completionPayloadHash, null, "Do not invent a historical raw request hash");
});

apiTest("Camp reconciliation isolates a real conversion-fenced Room and rotates its cursor while other leases expire", async ({ db, seed, http, app }) => {
  const poisoned = await fixture({ seed, http, app }), healthy = await fixture({ seed, http, app });
  await poisoned.submit({ title: "Conversion is temporarily fenced", role: "planner" });
  await healthy.submit({ title: "Lease still needs reconciliation", role: "planner" }); const run = (await healthy.claim())!;
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await db.update(campRooms).set({ reconciledAt: new Date(0) }).where(eq(campRooms.id, healthy.room.id));
  const [job] = await db.insert(channelConversionJobs).values({ serverId: poisoned.server.id, sourceChannelId: poisoned.channel.id, sourceChannelType: "channel" }).returning();
  await db.insert(channelConversionFences).values({ jobId: job.id, serverId: poisoned.server.id, sourceChannelId: poisoned.channel.id, conversionEpoch: job.conversionEpoch });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const changed: string[] = [];
    assert.equal(await reconcileCampPass(async room => { changed.push(room.id); }), 1);
    assert.deepEqual(changed, [healthy.room.id]);
    assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0].status, "failed");
    const [failedRoom] = await db.select().from(campRooms).where(eq(campRooms.id, poisoned.room.id)); assert.ok(failedRoom.reconciledAt, "Failed rooms must not monopolize the oldest scan slot");
    assert.ok(errors.mock.calls.length > 0);
  } finally { errors.mockRestore(); }
});

apiTest("Camp reconciliation notification errors do not stop the remaining committed Room transitions", async ({ seed, http, app }) => {
  const first = await fixture({ seed, http, app }), second = await fixture({ seed, http, app });
  await first.submit({ title: "First", role: "planner" }); await second.submit({ title: "Second", role: "planner" });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {}); let notifications = 0;
  try { assert.equal(await reconcileCampPass(async () => { notifications++; throw new Error("Socket delivery unavailable"); }), 2); assert.equal(notifications, 2); }
  finally { errors.mockRestore(); }
});

apiTest("Camp review budget stops rework, manual retry keeps attempt evidence and CAS prevents a duplicate generation", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const initial = await kit.submit({ title: "Bounded review", budget: { maxReviewRounds: 1 } });
  const goalId = initial.goals[0].id;
  for (let index = 0; index < 3; index++) await kit.complete((await kit.claim())!, index === 2 ? "changes_requested" : undefined);
  const stopped = await kit.snapshot();
  assert.equal(stopped.goals[0].status, "needs_attention");
  assert.equal(stopped.goals[0].reason, "review_budget_exhausted");
  assert.equal(stopped.goals[0].usage.runs, 3);
  assert.equal(stopped.goals[0].usage.reviewRounds, 1);
  assert.equal(stopped.tasks.length, 3, "an exhausted review cannot append another builder/reviewer pair");
  assert.equal(await kit.claim(), null);
  const retry = () => kit.user.request(`/api/camp/rooms/${kit.room.id}/goals/${goalId}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedAttempt: 1, budget: { maxReviewRounds: 2 } }) });
  const response = await retry(); assert.equal(response.status, 200, await response.clone().text());
  const next = await response.json() as Snapshot;
  assert.equal(next.goals[0].attempt, 2);
  assert.equal(next.goals[0].usage.runs, 0);
  assert.equal(next.goals[0].attemptHistory[0].reason, "review_budget_exhausted");
  assert.equal(next.goals[0].attemptHistory[0].budget.maxReviewRounds, 1);
  assert.equal(next.goals[0].attemptHistory[0].usage.runs, 3);
  assert.equal(next.tasks.length, 6);
  assert.equal((await retry()).status, 409);
  const active = (await kit.claim())!;
  assert.equal(active.goalAttempt, 2);
  const cancel = await kit.user.request(`/api/camp/rooms/${kit.room.id}/goals/${goalId}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as Snapshot).goals[0].status, "cancelling");
  assert.equal((await kit.worker(`/runs/${active.id}/events`, { epoch: active.epoch, type: "progress", content: "late" }, active.runToken)).status, 401);
  const settled = await kit.worker(`/runs/${active.id}/complete`, { workerId: "worker-a", epoch: active.epoch, status: "cancelled", summary: "Sandbox removed" });
  assert.equal(settled.status, 200, await settled.clone().text());
  assert.equal((await kit.snapshot()).goals[0].status, "cancelled");
});

apiTest("Camp server reconciliation enforces run and duration budgets without another claim and preserves unknown cleanup", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit({ title: "One run budget", budget: { maxRuns: 1 } });
  await kit.complete((await kit.claim())!);
  await reconcileCampPass();
  let state = await kit.snapshot();
  assert.equal(state.goals[0].reason, "run_budget_exhausted");
  assert.equal(state.tasks.filter(task => task.status === "blocked").length, 2);
  for (const task of state.tasks.filter(task => task.status === "blocked")) assert.equal((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status, "closed");
  const timeout = await kit.submit({ title: "Time budget", role: "planner", budget: { maxDurationSeconds: 1 } });
  const timedGoal = timeout.goals.find(goal => goal.id !== state.goals[0].id)!;
  const active = (await kit.claim())!;
  await db.update(campGoals).set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campGoals.id, timedGoal.id));
  await reconcileCampPass();
  state = await kit.snapshot();
  assert.equal(state.goals.find(goal => goal.id === timedGoal.id)?.reason, "duration_budget_exhausted");
  assert.equal((await kit.worker(`/runs/${active.id}/events`, { epoch: active.epoch, type: "progress", content: "late time budget" }, active.runToken)).status, 401);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, active.id));
  await reconcileCampPass();
  state = await kit.snapshot();
  assert.equal(state.runs.find(run => run.id === active.id)?.cleanupState, "unknown");
  const before = (await db.select().from(campRuns).where(eq(campRuns.id, active.id)))[0];
  const ack = await kit.worker(`/runs/${active.id}/cleanup`, { workerId: "worker-a", epoch: active.epoch });
  assert.equal(ack.status, 200, await ack.clone().text());
  assert.equal((await ack.json() as { cleanupState: string }).cleanupState, "confirmed");
  assert.equal((await kit.worker(`/runs/${active.id}/cleanup`, { workerId: "worker-a", epoch: active.epoch })).status, 200);
  const after = (await db.select().from(campRuns).where(eq(campRuns.id, active.id)))[0];
  assert.deepEqual(after, before, "cleanup attestation cannot change a run outcome or revive its lease");
  assert.equal((await db.select().from(campEvents).where(and(eq(campEvents.runId, active.id), eq(campEvents.type, "cleanup_confirmed")))).length, 1);
});

apiTest("Camp claim replay preserves a run secret and quick worker recovery retries only bounded infrastructure failures", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit({ title: "Recover an interrupted worker", role: "planner" });
  const claimId = randomUUID();
  const runToken = `camp_run_${createHmac("sha256", kit.token).update(claimId).digest("hex")}`;
  const intent = { workerId: "worker-a", claimId, runToken };
  const raced = await Promise.all([kit.worker("/claim", intent), kit.worker("/claim", intent)]);
  const runs = await Promise.all(raced.map(async response => { assert.equal(response.status, 200); return (await response.json() as { run: CampClaimedRun }).run; }));
  assert.equal(runs[0].id, runs[1].id);
  assert.equal(runs[0].runToken, runToken);
  assert.equal((await db.select().from(campRuns)).length, 1);
  assert.equal((await kit.worker("/claim", { ...intent, workerId: "other" })).status, 409);
  assert.equal((await kit.worker(`/runs/${runs[0].id}/state`, undefined, runToken)).status, 403);
  const infrastructure = await kit.worker(`/runs/${runs[0].id}/complete`, { workerId: "worker-a", epoch: runs[0].epoch, status: "failed", summary: "Previous worker stopped and its sandbox was removed", error: "worker_interrupted" });
  assert.equal(infrastructure.status, 200, await infrastructure.clone().text());
  assert.equal((await kit.snapshot()).goals[0].status, "running");
  const replay = await kit.worker("/claim", intent);
  assert.deepEqual(await replay.json(), { run: null, closed: true });
  const recovered = (await kit.claim())!;
  assert.equal(recovered.taskId, runs[0].taskId);
  assert.equal(recovered.epoch, 2);
  const completion = { workerId: "worker-a", epoch: recovered.epoch, status: "completed", summary: "Recovered safely" };
  assert.equal((await kit.worker(`/runs/${recovered.id}/complete`, completion)).status, 200);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, recovered.id));
  const replayed = await kit.worker(`/runs/${recovered.id}/complete`, completion);
  assert.equal(replayed.status, 200, await replayed.clone().text());
  assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);
  const previous = await (await kit.worker(`/runs/${runs[0].id}/state`)).json() as { replaced: boolean; leaseValid: boolean };
  assert.equal(previous.replaced, true);
  assert.equal(previous.leaseValid, false);
  assert.equal((await kit.worker(`/runs/${recovered.id}/state`)).status, 200);
  assert.equal((await kit.worker(`/runs/${randomUUID()}/state`)).status, 404);
  const principal = await authenticateCampToken(kit.token);
  await revokeWorkerToken(kit.room.id, kit.tokenId, kit.owner.id);
  await assert.rejects(claimRun(principal, "worker-a"), { code: "camp_auth_required" });
});

apiTest("Camp retries retain failed external task dependencies and server membership is rechecked at the write fence", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit({ title: "Required upstream", role: "planner" });
  const upstream = (await kit.claim())!;
  assert.equal((await kit.worker(`/runs/${upstream.id}/complete`, { workerId: "worker-a", epoch: upstream.epoch, status: "failed", summary: "Business checks failed", error: "candidate_test_failed" })).status, 200);
  const submitted = await kit.submit({ title: "Dependent goal", role: "builder", dependsOn: [upstream.taskId] });
  const dependent = submitted.goals.find(goal => goal.id !== upstream.goalId)!;
  await reconcileCampPass();
  const retried = await kit.user.request(`/api/camp/rooms/${kit.room.id}/goals/${dependent.id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedAttempt: 1 }) });
  assert.equal(retried.status, 200, await retried.clone().text());
  const next = await retried.json() as Snapshot;
  assert.deepEqual(next.tasks.find(task => task.goalId === dependent.id && task.goalAttempt === 2)?.dependsOn, [upstream.taskId]);
  assert.equal(await kit.claim(), null, "retry cannot silently drop a failed prerequisite");
  const admin = await seed.human();
  await db.insert(serverMembers).values({ serverId: kit.server.id, userId: admin.id, role: "admin" });
  await requireCampAdmin(kit.server.id, admin.id); // Cached request admission succeeds.
  await db.update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, kit.server.id), eq(serverMembers.userId, admin.id)));
  await assert.rejects(retryGoal(kit.room.id, dependent.id, admin.id, 2), { code: "camp_admin_required" });
  const current = (await db.select().from(campGoals).where(eq(campGoals.id, dependent.id)))[0];
  assert.equal(current.attempt, 2);
});

apiTest("Camp reconciles an active role's channel revocation into a cleanup request without claiming more work", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit({ title: "Revoke role membership", role: "planner" });
  const active = (await kit.claim())!;
  const admitted = await authenticateCampToken(active.runToken);
  await db.delete(channelAgents).where(and(eq(channelAgents.channelId, kit.channel.id), eq(channelAgents.agentId, active.agentId)));
  assert.equal((await kit.worker(`/rooms/${kit.room.id}/messages`, undefined, active.runToken)).status, 401, "revocation fences plugin reads immediately without waiting for the sweep");
  await assert.rejects(recordRunEvent(admitted, active.id, { epoch: active.epoch, type: "progress", content: "admitted before role removal" }), { code: "role_unavailable" });
  await reconcileCampPass();
  const state = await kit.snapshot();
  assert.equal(state.goals[0].status, "needs_attention");
  assert.equal(state.goals[0].reason, "role_unavailable");
  assert.equal((await kit.worker(`/runs/${active.id}/events`, { epoch: active.epoch, type: "progress", content: "revoked role" }, active.runToken)).status, 401);
  const heartbeat = await kit.worker(`/runs/${active.id}/heartbeat`, { workerId: "worker-a", epoch: active.epoch });
  assert.equal((await heartbeat.json() as { cancelRequested: boolean }).cancelRequested, true);
});

apiTest("Camp reconciliation closes legacy queued descendants of an already stopped goal", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const initial = await kit.submit({ title: "Legacy stopped goal" });
  await db.update(campGoals).set({ status: "needs_attention", reason: "run_failed" }).where(eq(campGoals.id, initial.goals[0].id));
  await reconcileCampPass();
  const state = await kit.snapshot();
  assert.ok(state.tasks.every(task => task.status === "blocked"));
  assert.ok((await db.select().from(tasks)).every(task => task.status === "closed"));
  assert.equal(state.goals[0].reason, "run_failed");
});

apiTest("Camp reviews cannot approve a forged, cross-room, or substituted completion candidate", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit({ title: "Review this exact candidate" });
  await kit.complete((await kit.claim())!);
  await kit.complete((await kit.claim())!);
  const reviewer = (await kit.claim())!;
  const context = await (await kit.worker(`/runs/${reviewer.id}/context`, undefined, reviewer.runToken)).json() as { reviewTarget: { projectId: string; commitId: string } };
  const other = await fixture({ seed, http, app });
  await other.submit({ title: "Another room's candidate", role: "builder" });
  const otherRun = (await other.claim())!;
  await other.complete(otherRun);
  const otherCandidate = (await db.select().from(campRuns).where(eq(campRuns.id, otherRun.id)))[0].artifacts.find(artifact => artifact.type === "layerfs")!;
  const report = (candidate: { projectId: unknown; commitId: unknown }, credential: string) => kit.worker(`/runs/${reviewer.id}/events`, { workerId: "worker-a", epoch: reviewer.epoch, type: "artifact", content: "Structured approval", artifact: { type: "review", outcome: "approved", evidence: "Test results", candidate } }, credential);
  for (const credential of [kit.token, reviewer.runToken]) {
    const forged = await report({ projectId: context.reviewTarget.projectId, commitId: "forged-commit" }, credential);
    assert.equal(forged.status, 409, await forged.clone().text());
    const crossRoom = await report({ projectId: otherCandidate.projectId, commitId: otherCandidate.commitId }, credential);
    assert.equal(crossRoom.status, 409, await crossRoom.clone().text());
  }
  assert.equal((await report(context.reviewTarget, reviewer.runToken)).status, 201);
  assert.equal((await report({ ...context.reviewTarget, commitId: "second-candidate" }, reviewer.runToken)).status, 409);
  const substituted = await kit.worker(`/runs/${reviewer.id}/complete`, { workerId: "worker-a", epoch: reviewer.epoch, status: "completed", summary: "Correct outcome but wrong candidate", outcome: "approved", artifacts: [{ type: "review", outcome: "approved", evidence: "Forged completion evidence", candidate: { ...context.reviewTarget, commitId: "different-commit" } }] });
  assert.equal(substituted.status, 409, await substituted.clone().text());
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, reviewer.id)))[0].status, "running");
  await kit.complete(reviewer, "approved");
  assert.equal((await kit.snapshot()).goals[0].status, "completed");
});
