import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campEvents, campGoals, campQuestions, campRooms, campRuns, campTasks, channelHumans } from "../db/schema";
import { reconcileCampPass } from "../services/camp/reconcile";
import { getDb } from "../db/index";
import type { CampCandidate, CampAgentClaimedRun as CampClaimedRun } from "../services/camp/types";

type FixtureContext = { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } };
type Snapshot = {
  room: { acceptedHead: { revision: number; candidate: CampCandidate | null } };
  goals: Array<{ id: string; attempt: number; status: string; reason: string | null; canRetry: boolean; currentCandidate: CampCandidate | null; metrics: { humanAnswers: number; agentAnswers: number } }>;
  tasks: Array<{ id: string; goalId: string; goalAttempt: number; executionStatus: string }>;
  runs: Array<{ id: string; status: string }>;
  questions: Array<{ id: string; status: string; canAnswer: boolean }>;
};
const workerId = "serial-edge-worker";
const layer: CampCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
const unchanged = { ...layer, baseRef: layer.refId };
const plan = { planRevision: 1, summary: "One independently verifiable change", tasks: [{ key: "repair", title: "Repair the response", description: "Preserve existing behavior", acceptance: "Empty input returns an empty list", verification: "Run the existing acceptance suite" }] };

async function json<T>(response: Response, expected: number): Promise<T> {
  assert.equal(response.status, expected, await response.clone().text());
  return response.json() as Promise<T>;
}

async function fixture({ seed, http, app }: FixtureContext) {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner, member], visibility: "private" });
  const user = http.as(owner, server);
  const memberClient = http.as(member, server);
  const post = (path: string, body: unknown = {}) => user.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const room = await json<{ id: string }>(await post("/api/camp/rooms", { channelId: channel.id, name: "Serial edge cases", project: { name: "edge-project" } }), 201);
  await json(await user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: { id: "edge-checks", revision: 1, name: "Edge checks", maxRepairAttempts: 1, checks: [{ id: "node-tests", label: "Node tests", argv: ["node", "--test"], timeoutMs: 120000 }] } }) }), 200);
  const { token } = await json<{ token: string }>(await post(`/api/camp/rooms/${room.id}/worker-token`), 201);
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshot = async () => json<Snapshot>(await user.get(`/api/camp/rooms/${room.id}`), 200);
  const submit = async () => {
    const state = await json<Snapshot>(await post(`/api/camp/rooms/${room.id}/tasks`, { title: "Review the existing response", description: "Retain passing behavior and ask when a product decision is missing" }), 201);
    // These question/lease cases intentionally exercise an existing v1 goal
    // after upgrade. Protocol v2 verification has its own full-chain suite.
    const created = state.goals.find(goal => goal.status === "queued"); assert.ok(created);
    await getDb().update(campGoals).set({ protocolVersion: 1, verificationPolicy: null }).where(eq(campGoals.id, created.id));
    return state;
  };
  const claim = async () => (await json<{ run: CampClaimedRun | null }>(await worker("/claim", { workerId, protocol: createWorkerDeclaration() }), 200)).run;
  // Match createRunClient exactly: every mutation carries these three fields.
  const tool = (run: CampClaimedRun, path: string, body: Record<string, unknown>, credential = run.runToken) => worker(`/runs/${run.id}${path}`, { workerId, runId: run.id, epoch: run.epoch, ...body }, credential);
  const ask = async (run: CampClaimedRun, needsHuman = true) => {
    const questionId = randomUUID();
    const result = await json<{ question: { id: string }; requiresSuspension: boolean }>(await tool(run, "/questions", { questionId, content: "Which response should an empty input return?", toRole: "planner", needsHuman }), 200);
    assert.equal(result.requiresSuspension, true);
    assert.equal(result.question.id, questionId);
    return questionId;
  };
  const suspendPayload = (run: CampClaimedRun, questionId: string) => ({ workerId, epoch: run.epoch, status: "suspended", summary: "Saved the candidate before requesting a human decision", inputCandidate: layer, candidate: unchanged, questionId });
  const suspend = async (run: CampClaimedRun, questionId: string) => json<{ replayed: boolean }>(await worker(`/runs/${run.id}/complete`, suspendPayload(run, questionId)), 200);
  return { owner, member, server, channel, user, memberClient, post, room, token, worker, snapshot, submit, claim, tool, ask, suspend, suspendPayload };
}

