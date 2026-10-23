import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campDagNodes, campOperations } from "../db/schema";
import type { roomSnapshot } from "../services/camp/rooms";
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
  const submit = async () => { const response = await post("/tasks", { title: "Deliver two independent changes", planMode: "bounded_dag" }); assert.equal(response.status, 201, await response.clone().text()); return await response.json() as Snapshot; };
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
  const integrationBody = (run: CampIntegrationClaimedRun, status = "merged") => {
    const refId = `12${(sequence++).toString(16).padStart(64, "0")}`, candidate = { ...run.inputCandidate, refKind: "commit", refId, commitId: refId, layerId: undefined, rootId: (sequence++).toString(16).padStart(64, "0"), baseRef: run.inputCandidate.refId };
    const integration = { schemaVersion: 1, inputDigest: run.inputDigest, algorithm: run.integrationInput.algorithm, policy: run.integrationInput.policy, status, candidate: status === "merged" ? candidate : null, conflicts: status === "merged" ? [] : [{ path: "shared.txt", reason: "overlap" }], truncated: false };
    const changeSet = { schemaVersion: 1, base: run.goalBaseline, target: candidate, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } };
    return { workerId: ownerOf(run), epoch: run.epoch, status: "completed", summary: `Integration ${status}`, inputCandidate: run.inputCandidate, integration, ...(status === "merged" ? { candidate, changeSet } : {}) };
  };
  return { rawClaim, ownerOf, owner, member, server, user, room, token, worker, configure, post, snapshot, submit, claim, agent, verifier, tool, context, completion, complete, review, integrationBody, report, verifyBody, verify };

}
const item = (key: string, dependsOnKeys: string[]) => ({ key, title: key, description: `Implement ${key}`, acceptance: `${key} is correct`, verification: `Check ${key}`, dependsOnKeys });
const six = [item("a", []), item("b", ["a"]), item("c", ["a"]), item("d", ["b", "c"]), item("e", ["d"]), item("f", ["d"])];
async function planned(kit: Awaited<ReturnType<typeof fixture>>, tasks = six) {
  await kit.submit(); const planner = await kit.agent(); assert.equal(planner.protocolVersion, 5);
  const response = await kit.tool(planner, "plan", { planRevision: 2, summary: "Bounded reviewed graph", tasks }); assert.equal(response.status, 200, await response.clone().text()); await kit.complete(planner); return planner;
}
async function finish(kit: Awaited<ReturnType<typeof fixture>>, run: CampClaimedRun) {
  if (run.executor === "integration") { const body = kit.integrationBody(run); const response = await kit.worker(`/runs/${run.id}/complete`, body); assert.equal(response.status, 200, await response.clone().text()); return body; }
  if (run.executor === "verification") return kit.verify(run);
  if (["review", "final_review"].includes(run.taskKind)) return kit.review(run);
  if (run.taskKind === "summary") assert.equal((await kit.tool(run, "finalize", { summary: "Delivered every approved graph node", remaining: [] })).status, 200);
  return kit.complete(run);
}
async function drain(kit: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < 50; attempt++) { const run = await kit.claim(); if (!run) return; await finish(kit, run); }
  assert.fail("Bounded graph did not terminate");
}
apiTest("six-node DAG preserves approved parents and creates two separately scoped fan-ins using their exact common ancestors", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit);
  const a = await kit.agent(); assert.equal(a.planItemKey, "a"); const bodyA = await kit.complete(a); await kit.review(await kit.agent());
  const [b, c] = await Promise.all([kit.claim(), kit.claim({ workerId: "lane-2" })]) as CampAgentClaimedRun[]; assert.deepEqual([b.planItemKey, c.planItemKey], ["b", "c"]); assert.equal(b.inputCandidate?.refId, bodyA.candidate.refId); assert.equal(c.inputCandidate?.refId, bodyA.candidate.refId);
  await kit.complete(c); await kit.complete(b); await kit.review(await kit.agent()); await kit.review(await kit.agent());
  const first = await kit.claim() as CampIntegrationClaimedRun; assert.equal(first.executor, "integration"); assert.equal(first.integrationInput.algorithm, "layerfs-three-way-v2"); assert.equal(first.integrationInput.base.refId, bodyA.candidate.refId); const firstBody = kit.integrationBody(first); const firstResponse = await kit.worker(`/runs/${first.id}/complete`, firstBody); assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const d = await kit.agent(); assert.equal(d.planItemKey, "d"); assert.equal(d.inputCandidate?.refId, firstBody.candidate!.refId); const bodyD = await kit.complete(d); await kit.review(await kit.agent());
  await drain(kit); const state = await kit.snapshot(); assert.equal(state.goals[0].resultReady, true); assert.equal(state.goals[0].items.every(node => node.status === "approved"), true); assert.deepEqual(state.goals[0].graph?.sinkKeys, ["e", "f"]);
  const integrations = await db.select().from(campOperations); const joins = integrations.filter(operation => operation.kind === "integration"); assert.equal(joins.length, 2); assert.equal(joins[0].scope, "node_input"); assert.equal(joins[0].planItemKey, "d"); assert.equal(joins[1].scope, "goal"); assert.equal(joins[1].integrationInput?.base.refId, bodyD.candidate.refId); assert.equal(state.goals[0].runCount, 18);
  const manifest = await kit.user.get(`/api/camp/rooms/${kit.room.id}/goals/${state.goals[0].id}/result`); assert.equal((await manifest.json()).resultReady, true);
});
apiTest("DAG same-ref passthrough retains both sources and never invents an integration receipt", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit, [item("a", []), item("b", [])]);
  for (let index = 0; index < 2; index++) { const build = await kit.agent(), input = build.inputCandidate!; await kit.complete(build, { candidate: { ...input, baseRef: input.refId }, changeSet: { schemaVersion: 1, base: baseline, target: { ...input, baseRef: input.refId }, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } } }); await kit.review(await kit.agent()); }
  const state = await kit.snapshot(); assert.equal(state.goals[0].graph?.delivery.inputResolution, "same_ref"); assert.equal(state.goals[0].graph?.delivery.inputSources.length, 2); assert.equal((await db.select().from(campOperations)).filter(operation => operation.kind === "integration").length, 0);
  await drain(kit); assert.equal((await kit.snapshot()).goals[0].resultReady, true);
});
apiTest("DAG plan body is immutable and protocol 4 workers cannot allocate graph work", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await kit.submit();
  const old = await kit.rawClaim({ protocol: { ...declaration(), protocolVersions: [4] } }); assert.equal(old.run, null); assert.equal(old.compatibility.code, "protocol_unsupported"); assert.equal((await kit.snapshot()).goals[0].runCount, 0);
  const planner = await kit.agent(), body = { planRevision: 2, summary: "Bounded reviewed graph", tasks: six };
  assert.equal((await kit.tool(planner, "plan", body)).status, 200); assert.equal((await kit.tool(planner, "plan", body)).status, 200); assert.equal((await db.select().from(campDagNodes)).length, 6);
  assert.equal((await kit.tool(planner, "plan", { ...body, tasks: [item("x", [])] })).status, 409);
  assert.equal((await kit.tool(planner, "plan", { planRevision: 1, summary: "Wrong format", tasks: [item("x", [])] })).status, 400);
  await kit.complete(planner); const state = await kit.snapshot(); assert.equal(state.goals[0].items.find(node => node.key === "d")?.scheduling.state, "waiting_dependencies"); assert.deepEqual(state.goals[0].items.find(node => node.key === "d")?.scheduling.blockedByKeys, ["b", "c"]);
});
apiTest("DAG questions and per-node rework preserve sibling approval and only join current reviewed producers", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit, [item("a", []), item("b", []), item("c", ["a", "b"])]);
  const a = await kit.agent(), b = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun, questionId = randomUUID();
  assert.equal((await kit.tool(a, "questions", { questionId, content: "Clarify only this node", toRole: "planner" })).status, 200);
  const suspended = kit.completion(a, { status: "suspended", questionId }); assert.equal((await kit.worker(`/runs/${a.id}/complete`, suspended)).status, 200); await kit.complete(b);
  const clarification = await kit.agent(); assert.equal(clarification.taskKind, "clarification"); assert.equal((await kit.tool(clarification, `questions/${questionId}/answer`, { answer: "Use this node's independent contract" })).status, 200); await kit.complete(clarification);
  const bReview = await kit.agent(); assert.equal(bReview.planItemKey, "b"); assert.equal((await kit.tool(bReview, "events", { type: "artifact", content: "Repair b only", artifact: { type: "review", outcome: "changes_requested", evidence: "b acceptance missing", candidate: (await kit.context(bReview)).reviewTarget } })).status, 201); await kit.complete(bReview, { outcome: "changes_requested" });
  const resumed = await kit.agent(), repair = await kit.claim({ workerId: "lane-2" }) as CampAgentClaimedRun; assert.equal(resumed.taskId, a.taskId); assert.equal(resumed.epoch, 2); assert.equal(resumed.inputCandidate?.refId, suspended.candidate.refId); assert.equal(repair.planItemKey, "b"); assert.equal(repair.inputCandidate?.refId, bReview.inputCandidate?.refId);
  const aResult = await kit.complete(resumed); await kit.review(await kit.agent()); let state = await kit.snapshot(); assert.deepEqual(state.goals[0].items.find(node => node.key === "c")?.scheduling.blockedByKeys, ["b"]); assert.equal(state.operations.length, 0);
  const bResult = await kit.complete(repair); await kit.review(await kit.agent()); const join = await kit.claim() as CampIntegrationClaimedRun; assert.equal(join.integrationInput.parents[0].candidate.refId, aResult.candidate.refId); assert.equal(join.integrationInput.parents[1].candidate.refId, bResult.candidate.refId);
  assert.equal((await kit.post(`/runs/${join.id}/cancel`)).status, 200); state = await kit.snapshot(); assert.equal(state.goals[0].status, "cancelling"); assert.equal(state.goals[0].items.filter(node => node.status === "approved").length, 2); assert.equal(state.goals[0].graph?.delivery.status, "blocked");
});
apiTest("DAG approval cannot bypass an inconsistent durable dependency binding with a passed operator report", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); await planned(kit, [item("a", []), item("b", []), item("c", ["a", "b"])]);
  let verification: CampVerificationClaimedRun | null = null;
  for (let index = 0; index < 20; index++) { const run = await kit.claim(); assert.ok(run); if (run.executor === "verification") { verification = run; break; } await finish(kit, run); }
  assert.ok(verification); const [node] = (await db.select().from(campDagNodes)).filter(row => row.key === "c"); assert.equal(node.inputSources.length, 2);
  await db.update(campDagNodes).set({ inputSources: [] }).where(eq(campDagNodes.id, node.id));
  const body = kit.verifyBody(verification), blocked = await kit.worker(`/runs/${verification.id}/complete`, body); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "integration_required");
  const state = await kit.snapshot(); assert.equal(state.goals[0].resultReady, false); assert.equal(state.tasks.some(task => task.kind === "final_review"), false); assert.equal(state.runs.find(run => run.id === verification!.id)?.status, "running");
  await db.update(campDagNodes).set({ inputSources: node.inputSources }).where(eq(campDagNodes.id, node.id)); assert.equal((await kit.worker(`/runs/${verification.id}/complete`, body)).status, 200); await drain(kit); assert.equal((await kit.snapshot()).goals[0].resultReady, true);
});
