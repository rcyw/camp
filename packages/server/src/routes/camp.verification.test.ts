import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campOperations, campRuns, serverMembers } from "../db/schema";
import type { roomSnapshot } from "../services/camp/rooms";
import { reconcileCampPass } from "../services/camp/reconcile";
import type { CampAgentClaimedRun, CampCandidate, CampClaimedRun, CampVerificationClaimedRun } from "../services/camp/types";

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
  const submit = async () => { const response = await post("/tasks", { title: "Deliver independently verified result" }); assert.equal(response.status, 201, await response.clone().text()); return await response.json() as Snapshot; };
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
  const prepare = async (beforeBuild?: (run: CampAgentClaimedRun) => Promise<void>) => { await submit(); const planner = await agent(); const response = await tool(planner, "plan", { planRevision: 1, summary: "One bounded item", tasks: [{ key: "result", title: "Result", description: "Implement result", acceptance: "Result works", verification: "Run checks" }] }); assert.equal(response.status, 200, await response.clone().text()); await complete(planner); const builder = await agent(); await beforeBuild?.(builder); const buildBody = await complete(builder); await review(await agent()); return { planner, builder, buildBody }; };
  const report = (run: CampVerificationClaimedRun, exitCode = 0) => ({ candidate: run.inputCandidate, policyDigest: run.verificationPolicy.digest, checks: run.verificationPolicy.policy.checks.map(check => ({ id: check.id, argv: check.argv, exitCode, signal: null, timedOut: false, oomKilled: false, durationMs: 10, stdout: "Observed checks", stderr: exitCode ? "Requirement missing" : "", outputTruncated: false })) });
  const verifyBody = (run: CampVerificationClaimedRun, exitCode = 0) => ({ workerId: "verification-worker", epoch: run.epoch, status: "completed", summary: "Independent operator checks finished", inputCandidate: run.inputCandidate, verification: report(run, exitCode) });
  const verify = async (run: CampVerificationClaimedRun, exitCode = 0) => { const body = verifyBody(run, exitCode), response = await worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; };
  return { owner, member, server, user, room, token, worker, configure, post, snapshot, submit, claim, agent, verifier, tool, context, completion, complete, review, prepare, report, verifyBody, verify };
}

apiTest("Camp v2 requires an operator policy and freezes it independently from later Room configuration", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }, false);
  assert.equal((await kit.post("/tasks", { title: "No policy" })).status, 409);
  const denied = await http.as(kit.member, kit.server).request(`/api/camp/rooms/${kit.room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy }) }); assert.equal(denied.status, 403);
  assert.equal((await kit.configure()).status, 200); const created = await kit.submit(); assert.equal(created.goals[0].protocolVersion, 2); const digest = created.goals[0].verificationPolicy?.digest;
  assert.equal((await kit.configure({ ...policy, revision: 2 })).status, 200); const snapshot = await kit.snapshot(); assert.equal(snapshot.room.verificationPolicy?.policy.revision, 2); assert.equal(snapshot.goals[0].verificationPolicy?.policy.revision, 1); assert.equal(snapshot.goals[0].verificationPolicy?.digest, digest);
});

apiTest("Camp policy compare-and-swap prevents stale admin drafts and preserves a goal's frozen policy", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, false);
  await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, kit.server.id), eq(serverMembers.userId, kit.member.id)));
  const save = (admin: typeof kit.owner, value: unknown, expectedDigest: string | null) => http.as(admin, kit.server).request(`/api/camp/rooms/${kit.room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: value, expectedDigest }) });
  assert.equal((await save(kit.owner, policy, null)).status, 200);
  const before = await kit.snapshot(), digest = before.room.verificationPolicy!.digest;
  assert.equal((await save(kit.member, { ...policy, revision: 2 }, null)).status, 409, "Explicit null only matches an unconfigured Room");
  const created = await kit.submit(), goalId = created.goals[0].id;
  const raced = await Promise.all([save(kit.owner, { ...policy, revision: 2, name: "Owner draft" }, digest), save(kit.member, { ...policy, revision: 3, name: "Admin draft" }, digest)]);
  assert.deepEqual(raced.map(response => response.status).sort(), [200, 409]);
  const conflict = raced.find(response => response.status === 409)!; assert.equal((await conflict.json() as { code: string }).code, "verification_policy_changed");
  const after = await kit.snapshot();
  assert.notEqual(after.room.verificationPolicy!.digest, digest);
  assert.equal(after.goals.find(goal => goal.id === goalId)!.verificationPolicy!.digest, digest);
  assert.equal((await save(kit.owner, null, after.room.verificationPolicy!.digest)).status, 200);
  assert.equal((await save(kit.member, policy, after.room.verificationPolicy!.digest)).status, 409);
});