async function startBuilder(kit: Awaited<ReturnType<typeof fixture>>) {
  await kit.submit();
  const planner = (await kit.claim())!;
  await json(await kit.tool(planner, "/plan", plan), 200);
  await json(await kit.worker(`/runs/${planner.id}/complete`, { workerId, epoch: planner.epoch, status: "completed", summary: "The structured plan is ready", inputCandidate: layer, candidate: unchanged }), 200);
  const builder = (await kit.claim())!;
  assert.equal(builder.taskKind, "build");
  assert.equal(builder.role, "builder");
  return builder;
}

const clarificationCompletion = (run: CampClaimedRun) => ({ workerId, epoch: run.epoch, status: "completed", summary: "The assigned question has been answered or escalated", inputCandidate: layer, candidate: unchanged });

apiTest("Camp serial plan mutations accept the real plugin envelope and preserve the first immutable plan", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit();
  const run = (await kit.claim())!;
  assert.equal(run.taskKind, "plan");
  const first = await json<{ replayed: boolean }>(await kit.tool(run, "/plan", plan), 200);
  assert.equal(first.replayed, false);
  const replay = await json<{ replayed: boolean }>(await kit.tool(run, "/plan", plan), 200);
  assert.equal(replay.replayed, true);
  assert.equal((await json<{ code: string }>(await kit.tool(run, "/plan", { ...plan, summary: "Replace the accepted plan" }), 409)).code, "plan_conflict");
  assert.equal((await json<{ code: string }>(await kit.tool(run, "/plan", { ...plan, runId: randomUUID() }), 400)).code, "run_identifier_mismatch");
  await json(await kit.tool(run, "/plan", { ...plan, dependsOn: [randomUUID()] }), 400);
  await json(await kit.tool(run, "/plan", { ...plan, epoch: run.epoch + 1 }), 409);
  await json(await kit.tool(run, "/plan", { ...plan, workerId: "a-different-worker" }), 409);
  for (const item of [{ ...plan.tasks[0], role: "builder" }, { ...plan.tasks[0], dependsOn: [randomUUID()] }]) {
    await json(await kit.tool(run, "/plan", { ...plan, tasks: [item] }), 400);
  }
  const context = await json<{ plan: { summary: string } }>(await kit.worker(`/runs/${run.id}/context`, undefined, run.runToken), 200);
  assert.equal(context.plan.summary, plan.summary);
  assert.equal((await db.select().from(campTasks)).length, 1, "Submitting a plan does not run or enqueue its implementation before completion");
});

apiTest("Camp rebinds a question persisted before a worker crash and requires the recovered run to suspend", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  await kit.submit();
  const original = (await kit.claim())!;
  const questionId = await kit.ask(original);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, original.id));
  const recovered = (await kit.claim())!;
  assert.equal(recovered.taskId, original.taskId);
  assert.equal(recovered.epoch, original.epoch + 1);
  const [pending] = await db.select().from(campQuestions).where(eq(campQuestions.id, questionId));
  assert.equal(pending.originRunId, original.id, "Keep the historical question origin");
  assert.equal(pending.activeRunId, recovered.id, "Only the new fenced run owns the still-pending question");
  const context = await json<{ blockingQuestion: { id: string } }>(await kit.worker(`/runs/${recovered.id}/context`, undefined, recovered.runToken), 200);
  assert.equal(context.blockingQuestion.id, questionId);
  await json(await kit.tool(original, "/questions", { questionId: randomUUID(), content: "Stale question", toRole: "planner" }), 401);
  const bypass = await json<{ code: string }>(await kit.worker(`/runs/${recovered.id}/complete`, { ...kit.suspendPayload(recovered, questionId), status: "completed" }), 409);
  assert.equal(bypass.code, "question_requires_suspend");
  const saved = await kit.suspend(recovered, questionId);
  assert.equal(saved.replayed, false);
  assert.equal((await kit.suspend(recovered, questionId)).replayed, true, "A lost suspension response must not create duplicate work");
  const state = await kit.snapshot();
  assert.equal(state.goals[0].status, "waiting_question");
  assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].canAnswer, true);
  assert.equal(state.tasks.length, 1);
  assert.ok(state.runs.every(run => run.status !== "running"));
});

