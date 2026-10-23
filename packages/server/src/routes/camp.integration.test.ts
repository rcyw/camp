import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campRuns, campGoals, channels, channelConversionFences, channelConversionJobs } from "../db/schema";
import type { roomSnapshot } from "../services/camp/rooms";
import { reconcileCampPass } from "../services/camp/reconcile";
import type { CampAgentClaimedRun, CampCandidate, CampClaimedRun, CampVerificationClaimedRun, CampIntegrationClaimedRun } from "../services/camp/types";

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
  const submit = async () => { const response = await post("/tasks", { title: "Deliver two independent changes", planMode: "same_baseline_pair" }); assert.equal(response.status, 201, await response.clone().text()); return await response.json() as Snapshot; };
  const claim = async (extra: Record<string, unknown> = {}) => { const response = await worker("/claim", { workerId: "verification-worker", protocol: createWorkerDeclaration(), ...extra }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { run: CampClaimedRun | null }).run; };
  const agent = async () => { const run = await claim(); assert.ok(run); assert.equal(run.executor, "agent"); return run as CampAgentClaimedRun; };
  const verifier = async () => { const run = await claim(); assert.ok(run); assert.equal(run.executor, "verification"); return run as CampVerificationClaimedRun; };
  const tool = (run: CampAgentClaimedRun, path: string, body: Record<string, unknown>) => worker(`/runs/${run.id}/${path}`, { workerId: "verification-worker", runId: run.id, epoch: run.epoch, ...body }, run.runToken);
  const context = async (run: CampAgentClaimedRun) => { const response = await worker(`/runs/${run.id}/context`, undefined, run.runToken); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as Record<string, any>; };
  let sequence = 1;
  const completion = (run: CampAgentClaimedRun, extra: Record<string, unknown> = {}) => {
    const inputCandidate = run.inputCandidate ?? baseline, hex = (sequence++).toString(16).padStart(64, "0");
    const candidate = run.taskKind === "build" ? { ...inputCandidate, refKind: "commit", refId: `12${hex}`, commitId: `12${hex}`, layerId: undefined, rootId: hex, baseRef: inputCandidate.refId } : { ...inputCandidate, baseRef: inputCandidate.refId };
    const changeSet = run.taskKind === "build" ? { schemaVersion: 1, base: run.goalBaseline ?? baseline, target: candidate, entries: [{ path: "result.txt", change: "added", before: null, after: { type: "file", mode: 420, size: 2, sha256: "d".repeat(64) }, binary: false, modeChanged: false, patch: "+ok\n", patchTruncated: false, previewReason: null }], truncated: false, stats: { added: 1, modified: 0, deleted: 0, typeChanged: 0 } } : undefined;
    return { workerId: "verification-worker", epoch: run.epoch, status: "completed", summary: `${run.taskKind} completed`, inputCandidate, candidate, ...(changeSet ? { changeSet } : {}), ...extra };
  };
  const complete = async (run: CampAgentClaimedRun, extra: Record<string, unknown> = {}) => { const body = completion(run, extra), response = await worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; };
  const review = async (run: CampAgentClaimedRun) => { const response = await tool(run, "events", { type: "artifact", content: "Verified exact candidate", artifact: { type: "review", outcome: "approved", evidence: "Reviewed immutable candidate", candidate: (await context(run)).reviewTarget } }); assert.equal(response.status, 201, await response.clone().text()); await complete(run, { outcome: "approved" }); };
  const report = (run: CampVerificationClaimedRun, exitCode = 0) => ({ candidate: run.inputCandidate, policyDigest: run.verificationPolicy.digest, checks: run.verificationPolicy.policy.checks.map(check => ({ id: check.id, argv: check.argv, exitCode, signal: null, timedOut: false, oomKilled: false, durationMs: 10, stdout: "Observed checks", stderr: exitCode ? "Requirement missing" : "", outputTruncated: false })) });
  const verifyBody = (run: CampVerificationClaimedRun, exitCode = 0) => ({ workerId: "verification-worker", epoch: run.epoch, status: "completed", summary: "Independent operator checks finished", inputCandidate: run.inputCandidate, verification: report(run, exitCode) });
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
    return { workerId: "verification-worker", epoch: run.epoch, status: "completed", summary: `Integration ${status}`, inputCandidate: run.inputCandidate, integration, ...(status === "merged" ? { candidate, changeSet } : {}) };
  };
  return { owner, member, server, user, room, token, worker, configure, post, snapshot, submit, claim, agent, verifier, tool, context, completion, complete, review, preparePair, integrationBody, report, verifyBody, verify };

}

