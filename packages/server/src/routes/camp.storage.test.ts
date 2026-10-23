import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import { campEvents, campGoals, campRooms, campRuns, campStorageOperations, campWorkers } from "../db/schema";
import { roomProjectId } from "../services/camp/storage";
import { reconcileCampPass } from "../services/camp/reconcile";
import type { CampStorageOperation, CampStorageSnapshot } from "../services/camp/storageTypes";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import type { getDb } from "../db/index";

const pool = { poolId: "11111111-1111-4111-8111-111111111111", storageId: "1".repeat(64), maxParallel: 2 as const, workerIds: ["lane-1", "lane-2"], resources: { maxContainers: 4 as const, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };
async function fixture({ seed, http, app, db }: { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string }; db: ReturnType<typeof getDb> }) {
  const owner = await seed.human(), member = await seed.human(), server = await seed.server({ owner, members: [member] }), channel = await seed.channel({ server, members: [owner, member] }), user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Storage fixture", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text()); const room = await created.json() as { id: string };
  const refId = `12${"a".repeat(64)}`, candidate = { type: "layerfs" as const, projectId: roomProjectId(room.id), refKind: "commit" as const, refId, commitId: refId, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
  await db.update(campRooms).set({ storageId: pool.storageId, acceptedCandidate: candidate, acceptedRevision: 1 }).where(eq(campRooms.id, room.id));
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" }), { token } = await minted.json() as { token: string };
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (path: string, body: unknown = {}) => user.request(`/api/camp/rooms/${room.id}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const begin = async (kind = "backup", extra: Record<string, unknown> = {}) => { const body = { requestId: randomUUID(), kind, expectedEpoch: 1, expectedAcceptedRevision: 1, ...extra }, response = await post("/storage-operations", body); assert.equal(response.status, 201, await response.clone().text()); return { body, ...await response.json() as { operation: CampStorageOperation; storage: CampStorageSnapshot } }; };
  const status = async () => { const response = await user.get(`/api/camp/rooms/${room.id}/storage`); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as CampStorageSnapshot; };
  const backup = (operation: CampStorageOperation) => ({ schemaVersion: 1, operationId: operation.id, manifestDigest: "d".repeat(64), storeSha256: "e".repeat(64), bytes: 4096, toolchainDigest: "f".repeat(64), imageId: candidate.imageId, candidateCount: operation.candidateCount, sourceStorageId: pool.storageId, stopped: true, verified: true });
  return { owner, member, server, room, user, candidate, worker, post, begin, status, backup };
}
apiTest("storage maintenance freezes new execution and config while preserving bounded immutable backup receipts", async ({ seed, http, app, db }) => {
  const context = { seed, http, app, db };
  const kit = await fixture(context), request = await kit.begin(); assert.equal(request.storage.maintenance, true); assert.equal(request.operation.plan.projectId, roomProjectId(kit.room.id));
  assert.equal((await kit.post("/storage-operations", request.body)).status, 201);
  assert.equal((await kit.post("/storage-operations", { ...request.body, kind: "migration" })).status, 409);
  assert.equal((await kit.post("/tasks", { title: "Blocked", role: "planner" })).status, 409);
  const configure = await kit.user.request(`/api/camp/rooms/${kit.room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: null }) }); assert.equal(configure.status, 409);
  const idle = await kit.worker("/claim", { workerId: "lane-1", protocol: createWorkerDeclaration() }); assert.equal(idle.status, 200); assert.equal((await idle.json()).admission.reason, "storage_maintenance"); assert.equal((await context.db.select().from(campWorkers)).length, 0);
  const unbound = await kit.worker("/claim", { workerId: "lane-1", restoreOnly: true, claimId: randomUUID(), runToken: `camp_run_${"0".repeat(64)}` }); assert.equal((await unbound.json()).unbound, true);
  const read = await kit.worker(`/storage-operations/${request.operation.id}`); assert.equal(read.status, 200); assert.equal((await read.json()).plan.operationId, request.operation.id);
  const receipt = kit.backup(request.operation), finish = await kit.worker(`/storage-operations/${request.operation.id}/backup`, receipt); assert.equal(finish.status, 200, await finish.clone().text()); assert.equal((await finish.json()).operation.phase, "completed");
  assert.equal((await kit.worker(`/storage-operations/${request.operation.id}/backup`, receipt)).status, 200); assert.equal((await kit.worker(`/storage-operations/${request.operation.id}/backup`, { ...receipt, bytes: 8192 })).status, 409);
  const storage = await kit.status(); assert.equal(storage.maintenance, false); assert.equal(storage.operations[0].canRestoreFromBackup, true);
});
apiTest("migration reuses an original immutable backup and CAS activates only the verified current inventory", async ({ seed, http, app, db }) => {
  const context = { seed, http, app, db };
  const kit = await fixture(context), origin = await kit.begin(), receipt = kit.backup(origin.operation); assert.equal((await kit.worker(`/storage-operations/${origin.operation.id}/backup`, receipt)).status, 200);
  const migration = await kit.begin("migration", { backupOperationId: origin.operation.id }); assert.equal(migration.operation.phase, "backup_ready"); assert.deepEqual(migration.operation.backupReceipt, receipt); assert.equal(migration.storage.operations.find(value => value.id === origin.operation.id)?.canRestoreFromBackup, false); assert.notEqual(migration.operation.planDigest, origin.operation.planDigest);
  const restored = { ...receipt, operationId: migration.operation.id, targetStorageId: "2".repeat(64), verifiedCandidates: receipt.candidateCount, historyVerified: true };
  assert.equal((await kit.worker(`/storage-operations/${migration.operation.id}/restore`, { ...restored, manifestDigest: "0".repeat(64) })).status, 409);
  assert.equal((await kit.worker(`/storage-operations/${migration.operation.id}/restore`, restored)).status, 200);
  const activation = { expectedEpoch: 1, expectedTargetStorageId: restored.targetStorageId };
  assert.equal((await kit.post(`/storage-operations/${migration.operation.id}/activate`, { ...activation, expectedEpoch: 2 })).status, 409);
  for (let replay = 0; replay < 2; replay++) { const result = await kit.post(`/storage-operations/${migration.operation.id}/activate`, activation); assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json()).storage.epoch, 2); }
  const [room] = await context.db.select().from(campRooms).where(eq(campRooms.id, kit.room.id)); assert.equal(room.acceptedRevision, 1); assert.deepEqual(room.acceptedCandidate, kit.candidate);
  assert.equal((await kit.worker(`/storage-operations/${origin.operation.id}/backup`, receipt)).status, 200); assert.equal((await kit.worker(`/storage-operations/${migration.operation.id}/restore`, restored)).status, 200);
  assert.equal((await kit.post("/tasks", { title: "New placement", role: "planner" })).status, 201);
  for (const protocol of [undefined, createWorkerDeclaration(), { ...createWorkerDeclaration(), executionPool: pool }]) { const response = await kit.worker("/claim", { workerId: "lane-1", ...(protocol ? { protocol } : {}) }); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.run, null); assert.ok(["pool_required", "storage_mismatch"].includes(body.compatibility.code)); }
  const response = await kit.worker("/claim", { workerId: "lane-1", protocol: { ...createWorkerDeclaration(), executionPool: { ...pool, storageId: restored.targetStorageId } } }); assert.equal(response.status, 200, await response.clone().text()); assert.ok((await response.json()).run);
});
apiTest("cold storage gate rejects active and unknown cleanup facts across legacy protocols without deleting history", async ({ seed, http, app, db }) => {
  const context = { seed, http, app, db };
  const kit = await fixture(context); assert.equal((await kit.post("/tasks", { title: "Legacy execution", role: "planner" })).status, 201);
  assert.equal((await kit.post("/storage-operations", { requestId: randomUUID(), kind: "backup", expectedEpoch: 1, expectedAcceptedRevision: 1 })).status, 409);
  const claim = await kit.worker("/claim", { workerId: "lane-1", protocol: { ...createWorkerDeclaration(), executionPool: pool } }), run = (await claim.json()).run; assert.ok(run);
  assert.equal((await kit.post(`/goals/${run.goalId}/cancel`)).status, 200);
  await context.db.update(campRuns).set({ status: "cancelled", completedAt: new Date(), summary: null, workerProtocol: null }).where(eq(campRuns.id, run.id)); await context.db.update(campGoals).set({ status: "cancelled" }).where(eq(campGoals.id, run.goalId));
  assert.ok((await kit.status()).blockers.includes("cleanup_unknown"));
  const denied = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "backup", expectedEpoch: 1, expectedAcceptedRevision: 1 }); assert.equal(denied.status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/cleanup`, { workerId: "lane-1", epoch: run.epoch })).status, 200);
  assert.equal((await kit.begin()).operation.phase, "prepared"); assert.equal((await context.db.select().from(campRuns)).length, 1);
});
apiTest("storage receipt authority is Room scoped and a model run token cannot attest native backup", async ({ seed, http, app, db }) => {
  const context = { seed, http, app, db };
  const kit = await fixture(context), member = context.http.as(kit.member, kit.server);
  const denied = await member.request(`/api/camp/rooms/${kit.room.id}/storage-operations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), kind: "backup", expectedEpoch: 1, expectedAcceptedRevision: 1 }) }); assert.equal(denied.status, 403);
  assert.equal((await kit.post("/tasks", { title: "Run token", role: "planner" })).status, 201);
  const claimed = await kit.worker("/claim", { workerId: "lane-1", protocol: { ...createWorkerDeclaration(), executionPool: pool } }), run = (await claimed.json()).run; assert.ok(run);
  assert.equal((await kit.worker(`/storage-operations/${randomUUID()}`, undefined, run.runToken)).status, 403);
  const response = await kit.worker(`/runs/${run.id}/complete`, { workerId: "lane-1", epoch: run.epoch, status: "failed", summary: "Cleanly stopped", error: "model_error" }); assert.equal(response.status, 200);
  const operation = await kit.begin(); assert.equal((await kit.worker(`/storage-operations/${operation.operation.id}`, undefined, run.runToken)).status, 401); assert.equal((await kit.worker(`/storage-operations/${operation.operation.id}/backup`, kit.backup(operation.operation), run.runToken)).status, 401);
  const other = await fixture(context); assert.equal((await other.worker(`/storage-operations/${operation.operation.id}`)).status, 404);
  const outsider = await context.seed.human(); assert.equal((await context.http.as(outsider, kit.server).get(`/api/camp/rooms/${kit.room.id}/storage`)).status, 403);
});
apiTest("stale backup inventory is rejected and storage projections explicitly bound history and candidate previews", async ({ seed, http, app, db }) => {
  const context = { seed, http, app, db };
  const kit = await fixture(context), origin = await kit.begin(); await kit.worker(`/storage-operations/${origin.operation.id}/backup`, kit.backup(origin.operation));
  const extra = { ...kit.candidate, refId: `12${"9".repeat(64)}`, commitId: `12${"9".repeat(64)}` };
  await context.db.insert(campGoals).values({ roomId: kit.room.id, title: "Historical result", createdByUserId: kit.owner.id, status: "completed", workflow: "legacy", budget: { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 }, baseCandidate: extra });
  const stale = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "migration", expectedEpoch: 1, expectedAcceptedRevision: 1, backupOperationId: origin.operation.id }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "inventory_changed");
  for (let i = 0; i < 10; i++) await context.db.insert(campGoals).values({ roomId: kit.room.id, title: `History ${i}`, createdByUserId: kit.owner.id, status: "completed", workflow: "legacy", budget: { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 }, baseCandidate: { ...kit.candidate, refId: `12${i.toString(16).padStart(64, "0")}`, commitId: `12${i.toString(16).padStart(64, "0")}` } });
  const current = await kit.begin(); assert.equal(current.operation.candidateCount, 12); assert.equal(current.operation.plan.candidates.length, 8); assert.equal(current.operation.inventoryTruncated, true);
  const full = await kit.user.get(`/api/camp/rooms/${kit.room.id}/storage-operations/${current.operation.id}`); assert.equal((await full.json()).plan.candidates.length, 12);
  await kit.post(`/storage-operations/${current.operation.id}/cancel`);
  for (let i = 0; i < 20; i++) await context.db.insert(campStorageOperations).values({ roomId: kit.room.id, requestId: randomUUID(), kind: "backup", phase: "cancelled", plan: { ...current.operation.plan, candidates: [kit.candidate], operationId: randomUUID() }, planDigest: "a".repeat(64), createdByUserId: kit.owner.id });
  const snapshot = await kit.status(); assert.equal(snapshot.operations.length, 20); assert.equal(snapshot.operationsTruncated, true); assert.equal((await context.db.select().from(campEvents)).filter(event => event.type === "storage_maintenance").length, 2);
  const active = await kit.begin(); await context.db.update(campStorageOperations).set({ createdAt: new Date("2000-01-01T00:00:00Z") }).where(eq(campStorageOperations.id, active.operation.id));
  const withActive = await kit.status(); assert.equal(withActive.maintenance, true); assert.equal(withActive.activeOperationId, active.operation.id); assert.equal(withActive.operations[0].id, active.operation.id); assert.equal(withActive.operations.length, 20); assert.equal(withActive.operationsTruncated, true);
  const cancelled = await kit.post(`/storage-operations/${active.operation.id}/cancel`); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).operation.phase, "cancelled");
});
apiTest("maintenance permits original terminal outbox replay but disables retry and rejects stale historical pool authority", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app, db }); assert.equal((await kit.post("/tasks", { title: "Original owner", role: "planner" })).status, 201);
  const claimed = await kit.worker("/claim", { workerId: "lane-1", protocol: { ...createWorkerDeclaration(), executionPool: pool } }), run = (await claimed.json()).run; assert.ok(run);
  const payload = { workerId: "lane-1", epoch: run.epoch, status: "failed", summary: "Original stopped resources", error: "model_error" };
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200);
  const [before] = await db.select().from(campGoals).where(eq(campGoals.id, run.goalId));
  // A previous v4 goal retains its exact physical owner after migration. It is
  // not repinned merely because the next accepted goal can run elsewhere.
  await db.update(campGoals).set({ executionPool: pool, workflow: "serial", protocolVersion: 4, planMode: "parallel_pair", baseHeadRevision: 1 }).where(eq(campGoals.id, run.goalId));
  const operation = await kit.begin("migration"), maintenance = await kit.user.get(`/api/camp/rooms/${kit.room.id}`), state = await maintenance.json(); assert.equal(state.roomBusy, true); assert.equal(state.goals[0].canRetry, false);
  assert.equal((await kit.post(`/goals/${run.goalId}/retry`, { expectedAttempt: before.attempt })).status, 409);
  assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200);
  const receipt = kit.backup(operation.operation); assert.equal((await kit.worker(`/storage-operations/${operation.operation.id}/backup`, receipt)).status, 200);
  const restored = { ...receipt, targetStorageId: "2".repeat(64), verifiedCandidates: 1, historyVerified: true }; assert.equal((await kit.worker(`/storage-operations/${operation.operation.id}/restore`, restored)).status, 200);
  assert.equal((await kit.post(`/storage-operations/${operation.operation.id}/activate`, { expectedEpoch: 1, expectedTargetStorageId: restored.targetStorageId })).status, 200);
  const retry = await kit.post(`/goals/${run.goalId}/retry`, { expectedAttempt: before.attempt }); assert.equal(retry.status, 409); assert.equal((await retry.json()).code, "storage_changed");
  const [after] = await db.select().from(campGoals).where(eq(campGoals.id, run.goalId)); assert.equal(after.attempt, before.attempt); assert.deepEqual(after.executionPool, pool); assert.equal((await kit.worker(`/runs/${run.id}/complete`, payload)).status, 200);
});
apiTest("private Room storage metadata requires channel visibility and unresolved integration facts block all maintenance", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app, db }), outsider = await seed.human();
  const second = await seed.channel({ server: kit.server, visibility: "private", members: [kit.owner] });
  const created = await kit.user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: second.id, name: "Private native history", project: { name: "fixture" } }) }); assert.equal(created.status, 201); const room = await created.json();
  assert.equal((await http.as(kit.member, kit.server).get(`/api/camp/rooms/${room.id}/storage`)).status, 404);
  assert.equal((await http.as(outsider, kit.server).get(`/api/camp/rooms/${room.id}/storage`)).status, 403);
  await db.insert(campGoals).values({ roomId: kit.room.id, title: "Unknown native result", createdByUserId: kit.owner.id, status: "needs_attention", workflow: "serial", protocolVersion: 3, planMode: "same_baseline_pair", budget: { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 }, integrationInspectionRequired: true });
  const state = await kit.status(); assert.equal(state.canBackup, false); assert.ok(state.blockers.includes("integration_inspection_required"));
  const denied = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "migration", expectedEpoch: 1, expectedAcceptedRevision: 1 }); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, "integration_inspection_required");
});