apiTest("Camp human waits terminate on cancellation or the duration budget and cannot be answered back into runnable work", async ({ seed, http, app, db }) => {
  for (const mode of ["cancel", "timeout"] as const) {
    const kit = await fixture({ seed, http, app });
    await kit.submit();
    const run = (await kit.claim())!;
    const questionId = await kit.ask(run);
    await kit.suspend(run, questionId);
    const waiting = await kit.snapshot();
    assert.equal(waiting.goals[0].status, "waiting_question");
    if (mode === "cancel") await json(await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${run.goalId}/cancel`), 200);
    else {
      await db.update(campGoals).set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campGoals.id, run.goalId));
      await reconcileCampPass();
    }
    const state = await kit.snapshot();
    const goal = state.goals[0];
    assert.equal(goal.status, mode === "cancel" ? "cancelled" : "needs_attention");
    assert.equal(goal.reason, mode === "cancel" ? "cancelled_by_human" : "duration_budget_exhausted");
    assert.equal(state.questions[0].status, "cancelled");
    assert.equal(state.questions[0].canAnswer, false);
    await json(await kit.post(`/api/camp/rooms/${kit.room.id}/questions/${questionId}/answer`, { answer: "Return an empty list" }), 409);
    assert.equal(await kit.claim(), null);
    assert.ok(state.tasks.every(task => !["queued", "running", "waiting_question"].includes(task.executionStatus)));
    assert.ok(state.runs.every(run => run.status !== "running"));
  }
});

apiTest("Camp rejects human decisions after the DB deadline even before the periodic reconciler runs", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit();
  const run = (await kit.claim())!, questionId = await kit.ask(run); await kit.suspend(run, questionId);
  await db.update(campGoals).set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campGoals.id, run.goalId));
  const response = await json<{ code: string }>(await kit.post(`/api/camp/rooms/${kit.room.id}/questions/${questionId}/answer`, { answer: "Too late" }), 409);
  assert.equal(response.code, "duration_budget_exhausted");
  const [question] = await db.select().from(campQuestions).where(eq(campQuestions.id, questionId));
  assert.equal(question.answer, null); assert.equal(question.resumedAt, null);
  assert.equal((await db.select().from(campTasks).where(eq(campTasks.taskId, run.taskId)))[0].status, "waiting_question");
  assert.equal((await db.select().from(campEvents).where(and(eq(campEvents.goalId, run.goalId), eq(campEvents.type, "question_resumed")))).length, 0);
});

apiTest("Camp refuses expired serial model mutations without waiting for the sweeper", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit(); const planner = (await kit.claim())!;
  await db.update(campGoals).set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campGoals.id, planner.goalId));
  for (const [path, body] of [["/plan", plan], ["/questions", { questionId: randomUUID(), content: "An expired decision", toRole: "planner" }]] as const) {
    const response = await json<{ code: string }>(await kit.tool(planner, path, body), 409); assert.equal(response.code, "duration_budget_exhausted");
  }
  assert.equal((await db.select().from(campQuestions).where(eq(campQuestions.goalId, planner.goalId))).length, 0);
});

apiTest("Camp question writes reject cross-room credentials, revoked human access and an old attempt", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const other = await fixture({ seed, http, app });
  await kit.submit(); await other.submit();
  const run = (await kit.claim())!;
  const otherRun = (await other.claim())!;
  await json(await kit.tool(run, "/questions", { questionId: randomUUID(), content: "Wrong room", toRole: "planner" }, other.token), 409);
  await json(await kit.tool(run, "/questions", { questionId: randomUUID(), content: "Wrong run", toRole: "planner" }, otherRun.runToken), 409);
  assert.equal((await db.select().from(campQuestions)).length, 0);
  const questionId = await kit.ask(run);
  await kit.suspend(run, questionId);
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, kit.channel.id), eq(channelHumans.userId, kit.member.id)));
  const denied = await kit.memberClient.request(`/api/camp/rooms/${kit.room.id}/questions/${questionId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "A revoked member cannot decide" }) });
  await json(denied, 404);
  assert.equal((await db.select().from(campQuestions).where(eq(campQuestions.id, questionId)))[0].answer, null);
  await json(await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${run.goalId}/cancel`), 200);
  await json(await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${run.goalId}/retry`, { expectedAttempt: 1 }), 200);
  assert.equal((await kit.claim())?.goalAttempt, 2);
  const oldAnswer = await json<{ code: string }>(await kit.post(`/api/camp/rooms/${kit.room.id}/questions/${questionId}/answer`, { answer: "An obsolete answer cannot wake the replacement attempt" }), 409);
  assert.equal(oldAnswer.code, "question_attempt_stopped");
  assert.equal((await db.select().from(campQuestions).where(eq(campQuestions.id, questionId)))[0].answer, null);
});