apiTest("Camp pair freezes two reviewed producers, integrates rolelessly, verifies exact merged output and publishes its receipt", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), prepared = await kit.preparePair(), run = prepared.integration;
  assert.equal(run.protocolVersion, 3); assert.equal(run.taskId, null); assert.equal(run.role, null); assert.equal("runToken" in run, false); assert.equal("prompt" in run, false);
  assert.deepEqual(run.integrationInput.parents.map(parent => [parent.key, parent.runId, parent.epoch]), [["alpha", prepared.first.id, prepared.first.epoch], ["beta", prepared.second.id, prepared.second.epoch]]);
  assert.equal(run.integrationInput.base.refId, baseline.refId);
  assert.equal((await kit.worker(`/runs/${run.id}/events`, { workerId: "verification-worker", epoch: run.epoch, type: "progress", content: "spoof" })).status, 403);
  const body = kit.integrationBody(run);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, integration: { ...body.integration, inputDigest: "0".repeat(64) } })).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, candidate: prepared.firstBody.candidate })).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, changeSet: undefined })).status, 409);
  const result = await kit.worker(`/runs/${run.id}/complete`, body); assert.equal(result.status, 200, await result.clone().text());
  let snapshot = await kit.snapshot(); assert.equal(snapshot.goals[0].integration.status, "merged"); assert.equal(snapshot.goals[0].resultReady, false); assert.equal(snapshot.goals[0].verification.operations.length, 1);
  assert.equal(snapshot.operations.find(op => op.kind === "integration")?.integrationReport?.runId, run.id);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 200); assert.equal((await kit.snapshot()).operations.length, 2);
  const verifier = await kit.verifier(); assert.equal(verifier.inputCandidate.refId, body.candidate!.refId); await kit.verify(verifier);
  await kit.review(await kit.agent()); const summary = await kit.agent(); assert.equal((await kit.tool(summary, "finalize", { summary: "Combined delivery", evidence: "Both changes independently integrated and verified", remaining: [] })).status, 200); await kit.complete(summary);
  snapshot = await kit.snapshot(); const goal = snapshot.goals[0]; assert.equal(goal.resultReady, true); assert.equal(goal.runCount, 9); assert.equal(goal.reviewRounds, 3); assert.equal(goal.planMode, "same_baseline_pair");
  const base = `/api/camp/rooms/${kit.room.id}/goals/${goal.id}`;
  const manifest = await (await kit.user.get(`${base}/result`)).json() as any; assert.equal(manifest.planMode, "same_baseline_pair"); assert.equal(manifest.integration.receipt.runId, run.id); assert.equal(manifest.integration.input.parents[1].runId, prepared.second.id);
  const versions = await (await kit.user.get(`${base}/versions`)).json() as any; assert.equal(versions.versions.find((version: any) => version.runId === run.id).kind, "integration");
  assert.equal((await (await kit.user.get(`${base}/versions/${run.id}/changes`)).json() as any).available, true);
  assert.equal((await (await kit.user.get(`${base}/versions/${run.id}/verification`)).json() as any).status, "passed");
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, snapshot.room.channelId));
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 200, "archived exact replay remains a pure acknowledgement");
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, summary: "changed" })).status, 409);
});