apiTest("Camp trusted verification failure repairs once, rechecks the candidate, and gates final acceptance with durable receipts and diff", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), prepared = await kit.prepare();
  const first = await kit.verifier(), failed = await kit.verify(first, 1); let snapshot = await kit.snapshot(); assert.equal(snapshot.goals[0].verificationRepairs, 1); assert.equal(snapshot.operations[0].receipt?.status, "failed");
  assert.equal((await kit.worker(`/runs/${first.id}/complete`, failed)).status, 200); assert.equal((await kit.snapshot()).goals[0].verificationRepairs, 1);
  const repair = await kit.agent(); assert.equal(repair.taskKind, "build"); assert.equal(repair.planItemKey, null); await kit.complete(repair);
  const second = await kit.verifier(), passed = await kit.verify(second); snapshot = await kit.snapshot(); const verifiedAt = snapshot.operations[1].receipt?.verifiedAt;
  assert.equal((await kit.worker(`/runs/${second.id}/complete`, passed)).status, 200); assert.equal((await kit.snapshot()).operations[1].receipt?.verifiedAt, verifiedAt);
  assert.equal((await kit.configure({ ...policy, revision: 2, name: "Checks for future goals" })).status, 200);
  const final = await kit.agent(); assert.equal(final.taskKind, "final_review"); assert.equal((await kit.context(final)).verificationReceipt.status, "passed"); await kit.review(final);
  const summary = await kit.agent(); assert.equal(summary.taskKind, "summary"); assert.equal((await kit.tool(summary, "finalize", { summary: "Delivered result", evidence: "Independent checks passed", remaining: [] })).status, 200); await kit.complete(summary);
  snapshot = await kit.snapshot(); const goal = snapshot.goals[0]; assert.equal(goal.status, "completed"); assert.equal(goal.resultReady, true); assert.equal(goal.runCount, 8); assert.equal(goal.reviewRounds, 2); assert.equal(snapshot.room.acceptedHead.goalId, goal.id);
  const base = `/api/camp/rooms/${kit.room.id}/goals/${goal.id}`;
  const versions = await (await kit.user.get(`${base}/versions`)).json() as { versions: unknown[] }; assert.equal(versions.versions.length, 3);
  const changes = await (await kit.user.get(`${base}/versions/${prepared.builder.id}/changes`)).json() as { available: boolean; changeSet: { target: CampCandidate } }; assert.equal(changes.available, true); assert.equal(changes.changeSet.target.refId, prepared.buildBody.candidate.refId);
  const receipt = await (await kit.user.get(`${base}/versions/${repair.id}/verification`)).json() as { status: string; receipt: { checks: { stdout: string }[] } }; assert.equal(receipt.status, "passed"); assert.equal(receipt.receipt.checks[0].stdout, "Observed checks");
  const manifest = await (await kit.user.get(`${base}/result`)).json() as { resultReady: boolean; candidate: CampCandidate; verification: { policy: { digest: string; policy: { revision: number } }; receipt: { candidate: CampCandidate; policyDigest: string; checks: { stdout: string }[] } } };
  assert.equal(manifest.resultReady, true); assert.equal(manifest.verification.policy.policy.revision, 1); assert.equal(manifest.verification.receipt.candidate.refId, manifest.candidate.refId); assert.equal(manifest.verification.receipt.policyDigest, manifest.verification.policy.digest); assert.equal(manifest.verification.receipt.checks[0].stdout, "Observed checks");
});

