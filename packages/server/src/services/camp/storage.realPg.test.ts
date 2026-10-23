import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { test } from "vitest";
import { createWorkerDeclaration } from "../../../../camp-protocol/src/index.js";
import * as schema from "../../db/schema";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { createServer } from "../serverService";
import { addHuman, createChannel } from "../channelService";
import { createPipeline, createRoom, mintWorkerToken } from "./rooms";
import { authenticateCampToken, claimRunDetailed, completeRun } from "./runs";
import { activateStorage, cancelStorage, createStorageOperation, recordStorageBackup, recordStorageRestore, roomProjectId } from "./storage";
import type { CampAgentClaimedRun } from "./types";
const url = process.env.CAMP_REAL_PG_URL, required = process.env.CAMP_REAL_PG_REQUIRED === "1";
test("real PostgreSQL freezes one cold storage operation and preserves original backup facts through activation CAS", { skip: !(url || required), timeout: 120000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL required"); const name = `camp_storage_${randomUUID().replaceAll("-", "")}`, admin = new pg.Client({ connectionString: url }); await admin.connect(); let initialized = false;
  const connection = new URL(url); connection.pathname = `/${name}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); const pool = new pg.Pool({ connectionString: connection.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) }); } finally { await pool.end(); }
    await initDatabase(connection.toString()); initialized = true; const db = getDb();
    const [owner] = await db.insert(schema.users).values({ name: "storage-owner", email: `${name}@test.invalid`, passwordHash: "test-only", emailVerified: true }).returning();
    const server = await createServer("Storage fixture", name, owner.id), channel = await createChannel(server.id, "storage-test"); await addHuman(channel.id, owner.id);
    const room = await createRoom(server.id, owner.id, { channelId: channel.id, name: "Storage", project: { name: "fixture" } });
    const candidate = { type: "layerfs" as const, projectId: roomProjectId(room.id), refKind: "commit" as const, refId: `12${"a".repeat(64)}`, commitId: `12${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
    await db.update(schema.campRooms).set({ acceptedCandidate: candidate, acceptedRevision: 1, storageId: "1".repeat(64) }).where(eq(schema.campRooms.id, room.id));
    const token = await mintWorkerToken(room.id, owner.id), principal = await authenticateCampToken(token.token);
    const begin = (kind: "backup" | "migration" = "backup", extra: Record<string, string> = {}) => createStorageOperation(room.id, owner.id, { requestId: randomUUID(), kind, expectedEpoch: 1, expectedAcceptedRevision: 1, ...extra });
    const outcomes = await Promise.allSettled([begin(), begin()]); assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1); assert.equal(outcomes.filter(value => value.status === "rejected").length, 1);
    const winner = outcomes.find(value => value.status === "fulfilled"); assert.ok(winner?.status === "fulfilled"); const operation = winner.value.operation;
    const idle = await claimRunDetailed(principal, "lane-1", undefined, createWorkerDeclaration()); assert.equal(idle.admission?.reason, "storage_maintenance"); assert.equal((await db.select().from(schema.campWorkers)).length, 0);
    const receipt = { schemaVersion: 1, operationId: operation.id, manifestDigest: "d".repeat(64), storeSha256: "e".repeat(64), bytes: 4096, toolchainDigest: "f".repeat(64), imageId: candidate.imageId, candidateCount: 1, sourceStorageId: "1".repeat(64), stopped: true, verified: true };
    await recordStorageBackup(principal, operation.id, receipt);
    const migration = await begin("migration", { backupOperationId: operation.id }); assert.deepEqual(migration.operation.backupReceipt, receipt);
    const restore = { ...receipt, operationId: migration.operation.id, targetStorageId: "2".repeat(64), verifiedCandidates: 1, historyVerified: true }; await recordStorageRestore(principal, migration.operation.id, restore);
    const activated = await Promise.all([activateStorage(room.id, migration.operation.id, owner.id, 1, restore.targetStorageId), activateStorage(room.id, migration.operation.id, owner.id, 1, restore.targetStorageId)]); assert.ok(activated.every(value => value.storage.epoch === 2));
    const [after] = await db.select().from(schema.campRooms).where(eq(schema.campRooms.id, room.id)); assert.equal(after.acceptedRevision, 1); assert.deepEqual(after.acceptedCandidate, candidate);
    const [original] = await db.select().from(schema.campStorageOperations).where(eq(schema.campStorageOperations.id, operation.id)); assert.deepEqual(original.backupReceipt, receipt);
    // Losing the destination before making another backup must not invalidate
    // the only remaining artifact when its logical snapshot is unchanged.
    const secondMigration = await createStorageOperation(room.id, owner.id, { requestId: randomUUID(), kind: "migration", expectedEpoch: 2, expectedAcceptedRevision: 1, backupOperationId: operation.id });
    assert.deepEqual(secondMigration.operation.backupReceipt, receipt);
    const secondRestore = { ...receipt, operationId: secondMigration.operation.id, targetStorageId: "3".repeat(64), verifiedCandidates: 1, historyVerified: true };
    await recordStorageRestore(principal, secondMigration.operation.id, secondRestore);
    await activateStorage(room.id, secondMigration.operation.id, owner.id, 2, secondRestore.targetStorageId);
    await createPipeline(room.id, owner.id, { title: "Migrated legacy cannot bypass binding", role: "planner" });
    const denied = await claimRunDetailed(principal, "legacy"); assert.equal(denied.run, null); assert.equal(denied.compatibility?.code, "pool_required");
    const executionPool = { poolId: randomUUID(), storageId: secondRestore.targetStorageId, maxParallel: 2 as const, workerIds: ["lane-1", "lane-2"], resources: { maxContainers: 4 as const, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };
    const claim = await claimRunDetailed(principal, "lane-1", undefined, { ...createWorkerDeclaration(), executionPool }); assert.ok(claim.run?.executor === "agent"); const run = claim.run as CampAgentClaimedRun;
    await completeRun(principal, run.id, "lane-1", run.epoch, { status: "failed", summary: "Cleanly stopped", error: "model_error" });
    const next = await createStorageOperation(room.id, owner.id, { requestId: randomUUID(), kind: "backup", expectedEpoch: 3, expectedAcceptedRevision: 1 }); await cancelStorage(room.id, next.operation.id, owner.id);
    assert.equal((await db.select().from(schema.campStorageOperations)).length, 4);
    const race = await Promise.allSettled([
      createStorageOperation(room.id, owner.id, { requestId: randomUUID(), kind: "backup", expectedEpoch: 3, expectedAcceptedRevision: 1 }),
      createPipeline(room.id, owner.id, { title: "Concurrent admission", role: "planner" }),
    ]);
    assert.equal(race.filter(value => value.status === "fulfilled").length, 1, "A cold freeze and new goal cannot both cross the Room admission fence");
    const lost = race.find(value => value.status === "rejected"); assert.ok(lost?.status === "rejected"); assert.ok(["active_goal", "storage_maintenance"].includes(lost.reason.code));

  } finally { if (initialized) await closeDatabase(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
});