apiTest("Camp refuses to retry an old baseline after the accepted Room head changes", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const initial = await kit.submit();
  const goalId = initial.goals[0].id;
  await json(await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${goalId}/cancel`), 200);
  await db.update(campRooms).set({ acceptedRevision: 1, acceptedCandidate: layer }).where(eq(campRooms.id, kit.room.id));
  const stale = await kit.snapshot();
  assert.equal(stale.goals[0].canRetry, false);
  const retry = await json<{ code: string }>(await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${goalId}/retry`, { expectedAttempt: 1 }), 409);
  assert.equal(retry.code, "stale_baseline");
  const [goal] = await db.select().from(campGoals).where(eq(campGoals.id, goalId));
  assert.equal(goal.attempt, 1);
  assert.equal((await db.select().from(campTasks).where(eq(campTasks.goalId, goalId))).length, 1);
  const next = await kit.submit();
  const inherited = next.goals.find(value => value.id !== goalId)!;
  assert.equal(inherited.currentCandidate?.refKind, "layer");
  assert.equal(inherited.currentCandidate?.refId, layer.refId, "New goals inherit the accepted head even when it has no Commit");
});

apiTest("Camp role answers resume a suspended builder exactly once after its clarification run completes", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const builder = await startBuilder(kit);
  const questionId = await kit.ask(builder, false);
  await kit.suspend(builder, questionId);
  const clarification = (await kit.claim())!;
  assert.equal(clarification.taskKind, "clarification", "The only worker must be free to handle the routed question");
  assert.equal(clarification.role, "planner");
  assert.equal(clarification.goalId, builder.goalId);
  const answer = { answer: "Return an empty list, as required by the accepted plan" };
  const first = await json<{ replayed: boolean }>(await kit.tool(clarification, `/questions/${questionId}/answer`, answer), 200);
  assert.equal(first.replayed, false);
  assert.equal((await json<{ replayed: boolean }>(await kit.tool(clarification, `/questions/${questionId}/answer`, answer), 200)).replayed, true);
  assert.equal((await json<{ code: string }>(await kit.tool(clarification, `/questions/${questionId}/answer`, { answer: "Replace the immutable decision" }), 409)).code, "answer_conflict");
  const [answered] = await db.select().from(campQuestions).where(eq(campQuestions.id, questionId));
  assert.equal(answered.status, "answered");
  assert.equal(answered.resumedAt, null, "Saving an answer alone must not resume its origin while clarification still owns the worker");
  assert.equal((await db.select().from(campTasks).where(eq(campTasks.taskId, builder.taskId)))[0].status, "waiting_question");
  assert.equal(await kit.claim(), null);
  const completion = clarificationCompletion(clarification);
  assert.equal((await json<{ replayed: boolean }>(await kit.worker(`/runs/${clarification.id}/complete`, completion), 200)).replayed, false);
  const resumed = (await kit.claim())!;
  assert.equal(resumed.taskId, builder.taskId);
  assert.equal(resumed.epoch, builder.epoch + 1);
  assert.equal(resumed.inputCandidate?.refId, unchanged.refId);
  assert.equal((await json<{ replayed: boolean }>(await kit.worker(`/runs/${clarification.id}/complete`, completion), 200)).replayed, true);
  assert.equal(await kit.claim(), null);
  const state = await kit.snapshot();
  assert.equal(state.tasks.length, 3, "A replay must not append another clarification or builder task");
  assert.equal(state.goals[0].metrics.agentAnswers, 1);
  assert.equal(state.goals[0].metrics.humanAnswers, 0);
  assert.equal((await db.select().from(campEvents).where(and(eq(campEvents.goalId, builder.goalId), eq(campEvents.type, "question_resumed")))).length, 1);
});

