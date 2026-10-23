import { CAMP_CAPABILITIES, CAMP_SUPPORTED_PROTOCOL_VERSIONS, getTaskRequirements } from "../../../camp-protocol/src/index.js";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { getDb } from "../db/index";
import { campGoals, campRuns, campTasks, campWorkers } from "../db/schema";
import type { CampAgentClaimedRun as CampClaimedRun } from "../services/camp/types";

const fullProtocol = {
  protocolVersions: [1], workerVersion: "protocol-test-worker",
  taskKinds: ["plan", "build", "review", "final_review", "summary", "clarification"], refKinds: ["layer", "commit"],
  capabilities: ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1"],
};
type Context = { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } };
type Claim = { run: CampClaimedRun | null; compatibility: { status: string; code: string; protocolVersion: number | null; missingTaskKinds: string[]; missingRefKinds: string[]; missingCapabilities: string[] } | null };
async function fixture({ seed, http, app }: Context, legacy = false, legacyRole = "planner") {
  const owner = await seed.human(), server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] }), user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Protocol negotiation", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text()); const room = await created.json() as { id: string };
  if (!legacy) { const configured = await user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: { id: "compat", revision: 1, name: "Compatibility", maxRepairAttempts: 1, checks: [{ id: "checks", label: "Checks", argv: ["node", "--test"], timeoutMs: 1000 }] } }) }); assert.equal(configured.status, 200); }
  const submitted = await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Compatible workers only", ...(legacy ? { role: legacyRole } : {}) }) });
  assert.equal(submitted.status, 201, await submitted.clone().text()); const { goals } = await submitted.json() as { goals: Array<{ id: string; protocolVersion: number | null }> };
  // Explicitly retain an existing v1 serial goal for rolling-contract compatibility coverage.
  if (!legacy) { await getDb().update(campGoals).set({ protocolVersion: 1, verificationPolicy: null }).where(eq(campGoals.id, goals[0].id)); goals[0].protocolVersion = 1; }
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" }); const { token } = await minted.json() as { token: string };
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const claim = async (protocol?: unknown, extra: Record<string, unknown> = {}) => { const response = await worker("/claim", { workerId: "protocol-worker", ...(protocol === undefined ? {} : { protocol }), ...extra }); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as Claim; };
  return { user, room, goal: goals[0], token, worker, claim };
}

apiTest("Camp requires a declaration for new serial allocation and records compatibility without spending budget or stopping the goal", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }); assert.equal(kit.goal.protocolVersion, 1);
  const absent = await kit.claim(); assert.equal(absent.run, null); assert.equal(absent.compatibility?.code, "protocol_required");
  const future = await kit.claim({ ...fullProtocol, protocolVersions: [99] }); assert.equal(future.run, null); assert.equal(future.compatibility?.code, "protocol_unsupported");
  const missing = await kit.claim({ ...fullProtocol, taskKinds: ["future-kind"], refKinds: ["commit", "future-ref"], capabilities: ["future.capability.v1"] });
  assert.equal(missing.run, null); assert.equal(missing.compatibility?.status, "incompatible"); assert.deepEqual(missing.compatibility?.missingTaskKinds, ["plan"]); assert.deepEqual(missing.compatibility?.missingRefKinds, ["layer"]); assert.ok(missing.compatibility?.missingCapabilities.includes("questions.v1"));
  const [goal] = await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)); assert.equal(goal.runCount, 0); assert.equal(goal.status, "queued"); assert.equal(goal.reason, null); assert.equal(goal.startedAt, null);
  assert.equal((await db.select().from(campRuns)).length, 0);
  const registry = await db.select().from(campWorkers).where(eq(campWorkers.roomId, kit.room.id)); assert.equal(registry.length, 1); assert.equal(registry[0].lastClaimAt, null); assert.equal(registry[0].compatibility?.code, "capability_missing");
  const observed = await kit.user.get(`/api/camp/rooms/${kit.room.id}`); const snapshot = await observed.json() as { workers: Array<{ declaration: unknown; compatibility: unknown }> }; assert.equal(snapshot.workers.length, 1); assert.ok(snapshot.workers[0].declaration); assert.ok(snapshot.workers[0].compatibility);
  const known = await kit.claim({ ...fullProtocol, protocolVersions: [1, 99], capabilities: [...fullProtocol.capabilities, "future.capability.v1"] }); assert.ok(known.run); assert.equal(known.compatibility?.code, "compatible");
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, known.run.id)))[0].workerProtocol?.declaration.workerVersion, fullProtocol.workerVersion);
});