apiTest("Camp verification is roleless, host-only, strictly policy-bound, lease-fenced and cancellable", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.prepare(); const claimId = randomUUID(), runToken = `camp_run_${createHmac("sha256", kit.token).update(claimId).digest("hex")}`;
  const run = await kit.claim({ claimId, runToken }); assert.ok(run); assert.equal(run.executor, "verification"); const verification = run as CampVerificationClaimedRun;
  assert.equal(run.taskId, null); assert.equal(run.role, null); assert.equal("runToken" in run, false); assert.equal("prompt" in run, false);
  assert.equal((await kit.claim({ claimId, runToken }))?.id, run.id); assert.equal((await kit.worker(`/runs/${run.id}/context`, undefined, runToken)).status, 401);
  assert.equal((await kit.worker(`/runs/${run.id}/events`, { workerId: "verification-worker", epoch: run.epoch, type: "progress", content: "Spoofed checks" })).status, 403);
  const body = kit.verifyBody(verification);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, verification: { ...body.verification, policyDigest: "f".repeat(64) } })).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, verification: { ...body.verification, status: "passed" } })).status, 400);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, verification: { ...body.verification, checks: [{ ...body.verification.checks[0], argv: ["true"] }] } })).status, 409);
  await db.update(campRuns).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(campRuns.id, run.id)); await reconcileCampPass();
  const replacement = await kit.verifier(); assert.equal(replacement.operationId, verification.operationId); assert.equal(replacement.epoch, run.epoch + 1); assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 409);
  const goal = (await kit.snapshot()).goals[0]; assert.equal((await kit.post(`/goals/${goal.id}/cancel`)).status, 200);
  const heartbeat = await (await kit.worker(`/runs/${replacement.id}/heartbeat`, { workerId: "verification-worker", epoch: replacement.epoch })).json() as { cancelRequested: boolean }; assert.equal(heartbeat.cancelRequested, true);
  assert.equal((await kit.worker(`/runs/${replacement.id}/complete`, { workerId: "verification-worker", epoch: replacement.epoch, status: "cancelled", summary: "Verification stopped and cleaned" })).status, 200); assert.equal((await kit.snapshot()).goals[0].status, "cancelled");
});

apiTest("Camp v2 binds the immutable cumulative diff and excludes model supplied verification evidence", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const { builder, buildBody } = await kit.prepare(async run => {
    const body = kit.completion(run); assert.ok(body.changeSet);
    assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, changeSet: undefined })).status, 409);
    assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, changeSet: { ...body.changeSet, base: body.candidate } })).status, 409);
    assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, changeSet: { ...body.changeSet, target: baseline } })).status, 409);
    assert.equal((await kit.tool(run, "events", { type: "artifact", content: "Model says checks passed", artifact: { type: "verification", status: "passed" } })).status, 403);
    const raw = { candidate: body.candidate, policyDigest: "f".repeat(64), checks: [{ id: "acceptance", argv: policy.checks[0].argv, exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 1, stdout: "PASS", stderr: "", outputTruncated: false }] };
    assert.equal((await kit.worker(`/runs/${run.id}/complete`, { ...body, verification: raw })).status, 403);
  });
  assert.equal((await kit.worker(`/runs/${builder.id}/complete`, buildBody)).status, 200);
  assert.equal((await kit.worker(`/runs/${builder.id}/complete`, { ...buildBody, changeSet: { ...buildBody.changeSet, truncated: true } })).status, 409);
  const snapshot = await kit.snapshot(); assert.equal(snapshot.operations.length, 1); assert.equal(snapshot.operations[0].receipt, null);
});

apiTest("Camp independent verification exhausts its configured repair allowance without appending more work", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); assert.equal((await kit.configure({ ...policy, maxRepairAttempts: 0 })).status, 200); await kit.prepare();
  const run = await kit.verifier(), body = await kit.verify(run, 1); const first = await kit.snapshot();
  assert.equal(first.goals[0].status, "needs_attention"); assert.equal(first.goals[0].reason, "verification_failed"); assert.equal(first.goals[0].verificationRepairs, 0); assert.equal(first.goals[0].resultReady, false); assert.equal(first.tasks.length, 3);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, body)).status, 200); assert.equal(await kit.claim(), null); const replayed = await kit.snapshot(); assert.equal(replayed.operations.length, 1); assert.equal(replayed.tasks.length, 3); assert.equal(replayed.goals[0].runCount, 4);
});