apiTest("Camp escalation releases the clarification worker before a channel member's immutable human answer resumes execution", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const builder = await startBuilder(kit);
  const questionId = await kit.ask(builder, false);
  await kit.suspend(builder, questionId);
  const clarification = (await kit.claim())!;
  assert.equal(clarification.taskKind, "clarification");
  const reason = { reason: "The requirement leaves the empty-input product behavior undecided" };
  const escalated = await json<{ replayed: boolean }>(await kit.tool(clarification, `/questions/${questionId}/escalate`, reason), 200);
  assert.equal(escalated.replayed, false);
  assert.equal((await json<{ replayed: boolean }>(await kit.tool(clarification, `/questions/${questionId}/escalate`, reason), 200)).replayed, true);
  assert.equal((await json<{ code: string }>(await kit.tool(clarification, `/questions/${questionId}/escalate`, { reason: "A changed escalation" }), 409)).code, "escalation_conflict");
  const humanAnswer = (answer: string) => kit.memberClient.request(`/api/camp/rooms/${kit.room.id}/questions/${questionId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) });
  const answer = "Return an empty list";
  assert.equal((await kit.snapshot()).questions[0].canAnswer, false);
  const early = await json<{ code: string }>(await humanAnswer(answer), 409);
  assert.equal(early.code, "clarification_pending");
  assert.equal((await db.select().from(campQuestions).where(eq(campQuestions.id, questionId)))[0].answer, null);
  assert.equal(await kit.claim(), null);
  const completion = clarificationCompletion(clarification);
  await json(await kit.worker(`/runs/${clarification.id}/complete`, completion), 200);
  const waiting = await kit.snapshot();
  assert.equal(waiting.goals[0].status, "waiting_question");
  assert.equal(waiting.questions[0].canAnswer, true);
  assert.ok(waiting.runs.every(run => run.status !== "running"));
  await json(await humanAnswer(answer), 200);
  const resumed = (await kit.claim())!;
  assert.equal(resumed.taskId, builder.taskId);
  assert.equal(resumed.epoch, builder.epoch + 1);
  await json(await humanAnswer(answer), 200);
  assert.equal((await json<{ code: string }>(await humanAnswer("Replace the human decision"), 409)).code, "answer_conflict");
  assert.equal((await json<{ replayed: boolean }>(await kit.worker(`/runs/${clarification.id}/complete`, completion), 200)).replayed, true);
  assert.equal(await kit.claim(), null);
  const [question] = await db.select().from(campQuestions).where(eq(campQuestions.id, questionId));
  assert.equal(question.answerByUserId, kit.member.id, "Channel-post members can answer without room-admin privileges");
  assert.ok(question.resumedAt);
  const state = await kit.snapshot();
  assert.equal(state.tasks.length, 3);
  assert.equal(state.goals[0].metrics.humanAnswers, 1);
  assert.equal(state.goals[0].metrics.agentAnswers, 0);
  assert.equal((await db.select().from(campEvents).where(and(eq(campEvents.goalId, builder.goalId), eq(campEvents.type, "question_resumed")))).length, 1);
});