apiTest("Camp pair conflict is a durable business result, cannot publish a parent and never auto retries integration", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair();
  const body = kit.integrationBody(run, "conflict"); assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 200);
  const state = await kit.snapshot(); assert.equal(state.goals[0].status, "needs_attention"); assert.equal(state.goals[0].reason, "integration_conflict"); assert.equal(state.goals[0].integration.status, "conflict"); assert.equal(state.goals[0].verification.operations.length, 0); assert.equal(state.goals[0].verification.status, "not_run"); assert.equal(state.room.acceptedHead.candidate, null); assert.equal(await kit.claim(), null);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 200);
  const retry = await kit.post(`/goals/${state.goals[0].id}/retry`, { expectedAttempt: 1 }); assert.equal(retry.status, 200, await retry.clone().text());
  const next = await kit.snapshot(); assert.deepEqual(next.goals[0].reviewedItems, {}); assert.equal(next.goals[0].integration.status, "pending"); assert.equal(next.operations[0].integrationInput?.parents[0].runId, run.integrationInput.parents[0].runId);
});

apiTest("Camp integration lease loss and explicit unknown outcome require inspection, while cancellation still cleans up normally", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair();
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await reconcileCampPass(); const snapshot = await kit.snapshot(); assert.equal(snapshot.goals[0].reason, "integration_inspection_required"); assert.equal(snapshot.operations[0].status, "failed"); assert.equal(snapshot.goals[0].canRetry, false); assert.equal((await kit.post(`/goals/${snapshot.goals[0].id}/retry`, { expectedAttempt: 1 })).status, 409); assert.equal(await kit.claim(), null);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, kit.integrationBody(run))).status, 409);
});

apiTest("Camp reconciles an archived integrator despite a retained conversion write fence", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), before = await kit.snapshot();
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, before.room.channelId));
  const [job] = await db.insert(channelConversionJobs).values({ serverId: kit.server.id, sourceChannelId: before.room.channelId, sourceChannelType: "channel", status: "failed", state: "failed", createdByUserId: kit.owner.id }).returning();
  await db.insert(channelConversionFences).values({ jobId: job.id, serverId: kit.server.id, sourceChannelId: before.room.channelId, conversionEpoch: job.conversionEpoch });
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await reconcileCampPass();
  const [settled] = await db.select().from(campRuns).where(eq(campRuns.id, run.id)), [goal] = await db.select().from(campGoals).where(eq(campGoals.id, run.goalId));
  assert.equal(settled.status, "cancelled"); assert.equal(settled.error, "cancelled_after_lease_expiry");
  assert.equal(goal.status, "needs_attention"); assert.equal(goal.reason, "channel_unavailable"); assert.equal(goal.integrationInspectionRequired, true);
  const state = await kit.worker(`/runs/${run.id}/state`); assert.equal(state.status, 200);
  assert.equal((await state.json() as any).cleanupState, "unknown");
  const cleanup = await kit.worker(`/runs/${run.id}/cleanup`, { workerId: "verification-worker", epoch: run.epoch }); assert.equal(cleanup.status, 200, await cleanup.clone().text());
  assert.equal((await cleanup.json() as any).cleanupState, "confirmed");
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, run.goalId)))[0].integrationInspectionRequired, true, "Physical cleanup cannot clear native uncertainty");
});

apiTest("Camp whole-goal repair preserves the original frozen integration receipt", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair();
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, kit.integrationBody(run))).status, 200); const frozen = (await kit.snapshot()).operations[0].integrationReport;
  await kit.verify(await kit.verifier(), 1); const repair = await kit.agent(); assert.equal(repair.planItemKey, null); await kit.complete(repair); await kit.verify(await kit.verifier()); await kit.review(await kit.agent());
  const summary = await kit.agent(); await kit.tool(summary, "finalize", { summary: "Repaired integrated result", remaining: [] }); await kit.complete(summary);
  const state = await kit.snapshot(); assert.equal(state.goals[0].resultReady, true); assert.deepEqual(state.operations.find(op => op.kind === "integration")?.integrationReport, frozen); assert.notEqual(state.goals[0].finalCandidate?.refId, frozen?.candidate?.refId);
});