apiTest("Camp rejects malformed declarations and unknown envelope fields while advertising the shared protocol read-only", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const info = await kit.worker("/protocol"); assert.equal(info.status, 200); const metadata = await info.json() as { supportedProtocolVersions: number[]; capabilities: string[] }; assert.deepEqual(metadata.supportedProtocolVersions, [...CAMP_SUPPORTED_PROTOCOL_VERSIONS]); assert.deepEqual([...metadata.capabilities].sort(), [...CAMP_CAPABILITIES].sort());
  for (const protocol of [
    { ...fullProtocol, internal: true }, { ...fullProtocol, protocolVersions: [] },
    { ...fullProtocol, protocolVersions: [0] }, { ...fullProtocol, workerVersion: "x".repeat(101) },
    { ...fullProtocol, capabilities: ["invalid capability with spaces"] },
  ]) { const response = await kit.worker("/claim", { workerId: "bad-worker", protocol }); assert.equal(response.status, 400, await response.clone().text()); }
  assert.equal((await kit.worker("/claim", { workerId: "bad-worker", protocol: fullProtocol, unknown: true })).status, 400);
  assert.equal((await db.select().from(campRuns)).length, 0); assert.equal((await db.select().from(campWorkers)).length, 0);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)))[0].status, "queued");
});

apiTest("Camp old legacy claims and immutable outbox recovery continue without new protocol fields", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, true); assert.equal(kit.goal.protocolVersion, null);
  assert.equal((await kit.claim({ ...fullProtocol, protocolVersions: [99] })).run, null);
  const old = await kit.claim(); assert.ok(old.run); assert.equal(old.compatibility?.code, "legacy_unversioned");
  const run = old.run; const completion = { workerId: "protocol-worker", epoch: run.epoch, status: "completed", summary: "Old durable completion payload remains valid" };
  const finished = await kit.worker(`/runs/${run.id}/complete`, completion); assert.equal(finished.status, 200, await finished.clone().text());
  assert.equal((await kit.worker(`/runs/${run.id}/state`)).status, 200);
  const replay = await kit.worker(`/runs/${run.id}/complete`, completion); assert.equal(replay.status, 200); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0].workerProtocol, null);
});

apiTest("Camp claim-response recovery preserves the original run declaration and never allocates twice", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), claimId = randomUUID();
  const runToken = `camp_run_${createHmac("sha256", kit.token).update(claimId).digest("hex")}`, intent = { claimId, runToken };
  const initial = await kit.claim(fullProtocol, intent); assert.ok(initial.run);
  const recovered = await kit.claim(undefined, intent); assert.equal(recovered.run?.id, initial.run.id); assert.equal(recovered.run?.runToken, runToken); assert.equal(recovered.compatibility?.code, "compatible");
  const changed = await kit.claim({ ...fullProtocol, workerVersion: "different-profile", protocolVersions: [99] }, intent); assert.equal(changed.run?.id, initial.run.id);
  assert.equal((await db.select().from(campRuns)).length, 1);
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, initial.run.id)))[0].workerProtocol?.declaration.workerVersion, fullProtocol.workerVersion);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)))[0].runCount, 1);
  assert.equal((await kit.worker(`/runs/${initial.run.id}/state`)).status, 200);
});

apiTest("Camp negotiates the actual queued task kind and every possible immutable input/output reference before allocation", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const buildOnly = await kit.claim({ ...fullProtocol, taskKinds: ["build"], refKinds: ["commit"] });
  assert.equal(buildOnly.run, null); assert.deepEqual(buildOnly.compatibility?.missingTaskKinds, ["plan"]); assert.deepEqual(buildOnly.compatibility?.missingRefKinds, ["layer"]);
  const planned = await kit.claim({ ...fullProtocol, taskKinds: ["plan"] }); assert.ok(planned.run);
  const run = planned.run;
  const plan = await kit.worker(`/runs/${run.id}/plan`, { workerId: "protocol-worker", runId: run.id, epoch: run.epoch, planRevision: 1, summary: "A bounded item", tasks: [{ key: "inspect", title: "Inspect", description: "Inspect the goal", acceptance: "Meet the goal", verification: "Check the result" }] }, run.runToken); assert.equal(plan.status, 200, await plan.clone().text());
  const candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
  const completion = { workerId: "protocol-worker", epoch: run.epoch, status: "completed", summary: "Prepared plan completion has no new wire fields", inputCandidate: candidate, candidate };
  // Simulate a run/outbox allocated before migration 377: its durable
  // completion must still settle and replay after the upgrade without a new
  // declaration, even though no new serial run may be allocated that way.
  await db.update(campRuns).set({ workerProtocol: null }).where(eq(campRuns.id, run.id));
  const completed = await kit.worker(`/runs/${run.id}/complete`, completion); assert.equal(completed.status, 200, await completed.clone().text());
  const replay = await kit.worker(`/runs/${run.id}/complete`, completion); assert.equal(replay.status, 200); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  const wrongKind = await kit.claim({ ...fullProtocol, taskKinds: ["plan"] }); assert.equal(wrongKind.run, null); assert.deepEqual(wrongKind.compatibility?.missingTaskKinds, ["build"]);
  const missingCommit = await kit.claim({ ...fullProtocol, taskKinds: ["build"], refKinds: ["layer"] }); assert.equal(missingCommit.run, null); assert.deepEqual(missingCommit.compatibility?.missingRefKinds, ["commit"]);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)))[0].runCount, 1);
  const builder = await kit.claim({ ...fullProtocol, taskKinds: ["build"] }); assert.ok(builder.run); assert.equal(builder.run.taskKind, "build"); assert.equal(builder.run.inputCandidate?.refKind, "layer");
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, builder.run.id)))[0].workerProtocol?.version, 1);
});

