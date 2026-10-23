import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campRuns, campWorkers } from "../db/schema";
import type { roomSnapshot } from "../services/camp/rooms";
import { reconcileCampPass } from "../services/camp/reconcile";
import type { CampAgentClaimedRun, CampCandidate, CampClaimedRun, CampVerificationClaimedRun, CampIntegrationClaimedRun } from "../services/camp/types";

const executionPool = { poolId: "11111111-1111-4111-8111-111111111111", storageId: "1".repeat(64), maxParallel: 2 as const, workerIds: ["lane-1", "lane-2"], resources: { maxContainers: 4 as const, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };
const declaration = () => ({ ...createWorkerDeclaration(), executionPool });
type Snapshot = Awaited<ReturnType<typeof roomSnapshot>>;
const baseline: CampCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
const policy = { id: "acceptance", revision: 1, name: "Operator acceptance", checks: [{ id: "acceptance", label: "Independent requirement checks", argv: ["node", "--test", "/workspace/acceptance.test.mjs"], timeoutMs: 1000 }], maxRepairAttempts: 1 };
async function fixture({ seed, http, app }: { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } }, configured = true) {
  const owner = await seed.human(), member = await seed.human(), server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner, member] }), user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Verified delivery", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text()); const room = await created.json() as { id: string };
  const configure = (value: unknown = policy) => user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: value }) });
  if (configured) { const response = await configure(); assert.equal(response.status, 200, await response.clone().text()); }
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" }); const { token } = await minted.json() as { token: string };
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (path: string, body: unknown = {}) => user.request(`/api/camp/rooms/${room.id}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = async () => { const response = await user.get(`/api/camp/rooms/${room.id}`); assert.equal(response.status, 200); return await response.json() as Snapshot; };
  const submit = async () => { const response = await post("/tasks", { title: "Deliver two independent changes", planMode: "parallel_pair" }); assert.equal(response.status, 201, await response.clone().text()); return await response.json() as Snapshot; };
  const owners = new Map<string, string>();
  const ownerOf = (run: { id: string }) => owners.get(run.id) ?? "lane-1";
  const rawClaim = async (extra: Record<string, unknown> = {}) => { const response = await worker("/claim", { workerId: "lane-1", protocol: declaration(), ...extra }); assert.equal(response.status, 200, await response.clone().text()); const body = await response.json() as any; if (body.run) owners.set(body.run.id, String(extra.workerId ?? "lane-1")); return body; };
  const claim = async (extra: Record<string, unknown> = {}) => (await rawClaim(extra)).run as CampClaimedRun | null;
  const agent = async () => { const run = await claim(); assert.ok(run); assert.equal(run.executor, "agent"); return run as CampAgentClaimedRun; };
  const verifier = async () => { const run = await claim(); assert.ok(run); assert.equal(run.executor, "verification"); return run as CampVerificationClaimedRun; };
  const tool = (run: CampAgentClaimedRun, path: string, body: Record<string, unknown>) => worker(`/runs/${run.id}/${path}`, { workerId: ownerOf(run), runId: run.id, epoch: run.epoch, ...body }, run.runToken);
  const context = async (run: CampAgentClaimedRun) => { const response = await worker(`/runs/${run.id}/context`, undefined, run.runToken); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as Record<string, any>; };
  let sequence = 1;
  const completion = (run: CampAgentClaimedRun, extra: Record<string, unknown> = {}) => {
    const inputCandidate = run.inputCandidate ?? baseline, hex = (sequence++).toString(16).padStart(64, "0");
    const candidate = run.taskKind === "build" ? { ...inputCandidate, refKind: "commit", refId: `12${hex}`, commitId: `12${hex}`, layerId: undefined, rootId: hex, baseRef: inputCandidate.refId } : { ...inputCandidate, baseRef: inputCandidate.refId };
    const changeSet = run.taskKind === "build" ? { schemaVersion: 1, base: run.goalBaseline ?? baseline, target: candidate, entries: [{ path: "result.txt", change: "added", before: null, after: { type: "file", mode: 420, size: 2, sha256: "d".repeat(64) }, binary: false, modeChanged: false, patch: "+ok\n", patchTruncated: false, previewReason: null }], truncated: false, stats: { added: 1, modified: 0, deleted: 0, typeChanged: 0 } } : undefined;
    return { workerId: ownerOf(run), epoch: run.epoch, status: "completed", summary: `${run.taskKind} completed`, inputCandidate, candidate, ...(changeSet ? { changeSet } : {}), ...extra };
  };
  const complete = async (run: CampAgentClaimedRun, extra: Record<string, unknown> = {}) => { const body = completion(run, extra), response = await worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; };
  const review = async (run: CampAgentClaimedRun) => { const response = await tool(run, "events", { type: "artifact", content: "Verified exact candidate", artifact: { type: "review", outcome: "approved", evidence: "Reviewed immutable candidate", candidate: (await context(run)).reviewTarget } }); assert.equal(response.status, 201, await response.clone().text()); await complete(run, { outcome: "approved" }); };
  const report = (run: CampVerificationClaimedRun, exitCode = 0) => ({ candidate: run.inputCandidate, policyDigest: run.verificationPolicy.digest, checks: run.verificationPolicy.policy.checks.map(check => ({ id: check.id, argv: check.argv, exitCode, signal: null, timedOut: false, oomKilled: false, durationMs: 10, stdout: "Observed checks", stderr: exitCode ? "Requirement missing" : "", outputTruncated: false })) });
  const verifyBody = (run: CampVerificationClaimedRun, exitCode = 0) => ({ workerId: ownerOf(run), epoch: run.epoch, status: "completed", summary: "Independent operator checks finished", inputCandidate: run.inputCandidate, verification: report(run, exitCode) });
  const verify = async (run: CampVerificationClaimedRun, exitCode = 0) => { const body = verifyBody(run, exitCode), response = await worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; };
  const preparePair = async () => {
    const initial = await submit(), planner = await agent();
    const tasks = ["alpha", "beta"].map(key => ({ key, title: key, description: `Independent ${key}`, acceptance: `${key} works`, verification: `Check ${key}` }));
    const invalid = await tool(planner, "plan", { planRevision: 1, summary: "Invalid one-item plan", tasks: tasks.slice(0, 1) }); assert.equal(invalid.status, 400);
    assert.equal((await tool(planner, "plan", { planRevision: 1, summary: "Two independent items", tasks })).status, 200); await complete(planner);
    const first = await agent(); assert.equal(first.planItemKey, "alpha"); const firstBody = await complete(first); await review(await agent());
    const second = await agent(); assert.equal(second.planItemKey, "beta"); assert.equal(second.inputCandidate?.refId, baseline.refId, "second item must not inherit first item");
    const secondBody = await complete(second); await review(await agent());
    const integration = await claim(); assert.ok(integration); assert.equal(integration.executor, "integration");
    return { initial, planner, first, second, firstBody, secondBody, integration: integration as CampIntegrationClaimedRun };
  };
  const integrationBody = (run: CampIntegrationClaimedRun, status = "merged") => {
    const refId = `12${"f".repeat(64)}`, candidate = { ...run.inputCandidate, refKind: "commit", refId, commitId: refId, layerId: undefined, rootId: "e".repeat(64), baseRef: run.inputCandidate.refId };
    const integration = { schemaVersion: 1, inputDigest: run.inputDigest, algorithm: run.integrationInput.algorithm, policy: run.integrationInput.policy, status, candidate: status === "merged" ? candidate : null, conflicts: status === "merged" ? [] : [{ path: "shared.txt", reason: "overlap" }], truncated: false };
    const changeSet = { schemaVersion: 1, base: baseline, target: candidate, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } };
    return { workerId: ownerOf(run), epoch: run.epoch, status: "completed", summary: `Integration ${status}`, inputCandidate: run.inputCandidate, integration, ...(status === "merged" ? { candidate, changeSet } : {}) };
  };
  return { rawClaim, ownerOf, owner, member, server, user, room, token, worker, configure, post, snapshot, submit, claim, agent, verifier, tool, context, completion, complete, review, preparePair, integrationBody, report, verifyBody, verify };

}
async function planned(kit: Awaited<ReturnType<typeof fixture>>) {
  await kit.submit(); const planner = await kit.agent();
  const tasks = ["alpha", "beta"].map(key => ({ key, title: key, description: `Independent ${key}`, acceptance: `${key} works`, verification: `Check ${key}` }));
  assert.equal((await kit.tool(planner, "plan", { planRevision: 1, summary: "Two independent changes", tasks })).status, 200);
  await kit.complete(planner); return planner;
}
apiTest("parallel pair allocates exactly two independent builders, serializes reviews and gates one trusted integration", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const [first, second] = await Promise.all([kit.claim(), kit.claim({ workerId: "lane-2" })]) as CampAgentClaimedRun[];
  assert.ok(first && second); assert.equal(first.taskKind, "build"); assert.equal(second.taskKind, "build");
  assert.equal(first.agentId, second.agentId); assert.notEqual(first.planItemKey, second.planItemKey);
  assert.equal(first.inputCandidate?.refId, baseline.refId); assert.equal(second.inputCandidate?.refId, baseline.refId);
  assert.equal(await kit.claim(), null);
  let state = await kit.snapshot(); assert.equal(state.runs.filter(run => run.status === "running").length, 2); assert.deepEqual(state.goals[0].executionPool, executionPool); assert.equal(state.room.storageId, executionPool.storageId); assert.equal(state.runs.filter(run => run.status === "running").every(run => run.leaseValid), true);
  await kit.complete(second);
  const reviewer = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun; assert.equal(reviewer.taskKind, "review");
  assert.equal(await kit.claim({ workerId: "lane-2" }), null);
  await kit.complete(first); assert.equal(await kit.claim(), null, "Two reviewers cannot share one reviewer identity");
  await kit.review(reviewer); await kit.review(await kit.agent());
  state = await kit.snapshot(); assert.equal(state.operations.filter(operation => operation.kind === "integration").length, 1); assert.equal(state.goals[0].currentCandidate?.refId, baseline.refId);
  const integration = await kit.claim() as CampIntegrationClaimedRun; assert.equal(integration.executor, "integration"); assert.equal(integration.protocolVersion, 4); assert.deepEqual(integration.integrationInput.parents.map(parent => parent.key), ["alpha", "beta"]);
  assert.equal(await kit.claim({ workerId: "lane-2" }), null);
  const body = kit.integrationBody(integration); assert.equal((await kit.worker(`/runs/${integration.id}/complete`, body)).status, 200); assert.equal((await kit.worker(`/runs/${integration.id}/complete`, body)).status, 200);
  await kit.verify(await kit.verifier()); await kit.review(await kit.agent()); const summary = await kit.agent(); await kit.tool(summary, "finalize", { summary: "Both independent changes integrated", remaining: [] }); await kit.complete(summary);
  state = await kit.snapshot(); assert.equal(state.goals[0].resultReady, true); assert.equal(state.goals[0].runCount, 9); assert.equal(state.goals[0].items.every(item => item.scheduling.state === "approved"), true);
});
apiTest("parallel pool mismatches never consume budget and restore-only unbound intent is read-only", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit();
  const intent = { claimId: randomUUID(), runToken: `camp_run_${"a".repeat(64)}` };
  const restored = await kit.rawClaim({ ...intent, restoreOnly: true }); assert.equal(restored.unbound, true); assert.equal(restored.run, null);
  assert.equal((await db.select().from(campWorkers)).length, 0); assert.equal((await kit.snapshot()).goals[0].runCount, 0);
  assert.equal((await kit.rawClaim({ protocol: createWorkerDeclaration() })).compatibility.code, "pool_required");
  assert.equal((await kit.rawClaim({ workerId: "rogue-lane" })).compatibility.code, "lane_not_registered");
  const planner = (await kit.rawClaim(intent)).run as CampAgentClaimedRun;
  assert.ok(planner); const replay = await kit.rawClaim({ ...intent, restoreOnly: true, protocol: undefined }); assert.equal(replay.run.id, planner.id); assert.equal(replay.run.runToken, planner.runToken);
  assert.equal((await kit.worker(`/runs/${planner.id}/complete`, { workerId: "lane-1", epoch: planner.epoch, status: "failed", summary: "Model failed", error: "model_error" })).status, 200);
  assert.equal((await kit.rawClaim({ ...intent, restoreOnly: true })).closed, true);
  assert.equal((await kit.post(`/goals/${planner.goalId}/retry`, { expectedAttempt: 1 })).status, 200);
  for (const [pool, code] of [[{ ...executionPool, storageId: "2".repeat(64) }, "storage_mismatch"], [{ ...executionPool, poolId: "22222222-2222-4222-8222-222222222222" }, "pool_mismatch"], [{ ...executionPool, workerIds: ["lane-1", "different-lane"] }, "pool_mismatch"]] as const) {
    const mismatch = await kit.rawClaim({ protocol: { ...declaration(), executionPool: pool } }); assert.equal(mismatch.run, null); assert.equal(mismatch.compatibility.code, code);
  }
  const state = await kit.snapshot(); assert.equal(state.goals[0].runCount, 0); assert.equal(state.goals[0].status, "queued"); assert.deepEqual(state.goals[0].executionPool, executionPool);
});
apiTest("parallel expired cleanup blocks replacement and admission while one-run cancel drains the goal", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const first = await kit.agent(), second = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun;
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, first.id)); await reconcileCampPass();
  assert.equal(await kit.claim(), null); assert.equal((await kit.snapshot()).runs.find(run => run.id === first.id)?.cleanupState, "unknown");
  const requested = await kit.post(`/runs/${second.id}/cancel`); assert.equal(requested.status, 200, await requested.clone().text());
  let state = await kit.snapshot(); assert.equal(state.goals[0].status, "cancelling"); assert.ok(state.runs.find(run => run.id === second.id)?.cancelRequestedAt);
  assert.equal((await kit.worker(`/runs/${second.id}/complete`, { workerId: "lane-2", epoch: second.epoch, status: "cancelled", summary: "Resources removed" })).status, 200);
  assert.equal((await kit.post(`/goals/${first.goalId}/retry`, { expectedAttempt: 1 })).status, 409); assert.equal((await kit.post("/tasks", { title: "Cannot bypass cleanup", planMode: "parallel_pair" })).status, 409);
  assert.equal((await kit.worker(`/runs/${first.id}/cleanup`, { workerId: "lane-1", epoch: first.epoch })).status, 200);
  assert.equal((await kit.post(`/goals/${first.goalId}/retry`, { expectedAttempt: 1 })).status, 200); state = await kit.snapshot(); assert.equal(state.goals[0].attempt, 2); assert.deepEqual(state.goals[0].executionPool, executionPool);
});
apiTest("parallel item questions and review repairs preserve each branch and never advance the common baseline", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const first = await kit.agent(), second = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun;
  const questionId = randomUUID(); assert.equal((await kit.tool(first, "questions", { questionId, content: "Clarify this item's acceptance", toRole: "planner" })).status, 200);
  const suspended = kit.completion(first, { status: "suspended", questionId }); assert.equal((await kit.worker(`/runs/${first.id}/complete`, suspended)).status, 200);
  const clarification = await kit.agent(); assert.equal(clarification.taskKind, "clarification"); assert.equal((await kit.tool(clarification, `questions/${questionId}/answer`, { answer: "Preserve this item's independent contract" })).status, 200); await kit.complete(clarification);
  const resumed = await kit.agent(); assert.equal(resumed.taskId, first.taskId); assert.equal(resumed.inputCandidate?.refId, suspended.candidate.refId); assert.equal(resumed.epoch, first.epoch + 1);
  await kit.complete(second); const review = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun;
  assert.equal((await kit.tool(review, "events", { type: "artifact", content: "One correction required", artifact: { type: "review", outcome: "changes_requested", evidence: "Missing item-specific case", candidate: (await kit.context(review)).reviewTarget } })).status, 201);
  await kit.complete(review, { outcome: "changes_requested" });
  const repair = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun; assert.equal(repair.taskKind, "build"); assert.equal(repair.planItemKey, second.planItemKey); assert.equal(repair.inputCandidate?.refId, review.inputCandidate?.refId); assert.notEqual(repair.inputCandidate?.refId, resumed.inputCandidate?.refId);
  let state = await kit.snapshot(); assert.equal(state.goals[0].currentCandidate?.refId, baseline.refId); assert.equal(state.operations.length, 0); assert.equal(state.goals[0].metrics.agentAnswers, 1);
  assert.equal((await kit.post(`/runs/${repair.id}/cancel`)).status, 200); state = await kit.snapshot(); assert.equal(state.runs.filter(run => run.status === "running").every(run => run.cancelRequestedAt !== null), true);
});
apiTest("two suspended parallel builders receive serialized planner clarifications and both resume without deadlock", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const first = await kit.agent(), second = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun;
  const questions = [randomUUID(), randomUUID()];
  for (const [index, run] of [first, second].entries()) assert.equal((await kit.tool(run, "questions", { questionId: questions[index], content: `Clarify ${run.planItemKey}`, toRole: "planner" })).status, 200);
  const checkpoints = [first, second].map((run, index) => kit.completion(run, { status: "suspended", questionId: questions[index] }));
  const responses = await Promise.all([first, second].map((run, index) => kit.worker(`/runs/${run.id}/complete`, checkpoints[index]))); assert.ok(responses.every(response => response.status === 200));
  const one = await kit.agent(); assert.equal(one.taskKind, "clarification"); assert.equal(await kit.claim({ workerId: "lane-2" }), null, "Planner clarification remains a single logical role");
  const context = await kit.context(one), questionId = context.assignedQuestion.id;
  assert.equal((await kit.tool(one, `questions/${questionId}/answer`, { answer: "First independent contract clarified" })).status, 200); await kit.complete(one);
  const two = await kit.agent(); assert.equal(two.taskKind, "clarification", "Outstanding clarification takes priority over the resumed builder");
  const resumedOne = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun; assert.equal(resumedOne.taskKind, "build"); assert.equal(resumedOne.epoch, 2);
  const assigned = (await kit.context(two)).assignedQuestion.id; assert.notEqual(assigned, questionId);
  assert.equal((await kit.tool(two, `questions/${assigned}/answer`, { answer: "Second independent contract clarified" })).status, 200); await kit.complete(two);
  const resumedTwo = await kit.agent(); assert.equal(resumedTwo.taskKind, "build"); assert.equal(resumedTwo.epoch, 2); assert.notEqual(resumedTwo.taskId, resumedOne.taskId);
  const state = await kit.snapshot(); assert.equal(state.goals[0].metrics.questionsAnswered, 2); assert.equal(state.goals[0].metrics.agentAnswers, 2); assert.equal(state.goals[0].questions.filter(question => question.resumedAt !== null).length, 2); assert.equal(state.goals[0].currentCandidate?.refId, baseline.refId); assert.equal(state.runs.filter(run => run.status === "running").length, 2);
  assert.equal((await kit.post(`/goals/${first.goalId}/cancel`)).status, 200);
});
apiTest("a parallel clarification escalated to a human only blocks its item while the other builder keeps its live lease", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const first = await kit.agent(), second = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun, questionId = randomUUID();
  assert.equal((await kit.tool(first, "questions", { questionId, content: "Human product decision is needed", toRole: "planner" })).status, 200);
  assert.equal((await kit.worker(`/runs/${first.id}/complete`, kit.completion(first, { status: "suspended", questionId }))).status, 200);
  const clarification = await kit.agent(); assert.equal(clarification.taskKind, "clarification");
  assert.equal((await kit.tool(clarification, `questions/${questionId}/escalate`, { reason: "Only the human may choose this item's behavior" })).status, 200); await kit.complete(clarification);
  let state = await kit.snapshot(); assert.equal(state.goals[0].status, "running"); assert.equal(state.goals[0].questions[0].status, "awaiting_human"); assert.equal(state.runs.find(run => run.id === second.id)?.leaseValid, true); assert.equal(state.goals[0].items.find(item => item.key === first.planItemKey)?.scheduling.state, "waiting_question");
  assert.equal((await kit.tool(second, "events", { type: "progress", content: "The independent item continues while the first item waits" })).status, 201); await kit.complete(second);
  await kit.review(await kit.agent()); state = await kit.snapshot(); assert.equal(state.goals[0].status, "waiting_question", "Only an entirely idle goal waits for the human");
  assert.equal((await kit.post(`/questions/${questionId}/answer`, { answer: "Use the independently specified behavior" })).status, 200);
  const resumed = await kit.agent(); assert.equal(resumed.taskId, first.taskId); assert.equal(resumed.epoch, 2); assert.equal((await kit.snapshot()).goals[0].metrics.humanAnswers, 1);
  assert.equal((await kit.post(`/goals/${first.goalId}/cancel`)).status, 200);
});
apiTest("compatible pooled lanes retain useful idle admission facts instead of erasing their negotiated requirements", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const first = await kit.agent(), second = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun;
  await kit.complete(first);
  const laneBusy = await kit.rawClaim({ workerId: "lane-2" }); assert.equal(laneBusy.run, null); assert.equal(laneBusy.compatibility.status, "compatible"); assert.equal(laneBusy.requirements.taskKind, "review"); assert.equal(laneBusy.admission.reason, "lane_busy");
  let state = await kit.snapshot(); assert.equal(state.workers.find(worker => worker.workerId === "lane-2")?.compatibility?.status, "compatible");
  const reviewer = await kit.agent(); await kit.complete(second);
  const roleBusy = await kit.rawClaim({ workerId: "lane-2" }); assert.equal(roleBusy.run, null); assert.equal(roleBusy.compatibility.status, "compatible"); assert.equal(roleBusy.requirements.taskKind, "review"); assert.equal(roleBusy.admission.reason, "role_busy");
  state = await kit.snapshot(); assert.equal(state.goals[0].runCount, 4); assert.ok(reviewer.id);
});
apiTest("an incompatible earlier legacy task does not override a later compatible task waiting on its role", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  for (const [role, title] of [["planner", "Occupied planner"], ["builder", "Occupied builder"]] as const) {
    assert.equal((await kit.post("/tasks", { title, role })).status, 201);
    const run = await kit.claim({ workerId: role === "planner" ? "lane-1" : "lane-2" }); assert.ok(run?.executor === "agent"); assert.equal(run.role, role);
  }
  for (const role of ["planner", "builder"]) assert.equal((await kit.post("/tasks", { title: `Waiting ${role}`, role })).status, 201);
  const waiting = await kit.rawClaim({ workerId: "legacy-observer", protocol: { ...declaration(), taskKinds: ["build"] } });
  assert.equal(waiting.run, null); assert.equal(waiting.compatibility.status, "compatible"); assert.equal(waiting.requirements.taskKind, "build"); assert.equal(waiting.admission.reason, "role_busy");
});