apiTest("Camp final review and accepted-head CAS reject a newer failed receipt for the same candidate", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.prepare(); const verifier = await kit.verifier(); await kit.verify(verifier);
  const final = await kit.agent(), context = await kit.context(final);
  assert.equal((await kit.tool(final, "events", { type: "artifact", content: "Approved exact candidate", artifact: { type: "review", outcome: "approved", evidence: "Independent checks inspected", candidate: context.reviewTarget } })).status, 201);
  const [original] = await db.select().from(campOperations).where(eq(campOperations.id, verifier.operationId)); assert.ok(original.receipt);
  const newerId = randomUUID();
  const failedReceipt = { ...original.receipt, operationId: newerId, status: "failed" as const, checks: original.receipt.checks.map(check => ({ ...check, exitCode: 1 })) };
  await db.insert(campOperations).values({ id: newerId, roomId: kit.room.id, goalId: final.goalId, goalAttempt: final.goalAttempt, inputCandidate: original.inputCandidate, verificationPolicy: original.verificationPolicy, status: "failed", receipt: failedReceipt, createdAt: new Date(Date.now() + 1000) });
  assert.equal((await kit.worker(`/runs/${final.id}/complete`, kit.completion(final, { outcome: "approved" }))).status, 409);
  await db.update(campOperations).set({ status: "completed", receipt: { ...failedReceipt, status: "passed", checks: original.receipt.checks } }).where(eq(campOperations.id, newerId));
  await kit.complete(final, { outcome: "approved" }); const summary = await kit.agent(); assert.equal((await kit.tool(summary, "finalize", { summary: "Ready", remaining: [] })).status, 200);
  await db.update(campOperations).set({ status: "failed", receipt: failedReceipt }).where(eq(campOperations.id, newerId));
  assert.equal((await kit.worker(`/runs/${summary.id}/complete`, kit.completion(summary))).status, 409); const snapshot = await kit.snapshot(); assert.equal(snapshot.room.acceptedHead.revision, 0); assert.equal(snapshot.goals[0].resultReady, false);
});

apiTest("Camp verifies harness capabilities before allocation and accepts a verifier without any DSH role capability", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), harness = { id: "operator-tests", sha256: "d".repeat(64) };
  assert.equal((await kit.configure({ ...policy, checks: [{ ...policy.checks[0], argv: ["node", "/camp-checks/operator-tests"], harness }] })).status, 200);
  await kit.prepare();
  const declaration = { protocolVersions: [2], workerVersion: "trusted-only", taskKinds: ["verification"], refKinds: ["commit"], capabilities: ["layerfs.candidate.v1", "candidate-diff.v1", "trusted-verification.v1"] };
  const missing = await kit.worker("/claim", { workerId: "verification-worker", protocol: declaration }); assert.equal(missing.status, 200);
  const rejected = await missing.json() as { run: null; compatibility: { code: string; missingHarnesses: string[] } }; assert.equal(rejected.run, null); assert.equal(rejected.compatibility.code, "capability_missing"); assert.deepEqual(rejected.compatibility.missingHarnesses, [harness.id]);
  assert.equal((await kit.snapshot()).goals[0].runCount, 3); assert.equal((await db.select().from(campRuns)).length, 3);
  const run = await kit.claim({ protocol: { ...declaration, harnesses: [harness] } }); assert.ok(run); assert.equal(run.executor, "verification"); assert.equal(run.workerProtocol?.version, 2); assert.deepEqual(run.workerProtocol?.requirements.capabilities, declaration.capabilities);
});

apiTest("Camp snapshots distinguish pending verification from verification never run on a cancelled goal", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), created = await kit.submit(), goalId = created.goals[0].id;
  assert.equal(created.goals[0].verification.status, "pending"); assert.equal(created.goals[0].verification.operations.length, 0);
  const cancelled = await kit.post(`/goals/${goalId}/cancel`); assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const snapshot = await kit.snapshot(); assert.equal(snapshot.goals[0].status, "cancelled"); assert.equal(snapshot.goals[0].verification.status, "not_run"); assert.equal(snapshot.goals[0].verification.required, true); assert.equal(snapshot.goals[0].verification.operations.length, 0); assert.equal(snapshot.goals[0].resultReady, false);
});