apiTest("Camp stores the negotiated legacy version explicitly and never assigns an unsupported frozen goal contract", async ({ seed, http, app, db }) => {
  const legacy = await fixture({ seed, http, app }, true), claim = await legacy.claim(fullProtocol); assert.ok(claim.run);
  assert.equal(claim.run.protocolVersion, 1); assert.equal(claim.run.workerProtocol?.version, 1); assert.equal(claim.run.workerProtocol?.requirements.workflow, "legacy"); assert.deepEqual(claim.run.workerProtocol?.requirements, getTaskRequirements(claim.run));
  const context = await legacy.worker(`/runs/${claim.run.id}/context`, undefined, claim.run.runToken); assert.equal(context.status, 200);
  const metadata = await context.json() as { protocolVersion: number; workerProtocol: { version: number }; run: { protocolVersion: number; workerProtocol: { version: number } } }; assert.equal(metadata.protocolVersion, 1); assert.equal(metadata.run.workerProtocol.version, 1);
  const unknown = await fixture({ seed, http, app }); await db.update(campGoals).set({ protocolVersion: 99 }).where(eq(campGoals.id, unknown.goal.id));
  const rejected = await unknown.claim({ ...fullProtocol, protocolVersions: [1, 99] }); assert.equal(rejected.run, null); assert.equal(rejected.compatibility?.code, "protocol_unsupported");
  const [goal] = await db.select().from(campGoals).where(eq(campGoals.id, unknown.goal.id)); assert.equal(goal.status, "queued"); assert.equal(goal.runCount, 0); assert.equal(goal.reason, null);
  await db.update(campGoals).set({ protocolVersion: null }).where(eq(campGoals.id, unknown.goal.id));
  const unfrozen = await unknown.claim(fullProtocol); assert.equal(unfrozen.run, null); assert.equal(unfrozen.compatibility?.code, "protocol_unsupported"); assert.equal(unfrozen.compatibility?.protocolVersion, null);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, unknown.goal.id)))[0].status, "queued");
});

apiTest("Camp modern legacy claims freeze the same selected dependency candidate and requirements returned to the worker", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }, true, "builder");
  const builder = await kit.claim({ ...fullProtocol, taskKinds: ["build"] }); assert.ok(builder.run); assert.deepEqual(builder.run.workerProtocol?.requirements, getTaskRequirements(builder.run));
  const inputCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
  const candidate = { ...inputCandidate, refKind: "commit", refId: `12${"d".repeat(64)}`, commitId: `12${"d".repeat(64)}`, layerId: undefined, rootId: "e".repeat(64), baseRef: inputCandidate.refId };
  const finished = await kit.worker(`/runs/${builder.run.id}/complete`, { workerId: "protocol-worker", epoch: builder.run.epoch, status: "completed", summary: "The legacy builder produced a trusted candidate", inputCandidate, candidate }); assert.equal(finished.status, 200, await finished.clone().text());
  const submitted = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Review that legacy builder candidate", role: "reviewer", dependsOn: [builder.run.taskId] }) }); assert.equal(submitted.status, 201, await submitted.clone().text());
  const reviewed = await kit.claim({ ...fullProtocol, protocolVersions: [1, 2, 3, 4], taskKinds: ["review"], refKinds: ["commit"] }); assert.ok(reviewed.run); assert.equal(reviewed.run.inputCandidate?.refId, candidate.refId); assert.equal(reviewed.run.protocolVersion, 2); assert.deepEqual(reviewed.run.workerProtocol?.requirements, getTaskRequirements(reviewed.run)); assert.deepEqual(reviewed.run.workerProtocol?.requirements.refKinds, ["commit"]);
  const context = await kit.worker(`/runs/${reviewed.run.id}/context`, undefined, reviewed.run.runToken); assert.equal(context.status, 200); const body = await context.json() as { inputCandidate: { refId: string }; workerProtocol: unknown }; assert.equal(body.inputCandidate.refId, candidate.refId); assert.deepEqual(body.workerProtocol, reviewed.run.workerProtocol);
});