apiTest("bound Room idle claims diagnose the physical authority without observing workers or requiring a ready task", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app, db });
  for (const [workerId, protocol, expected] of [
    ["lane-1", undefined, "pool_required"],
    ["lane-1", { ...createWorkerDeclaration(), executionPool: { ...pool, storageId: "2".repeat(64) } }, "storage_mismatch"],
    ["unregistered", { ...createWorkerDeclaration(), executionPool: pool }, "lane_not_registered"],
  ] as const) {
    const response = await kit.worker("/claim", { workerId, ...(protocol ? { protocol } : {}) }); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.run, null); assert.equal(body.compatibility.code, expected); assert.equal(body.compatibility.protocolVersion, null); assert.equal(body.requirements, null);
  }
  assert.equal((await db.select().from(campRuns)).length, 0); assert.equal((await db.select().from(campWorkers)).length, 0);
  const replayOnly = await kit.worker("/claim", { workerId: "old-worker", restoreOnly: true, claimId: randomUUID(), runToken: `camp_run_${"0".repeat(64)}` }); assert.equal((await replayOnly.json()).unbound, true);
});

apiTest("event-only trusted candidate survives lease loss in the frozen inventory and invalidates an older backup", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app, db }), origin = await kit.begin(); assert.equal((await kit.worker(`/storage-operations/${origin.operation.id}/backup`, kit.backup(origin.operation))).status, 200);
  assert.equal((await kit.post("/tasks", { title: "Interrupted candidate producer", role: "builder" })).status, 201);
  const claimed = await kit.worker("/claim", { workerId: "lane-1", protocol: { ...createWorkerDeclaration(), executionPool: pool } }), run = (await claimed.json()).run; assert.ok(run);
  const eventCandidate = { ...kit.candidate, refId: `12${"8".repeat(64)}`, commitId: `12${"8".repeat(64)}`, rootId: "7".repeat(64) };
  const artifact = await kit.worker(`/runs/${run.id}/events`, { workerId: "lane-1", epoch: run.epoch, type: "artifact", content: "Trusted candidate before interrupted final response", artifact: eventCandidate }); assert.equal(artifact.status, 201, await artifact.clone().text());
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id)); await reconcileCampPass();
  assert.equal((await kit.post(`/goals/${run.goalId}/cancel`)).status, 200); assert.equal((await kit.worker(`/runs/${run.id}/cleanup`, { workerId: "lane-1", epoch: run.epoch })).status, 200);
  const [lost] = await db.select().from(campRuns).where(eq(campRuns.id, run.id)); assert.deepEqual(lost.artifacts, []); assert.equal(lost.candidate, null);
  const stale = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "migration", expectedEpoch: 1, expectedAcceptedRevision: 1, backupOperationId: origin.operation.id }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "inventory_changed");
  const next = await kit.begin(); assert.deepEqual(next.operation.plan.candidates.map(value => value.refId).sort(), [kit.candidate.refId, eventCandidate.refId].sort());
});
apiTest("an unchanged artifact remains recoverable across placement epochs while current CAS and snapshot facts stay fenced", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app, db }), origin = await kit.begin(), receipt = kit.backup(origin.operation); assert.equal((await kit.worker(`/storage-operations/${origin.operation.id}/backup`, receipt)).status, 200);
  for (const epoch of [1, 2]) {
    const migration = await kit.begin("migration", { expectedEpoch: epoch, backupOperationId: origin.operation.id }); assert.equal(migration.operation.plan.storageEpoch, epoch); assert.equal(migration.operation.plan.sourceStorageId, String(epoch).repeat(64)); assert.deepEqual(migration.operation.backupReceipt, receipt);
    const restore = { ...receipt, operationId: migration.operation.id, targetStorageId: String(epoch + 1).repeat(64), verifiedCandidates: 1, historyVerified: true };
    if (epoch > 1) assert.equal((await kit.worker(`/storage-operations/${migration.operation.id}/restore`, { ...restore, targetStorageId: migration.operation.plan.sourceStorageId })).status, 409, "A historical artifact cannot attest restoration onto the currently active location");
    assert.equal((await kit.worker(`/storage-operations/${migration.operation.id}/restore`, restore)).status, 200);
    assert.equal((await kit.post(`/storage-operations/${migration.operation.id}/activate`, { expectedEpoch: epoch, expectedTargetStorageId: restore.targetStorageId })).status, 200);
    const state = await kit.status(); assert.equal(state.epoch, epoch + 1); assert.equal(state.operations.find(value => value.id === origin.operation.id)?.canRestoreFromBackup, true, "A location handoff alone does not make the last verified data copy stale");
  }
  await db.update(campRooms).set({ acceptedRevision: 2 }).where(eq(campRooms.id, kit.room.id));
  const stale = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "migration", expectedEpoch: 3, expectedAcceptedRevision: 2, backupOperationId: origin.operation.id }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "inventory_changed"); assert.equal((await kit.status()).operations.find(value => value.id === origin.operation.id)?.canRestoreFromBackup, false);
});
