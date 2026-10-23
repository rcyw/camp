import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { campGoals } from "../db/schema";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { apiTest } from "../test/integration/apiTest";
import type { roomSnapshot } from "../services/camp/rooms";
import type { CampCandidate, CampAgentClaimedRun as CampClaimedRun, CampPlanItem } from "../services/camp/types";

type Snapshot = Awaited<ReturnType<typeof roomSnapshot>>;
const baseline: CampCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
const item = (key: string): CampPlanItem => ({ key, title: key, description: `Implement ${key}`, acceptance: `${key} meets the goal`, verification: `Test ${key}` });
async function fixture({ seed, http, app }: { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } }) {
  const owner = await seed.human(), server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] }), user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Serial delivery", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text());
  const room = await created.json() as { id: string };
  const configured = await user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: { id: "compat", revision: 1, name: "Compatibility", maxRepairAttempts: 1, checks: [{ id: "checks", label: "Checks", argv: ["node", "--test"], timeoutMs: 1000 }] } }) });
  assert.equal(configured.status, 200);
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  const { token } = await minted.json() as { token: string };
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (path: string, body: unknown = {}) => user.request(`/api/camp/rooms/${room.id}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = async () => { const response = await user.get(`/api/camp/rooms/${room.id}`); assert.equal(response.status, 200); return await response.json() as Snapshot; };
  const submit = async (body: Record<string, unknown> = {}) => { const response = await post("/tasks", { title: "Deliver the original user goal", ...body }); assert.equal(response.status, 201, await response.clone().text()); const initial = await response.json() as Snapshot;
    // This suite preserves pre-v2 serial behavior; trusted verification is covered separately.
    await getDb().update(campGoals).set({ protocolVersion: 1, verificationPolicy: null }).where(eq(campGoals.id, initial.goals.at(-1)!.id));
    return initial; };
  const claim = async () => { const response = await worker("/claim", { workerId: "worker-a", protocol: createWorkerDeclaration() }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { run: CampClaimedRun | null }).run; };
  // Exercise the exact body injected by the DSH plugin transport.
  const tool = (run: CampClaimedRun, path: string, body: Record<string, unknown>) => worker(`/runs/${run.id}/${path}`, { workerId: "worker-a", runId: run.id, epoch: run.epoch, ...body }, run.runToken);
  const context = async (run: CampClaimedRun) => { const response = await worker(`/runs/${run.id}/context`, undefined, run.runToken); assert.equal(response.status, 200); return await response.json() as Record<string, any>; };
  const plan = async (run: CampClaimedRun, tasks = [item("first")]) => { const response = await tool(run, "plan", { planRevision: 1, summary: "Ordered implementation", tasks }); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as { replayed: boolean }; };
  let sequence = 1;
  const completion = (run: CampClaimedRun, extra: Record<string, unknown> = {}) => {
    const inputCandidate = run.inputCandidate ?? baseline, hex = (sequence++).toString(16).padStart(64, "0");
    const candidate = run.taskKind === "build" ? { ...inputCandidate, refKind: "commit", refId: `12${hex}`, commitId: `12${hex}`, layerId: undefined, rootId: hex, baseRef: inputCandidate.refId } : { ...inputCandidate, baseRef: inputCandidate.refId };
    return { workerId: "worker-a", epoch: run.epoch, status: "completed", summary: `${run.taskKind} completed`, inputCandidate, candidate, ...extra };
  };
  const complete = async (run: CampClaimedRun, extra: Record<string, unknown> = {}) => { const body = completion(run, extra), response = await worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; };
  const review = async (run: CampClaimedRun, outcome: "approved" | "changes_requested" = "approved") => {
    const target = (await context(run)).reviewTarget;
    const response = await tool(run, "events", { type: "artifact", content: "Verified exact candidate", artifact: { type: "review", outcome, evidence: "Acceptance checks executed", candidate: target } });
    assert.equal(response.status, 201, await response.clone().text()); return await complete(run, { outcome });
  };
  const finalize = async (run: CampClaimedRun) => { const response = await tool(run, "finalize", { summary: "Delivered the requested goal", evidence: "All acceptance checks passed", remaining: [] }); assert.equal(response.status, 200, await response.clone().text()); };
  return { user, room, token, worker, post, snapshot, submit, claim, tool, context, plan, completion, complete, review, finalize };
}

apiTest("Camp serial plan drives ordered work, bounded item and goal repair, final summary and accepted-head inheritance", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), initial = await kit.submit(), goalId = initial.goals[0].id;
  assert.equal(initial.goals[0].workflow, "serial"); assert.equal(initial.tasks.length, 1); assert.equal(initial.defaultBudget.serial.maxRuns, 24);
  const planner = (await kit.claim())!; assert.equal(planner.taskKind, "plan");
  assert.equal((await kit.worker(`/runs/${planner.id}/complete`, kit.completion(planner))).status, 409, "plan persistence is mandatory");
  await kit.plan(planner, [item("first"), item("second")]); assert.equal((await kit.plan(planner, [item("first"), item("second")])).replayed, true); await kit.complete(planner);
  let run = (await kit.claim())!; assert.equal(run.taskKind, "build"); assert.equal(run.planItemKey, "first"); await kit.complete(run); await kit.review((await kit.claim())!, "changes_requested");
  run = (await kit.claim())!; assert.equal(run.taskKind, "build"); assert.equal(run.planItemKey, "first"); await kit.complete(run); await kit.review((await kit.claim())!);
  run = (await kit.claim())!; assert.equal(run.planItemKey, "second"); await kit.complete(run); await kit.review((await kit.claim())!);
  run = (await kit.claim())!; assert.equal(run.taskKind, "final_review"); await kit.review(run, "changes_requested");
  run = (await kit.claim())!; assert.equal(run.taskKind, "build"); assert.equal(run.planItemKey, null, "whole-goal repair is separate from approved items"); await kit.complete(run);
  run = (await kit.claim())!; assert.equal(run.taskKind, "final_review"); await kit.review(run);
  run = (await kit.claim())!; assert.equal(run.taskKind, "summary");
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, kit.completion(run))).status, 409, "camp_finalize is mandatory"); await kit.finalize(run);
  const finalBody = await kit.complete(run), done = await kit.snapshot(), goal = done.goals.find(value => value.id === goalId)!;
  assert.equal(goal.status, "completed"); assert.equal(goal.items.every(value => value.status === "approved"), true); assert.equal(goal.metrics.reworks, 2);
  assert.equal(done.room.acceptedHead.revision, 1); assert.equal(done.room.acceptedHead.goalId, goalId); assert.equal(done.room.acceptedHead.candidate?.refId, goal.finalCandidate?.refId);
  const replay = await kit.worker(`/runs/${run.id}/complete`, finalBody); assert.equal(replay.status, 200, await replay.clone().text()); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  const result = await kit.user.get(`/api/camp/rooms/${kit.room.id}/goals/${goalId}/result`); assert.equal(result.status, 200); assert.equal((await result.json() as { resultReady: boolean }).resultReady, true);
  assert.equal((await kit.worker(`/goals/${goalId}/result`, undefined, run.runToken)).status, 401);
  await kit.submit({ fromGoalId: goalId }); run = (await kit.claim())!; assert.equal(run.inputCandidate?.refId, goal.finalCandidate?.refId);
  assert.equal((await kit.post("/tasks", { title: "Already busy" })).status, 409);
});

apiTest("Camp no-op delivery preserves a real immutable Layer through review, summary and result export", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit(); const planner = (await kit.claim())!; await kit.plan(planner);
  const valid = kit.completion(planner);
  assert.equal((await kit.worker(`/runs/${planner.id}/complete`, { ...valid, candidate: { ...valid.candidate, rootId: "d".repeat(64) } })).status, 409);
  assert.equal((await kit.worker(`/runs/${planner.id}/complete`, { ...valid, candidate: { ...valid.candidate, commitId: baseline.refId } })).status, 400);
  assert.equal((await kit.worker(`/runs/${planner.id}/complete`, valid)).status, 200);
  const build = (await kit.claim())!, wrong = kit.completion(build);
  assert.equal((await kit.worker(`/runs/${build.id}/complete`, { ...wrong, inputCandidate: { ...wrong.inputCandidate, refId: `32${"d".repeat(64)}`, layerId: `32${"d".repeat(64)}` } })).status, 409);
  assert.equal((await kit.worker(`/runs/${build.id}/complete`, { ...wrong, candidate: { ...wrong.candidate, baseRef: "main" } })).status, 409);
  await kit.complete(build, { candidate: { ...build.inputCandidate!, baseRef: build.inputCandidate!.refId } });
  const review = (await kit.claim())!, target = (await kit.context(review)).reviewTarget;
  assert.equal(target.refKind, "layer"); assert.equal(target.commitId, undefined);
  const report = (candidate: unknown) => kit.tool(review, "events", { type: "artifact", content: "Review", artifact: { type: "review", outcome: "approved", evidence: "Verified", candidate } });
  assert.equal((await report({ ...target, projectId: "p-fedcba9876543210" })).status, 409); assert.equal((await report({ ...target, refKind: "commit" })).status, 409);
  await kit.review(review); await kit.review((await kit.claim())!); const summary = (await kit.claim())!; await kit.finalize(summary); await kit.complete(summary);
  const state = await kit.snapshot(); assert.equal(state.goals[0].finalCandidate?.refKind, "layer"); assert.equal(state.room.acceptedHead.candidate?.commitId, undefined);
  const manifest = await kit.worker(`/goals/${state.goals[0].id}/result`); assert.equal(manifest.status, 200); const data = await manifest.json() as { resultReady: boolean; candidate: CampCandidate }; assert.equal(data.resultReady, true); assert.equal(data.candidate.refId, baseline.refId); assert.equal(data.candidate.layerId, baseline.layerId); assert.equal(data.candidate.commitId, undefined);
});