apiTest("Camp refuses ambiguous dependency parents before allocating or spending a run", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, true, "builder");
  const taskIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    if (index) { const response = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Second parent", role: "builder" }) }); assert.equal(response.status, 201); }
    const { run } = await kit.claim(fullProtocol); assert.ok(run); taskIds.push(run.taskId);
    const hex = (index + 1).toString(16).repeat(64), candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "commit", refId: `12${hex}`, commitId: `12${hex}`, rootId: hex, imageId: `sha256:${"f".repeat(64)}` };
    const response = await kit.worker(`/runs/${run.id}/complete`, { workerId: "protocol-worker", epoch: run.epoch, status: "completed", summary: "One independent parent", inputCandidate: candidate, candidate }); assert.equal(response.status, 200, await response.clone().text());
  }
  const submitted = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Cannot implicitly merge", role: "reviewer", dependsOn: taskIds }) }); assert.equal(submitted.status, 201);
  const response = await kit.worker("/claim", { workerId: "protocol-worker", protocol: fullProtocol }); assert.equal(response.status, 409, await response.clone().text()); assert.equal((await response.json() as { code: string }).code, "ambiguous_input_candidate");
  assert.equal((await db.select().from(campRuns)).length, 2);
  const goals = await db.select().from(campGoals); assert.equal(goals.find(goal => goal.title === "Cannot implicitly merge")!.runCount, 0);
});

apiTest("Camp legacy review target follows the explicit authoritative input even when a dependency names another candidate", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, true, "builder");
  const { run: builder } = await kit.claim(fullProtocol); assert.ok(builder);
  const parent = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "commit", refId: `12${"d".repeat(64)}`, commitId: `12${"d".repeat(64)}`, rootId: "e".repeat(64), imageId: `sha256:${"f".repeat(64)}` } as const;
  assert.equal((await kit.worker(`/runs/${builder.id}/complete`, { workerId: "protocol-worker", epoch: builder.epoch, status: "completed", summary: "Dependency", inputCandidate: parent, candidate: parent })).status, 200);
  const submitted = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Explicit input", role: "reviewer", dependsOn: [builder.taskId] }) }); assert.equal(submitted.status, 201);
  const [binding] = await db.select().from(campTasks).where(eq(campTasks.role, "reviewer"));
  const explicit = { ...parent, refId: `12${"1".repeat(64)}`, commitId: `12${"1".repeat(64)}`, rootId: "2".repeat(64) } as const;
  await db.update(campTasks).set({ inputCandidate: explicit }).where(eq(campTasks.taskId, binding.taskId));
  const { run } = await kit.claim(fullProtocol); assert.ok(run); assert.equal(run.inputCandidate?.refId, explicit.refId);
  const context = await kit.worker(`/runs/${run.id}/context`, undefined, run.runToken); assert.equal(context.status, 200);
  assert.equal((await context.json() as { reviewTarget: { refId: string } }).reviewTarget.refId, explicit.refId);
});


apiTest("Camp modern legacy negotiation selects v2 and a v4-only declaration cannot allocate legacy work", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, true);
  const unsupported = await kit.claim({ ...fullProtocol, protocolVersions: [4] }); assert.equal(unsupported.run, null); assert.equal(unsupported.compatibility?.code, "protocol_unsupported");
  const [before] = await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)); assert.equal(before.runCount, 0); assert.equal(before.protocolVersion, null);
  const allocated = await kit.claim({ ...fullProtocol, protocolVersions: [1, 2, 3, 4] }); assert.ok(allocated.run); assert.equal(allocated.run.protocolVersion, 2); assert.equal(allocated.run.workerProtocol?.version, 2); assert.deepEqual(allocated.run.workerProtocol?.requirements, getTaskRequirements(allocated.run));
});
apiTest("Camp legacy v2 builders without a diff capability can complete their original non-delivery contract", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }, true, "builder");
  const claim = await kit.claim({ ...fullProtocol, protocolVersions: [1, 2, 3, 4] }); assert.ok(claim.run); assert.equal(claim.run.protocolVersion, 2); assert.equal(claim.run.workerProtocol?.requirements.capabilities.includes("candidate-diff.v1"), false);
  const candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
  const body = { workerId: "protocol-worker", epoch: claim.run.epoch, status: "completed", summary: "Legacy task completed without a serial delivery diff", inputCandidate: candidate, candidate };
  const completed = await kit.worker(`/runs/${claim.run.id}/complete`, body); assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await kit.worker(`/runs/${claim.run.id}/complete`, body)).status, 200, "The unchanged completion remains replayable");
  const [goal] = await db.select().from(campGoals).where(eq(campGoals.id, kit.goal.id)); assert.equal(goal.status, "completed"); assert.equal(goal.protocolVersion, null); assert.equal(goal.runCount, 1);
});