apiTest("Camp pair protocol, budgets, and model tokens cannot bypass the trusted integration allocation", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  assert.equal((await kit.post("/tasks", { title: "Bad mode", workflow: "legacy", planMode: "same_baseline_pair" })).status, 400);
  assert.equal((await kit.post("/tasks", { title: "Unknown mode", planMode: "general_dag" })).status, 400);
  await kit.submit(); const offered = createWorkerDeclaration(), response = await kit.worker("/claim", { workerId: "old-worker", protocol: { ...offered, protocolVersions: [1, 2], taskKinds: offered.taskKinds.filter(kind => kind !== "integration"), capabilities: offered.capabilities.filter(cap => cap !== "trusted-integration.v1") } });
  assert.equal(response.status, 200); const unsupported = await response.json() as any; assert.equal(unsupported.run, null); assert.equal(unsupported.compatibility.status, "incompatible"); assert.equal((await kit.snapshot()).goals[0].runCount, 0);
});

apiTest("Camp cancellation fences the live integrator and settles only after its cleanup acknowledgement", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), goal = (await kit.snapshot()).goals[0];
  assert.equal((await kit.post(`/goals/${goal.id}/cancel`)).status, 200);
  const heartbeat = await kit.worker(`/runs/${run.id}/heartbeat`, { workerId: "verification-worker", epoch: run.epoch }); assert.equal(heartbeat.status, 200); assert.equal((await heartbeat.json() as any).cancelRequested, true);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, kit.integrationBody(run))).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { workerId: "verification-worker", epoch: run.epoch, status: "cancelled", summary: "All owned resources cleaned" })).status, 200);
  const state = await kit.snapshot(); assert.equal(state.goals[0].status, "cancelled"); assert.equal(state.operations[0].status, "cancelled"); assert.equal(state.goals[0].integrationInspectionRequired, false); assert.equal(state.goals[0].canRetry, true); assert.equal(state.runs.find(value => value.id === run.id)?.cleanupState, "confirmed"); assert.equal(await kit.claim(), null);
});

apiTest("Camp retries known pre-mutation interruption with the same frozen parents but stops unknown integration outcomes", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), { integration: first } = await kit.preparePair();
  assert.equal((await kit.worker(`/runs/${first.id}/complete`, { workerId: "verification-worker", epoch: first.epoch, status: "failed", summary: "Preparation interrupted, cleaned safely", error: "worker_interrupted" })).status, 200);
  const next = await kit.claim(); assert.ok(next); if (next.executor !== "integration") throw new Error("Expected integration retry");
  assert.equal(next.operationId, first.operationId); assert.equal(next.epoch, first.epoch + 1); assert.equal(next.inputDigest, first.inputDigest); assert.deepEqual(next.integrationInput, first.integrationInput);
  assert.equal((await kit.worker(`/runs/${first.id}/complete`, kit.integrationBody(first))).status, 409);
  assert.equal((await kit.worker(`/runs/${next.id}/complete`, { workerId: "verification-worker", epoch: next.epoch, status: "failed", summary: "Native outcome requires operator inspection", error: "camp_integration_inspection_required" })).status, 200);
  const state = await kit.snapshot(); assert.equal(state.goals[0].reason, "integration_inspection_required"); assert.equal(state.operations[0].status, "failed"); assert.equal(state.goals[0].canRetry, false); assert.equal((await kit.post(`/goals/${state.goals[0].id}/retry`, { expectedAttempt: 1 })).status, 409); assert.equal(await kit.claim(), null);
});

apiTest("Camp exhausted run budget records integration evidence without silently skipping independent verification", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), goal = (await kit.snapshot()).goals[0];
  await db.update(campGoals).set({ budget: { ...goal.budget, maxRuns: goal.runCount } }).where(eq(campGoals.id, goal.id));
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, kit.integrationBody(run))).status, 200);
  const state = await kit.snapshot(); assert.equal(state.goals[0].reason, "run_budget_exhausted"); assert.equal(state.goals[0].integration.status, "merged"); assert.equal(state.goals[0].verification.status, "not_run"); assert.equal(state.goals[0].resultReady, false); assert.equal(state.operations.length, 1); assert.equal(await kit.claim(), null);
});

apiTest("Camp native uncertainty survives cancellation completion and exact replay as an independent retry fence", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), goalId = (await kit.snapshot()).goals[0].id;
  assert.equal((await kit.post(`/goals/${goalId}/cancel`)).status, 200);
  const completion = { workerId: "verification-worker", epoch: run.epoch, status: "cancelled", summary: "Owned resources removed; native Store outcome remains uncertain", error: "camp_integration_inspection_required" };
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, completion)).status, 200);
  let state = await kit.snapshot(); assert.equal(state.goals[0].status, "cancelled"); assert.equal(state.goals[0].reason, "cancelled_by_human"); assert.equal(state.goals[0].integrationInspectionRequired, true); assert.equal(state.goals[0].canRetry, false); assert.equal(state.runs.find(value => value.id === run.id)?.cleanupState, "confirmed");
  assert.equal((await kit.post(`/goals/${goalId}/retry`, { expectedAttempt: 1 })).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, completion)).status, 200);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...completion, error: undefined })).status, 409);
  state = await kit.snapshot(); assert.equal(state.goals[0].integrationInspectionRequired, true);
});

apiTest("Camp cancelled integration lease expiry cannot clear native uncertainty with cleanup acknowledgement", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), goalId = (await kit.snapshot()).goals[0].id;
  await kit.post(`/goals/${goalId}/cancel`);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await reconcileCampPass(); let state = await kit.snapshot(); assert.equal(state.goals[0].status, "cancelled"); assert.equal(state.goals[0].reason, "cancelled_by_human"); assert.equal(state.goals[0].integrationInspectionRequired, true); assert.equal(state.goals[0].canRetry, false);
  assert.equal((await kit.worker(`/runs/${run.id}/cleanup`, { workerId: "verification-worker", epoch: run.epoch })).status, 200);
  state = await kit.snapshot(); assert.equal(state.runs.find(value => value.id === run.id)?.cleanupState, "confirmed"); assert.equal(state.goals[0].integrationInspectionRequired, true); assert.equal((await kit.post(`/goals/${goalId}/retry`, { expectedAttempt: 1 })).status, 409);
});

for (const expiredLease of [false, true]) apiTest(`Camp duration-budget stop preserves native uncertainty after ${expiredLease ? "lease expiry" : "cancelled cleanup completion"}`, async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), { integration: run } = await kit.preparePair(), goalId = (await kit.snapshot()).goals[0].id;
  await db.update(campGoals).set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campGoals.id, goalId));
  if (expiredLease) await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await reconcileCampPass();
  if (!expiredLease) assert.equal((await kit.worker(`/runs/${run.id}/complete`, { workerId: "verification-worker", epoch: run.epoch, status: "cancelled", summary: "Stopped with native uncertainty", error: "camp_integration_inspection_required" })).status, 200);
  const state = await kit.snapshot(); assert.equal(state.goals[0].status, "needs_attention"); assert.equal(state.goals[0].reason, "duration_budget_exhausted"); assert.equal(state.goals[0].integrationInspectionRequired, true); assert.equal(state.goals[0].canRetry, false); assert.equal((await kit.post(`/goals/${goalId}/retry`, { expectedAttempt: 1 })).status, 409);
});
