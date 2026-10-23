import { CAMP_PREFLIGHT_CHECK_IDS, createWorkerDeclaration } from "../../../../camp-protocol/src/index.js";
import assert from "node:assert/strict";
import { __resetFailpointsForTests, __setFailpointsForTests, InMemoryFailpointRegistry } from "@botiverse/raft-shared";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import { test } from "vitest";
import * as schema from "../../db/schema";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { amendTask, assignTask, claimTask, createTasks, forceUpdateTaskStatus } from "../taskService";
import { deleteAgent } from "../agentService";
import { createServer } from "../serverService";
import { addAgent, addHuman, createChannel, deleteChannel, removeAgent, removeHuman } from "../channelService";
import { createPipeline, createRoom, lockRoom, mintWorkerToken } from "./rooms";
import { authenticateCampToken, claimRun, claimRunDetailed, completeRun, recordRunEvent, roleAvailable, runContext } from "./runs";
import { retryGoal, cancelGoal } from "./goals";
import { reconcileCampPass } from "./reconcile";
import { submitPlan, finalizeGoal } from "./plans";
import { CAMP_ROLES, type CampAgentClaimedRun } from "./types";
import { setVerificationPolicy } from "./verification";
import { recordWorkerPreflight, workerSetup } from "./setup";

const url = process.env.CAMP_REAL_PG_URL;
const required = process.env.CAMP_REAL_PG_REQUIRED === "1";

test("real PostgreSQL serializes Camp room admission and channel lifecycle with live control transactions", { skip: !(url || required), timeout: 120_000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL is required");
  const database = `camp_channel_${randomUUID().replaceAll("-", "")}`, admin = new pg.Client({ connectionString: url });
  await admin.connect(); let initialized = false;
  const connection = new URL(url); connection.pathname = `/${database}`;
  const locker = new pg.Client({ connectionString: connection.toString() });
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const pool = new pg.Pool({ connectionString: connection.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) }); }
    finally { await pool.end(); }
    await initDatabase(connection.toString()); initialized = true; await locker.connect();
    const db = getDb();
    const [owner] = await db.insert(schema.users).values({ name: "camp-channel-owner", email: `${database}@test.invalid`, passwordHash: "test-only", emailVerified: true }).returning();
    const server = await createServer("Camp channel fence", database, owner.id), channel = await createChannel(server.id, "camp-channel-fence"); await addHuman(channel.id, owner.id);
    // Hold the existing handle-admission fence until BOTH callers have passed
    // their optimistic reads. This deterministically reproduces double-submit.
    await locker.query("BEGIN");
    await locker.query("SELECT pg_advisory_xact_lock($1, 1)", [parseInt(server.id.replaceAll("-", "").slice(0, 8), 16) | 0]);
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const blocked = async (expected: number, finished: () => boolean = () => false) => {
      for (let poll = 0; poll < 100; poll++) {
        const rows = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, pid]);
        if (rows.rows[0].count >= expected) return true;
        if (finished()) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    };
    const requests = ["First", "Second"].map(name => createRoom(server.id, owner.id, { channelId: channel.id, name, project: { name: "fixture" } }));
    const admissions = Promise.allSettled(requests);
    try { assert.equal(await blocked(2), true, "Both room requests reach the same admission fence"); }
    finally { await locker.query("COMMIT"); }
    const outcomes = await admissions, winner = outcomes.find(value => value.status === "fulfilled"), loser = outcomes.find(value => value.status === "rejected");
    assert.ok(winner?.status === "fulfilled"); assert.ok(loser?.status === "rejected");
    const duplicateCode = loser.reason.code;
    const room = winner.value;
    const identities = room.roles.map(role => role.agentId).sort(), reusedChannel = await createChannel(server.id, "camp-reused-identities"); await addHuman(reusedChannel.id, owner.id);
    await locker.query("BEGIN"); await locker.query("SELECT id FROM agents WHERE id=$1 FOR UPDATE", [identities[0]]);
    const reuse = createRoom(server.id, owner.id, { channelId: reusedChannel.id, name: "Reused identities", project: { name: "fixture" }, roles: CAMP_ROLES.map((role, index) => ({ role, agentId: [identities[1], identities[0], identities[2]][index] })) });
    void reuse.catch(() => {}); let reusedIdentityLockOrder = false;
    try {
      assert.equal(await blocked(1), true, "Creation waits for the first identity in sorted order");
      await locker.query("SELECT id FROM agents WHERE id=$1 FOR UPDATE NOWAIT", [identities[1]]); reusedIdentityLockOrder = true;
    } finally { await locker.query("ROLLBACK"); await reuse; }
    // Exercise both real addAgent paths before Room's final channel lock.
    // DO NOTHING holds no existing ca tuple; a new INSERT instead holds the
    // channel FK KEY SHARE, so a remover cannot own channel UPDATE first.
    for (const existing of [true, false]) {
      const target = existing ? reusedChannel : await createChannel(server.id, "camp-new-membership-lock");
      if (!existing) await addHuman(target.id, owner.id);
      let added!: () => void, finishAdmission!: () => void, admissionPid = 0;
      const inserted = new Promise<void>(resolve => { added = resolve; }), finish = new Promise<void>(resolve => { finishAdmission = resolve; });
      const admission = db.transaction(async tx => {
        const changed = await addAgent(target.id, identities[0], { executor: tx }); assert.equal(changed, !existing);
        admissionPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid);
        added(); await finish;
        await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.id, target.id)).for("share");
      });
      void admission.catch(() => {}); await inserted;
      let removalSettled = false;
      const removal = removeAgent(target.id, identities[0]).finally(() => { removalSettled = true; }); void removal.catch(() => {});
      try {
        if (existing) {
          for (let poll = 0; poll < 100 && !removalSettled; poll++) await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(removalSettled, true, "An existing ON CONFLICT DO NOTHING tuple cannot block removal before the final channel lock");
        } else {
          let waitsOnAdmission = false;
          for (let poll = 0; poll < 100; poll++) {
            const rows = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, admissionPid]);
            if (rows.rows[0].count > 0) { waitsOnAdmission = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(waitsOnAdmission, true, "The inserted ca's immediate channel FK blocks the remover's UPDATE before it can own ca");
        }
      } finally { finishAdmission(); await Promise.all([admission, removal]); }
    }
    let held!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { held = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    const control = db.transaction(async tx => { await lockRoom(tx, room.id); held(); await released; });
    void control.catch(() => {}); await acquired;
    let archiveFinished = false;
    const archival = locker.query("UPDATE channels SET archived_at=clock_timestamp() WHERE id=$1", [channel.id]).finally(() => { archiveFinished = true; });
    let lifecycleBlocked = false;
    try {
      // Here the Room transaction is the blocker, so query the archiver itself.
      for (let poll = 0; poll < 100; poll++) {
        const rows = await admin.query("SELECT cardinality(pg_blocking_pids($1))::int AS count", [pid]);
        if (rows.rows[0].count > 0) { lifecycleBlocked = true; break; }
        if (archiveFinished) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { release(); await Promise.all([control, archival]); }
    assert.deepEqual({ duplicateCode, lifecycleBlocked, reusedIdentityLockOrder }, { duplicateCode: "room_exists", lifecycleBlocked: true, reusedIdentityLockOrder: true });
    await assert.rejects(db.transaction(tx => lockRoom(tx, room.id)), { code: "room_unavailable" });
    assert.equal((await db.select().from(schema.campRooms).where(eq(schema.campRooms.channelId, channel.id))).length, 1);
    assert.equal((await db.select().from(schema.agents).where(eq(schema.agents.serverId, server.id))).length, 3, "The losing admission creates no role identities");

    // Last private member removal used to own ca before requesting the channel
    // update. A live control transaction owns channel before reading ca. The
    // remover must now wait BEFORE deleting membership, never form that cycle.
    const privateChannel = await createChannel(server.id, "camp-last-private-member", undefined, "private"); await addHuman(privateChannel.id, owner.id);
    const privateRoom = await createRoom(server.id, owner.id, { channelId: privateChannel.id, name: "Private removal", project: { name: "fixture" } });
    await createPipeline(privateRoom.id, owner.id, { title: "A live private role", role: "planner" });
    const privateToken = await mintWorkerToken(privateRoom.id, owner.id), privatePrincipal = await authenticateCampToken(privateToken.token);
    const active = (await claimRun(privatePrincipal, "private-worker"))! as CampAgentClaimedRun;
    await removeHuman(privateChannel.id, owner.id);
    for (const role of privateRoom.roles.filter(role => role.agentId !== active.agentId)) await removeAgent(privateChannel.id, role.agentId);
    let privateHeld!: () => void, inspectMembership!: () => void, controlPid = 0;
    const privateAcquired = new Promise<void>(resolve => { privateHeld = resolve; }), inspect = new Promise<void>(resolve => { inspectMembership = resolve; });
    const privateControl = db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2500ms'`);
      await lockRoom(tx, privateRoom.id);
      controlPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid);
      privateHeld(); await inspect;
      return roleAvailable(tx, privateRoom, active.agentId);
    });
    void privateControl.catch(() => {}); await privateAcquired;
    const removal = db.transaction(async tx => { await tx.execute(sql`set local lock_timeout = '2500ms'`); await removeAgent(privateChannel.id, active.agentId, tx); });
    void removal.catch(() => {});
    let removalWaits = false;
    try {
      for (let poll = 0; poll < 100; poll++) {
        const rows = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, controlPid]);
        if (rows.rows[0].count > 0) { removalWaits = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      inspectMembership();
      assert.equal(await privateControl, true, "The remover cannot delete ca before the live membership read"); await removal;
      assert.equal(removalWaits, true);
    } finally { inspectMembership(); await Promise.allSettled([privateControl, removal]); }
    assert.ok((await db.select().from(schema.channels).where(eq(schema.channels.id, privateChannel.id)))[0].deletedAt);
    await reconcileCampPass();
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, active.goalId)))[0].reason, "channel_unavailable");

    const deletionChannel = await createChannel(server.id, "camp-delete-channel-order"); await addHuman(deletionChannel.id, owner.id);
    const deletionRoom = await createRoom(server.id, owner.id, { channelId: deletionChannel.id, name: "Channel delete order", project: { name: "fixture" } });
    await createPipeline(deletionRoom.id, owner.id, { title: "Serialize canonical task closure", role: "planner" });
    const [deletionBinding] = await db.select().from(schema.campTasks).where(eq(schema.campTasks.roomId, deletionRoom.id));
    let deletionHeld!: () => void, readTask!: () => void, deleteControlPid = 0;
    const deletionAcquired = new Promise<void>(resolve => { deletionHeld = resolve; }), inspectTask = new Promise<void>(resolve => { readTask = resolve; });
    const deletionControl = db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2500ms'`); await lockRoom(tx, deletionRoom.id);
      deleteControlPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid);
      deletionHeld(); await inspectTask;
      return (await tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, deletionBinding.taskId)).for("update"))[0].id;
    });
    void deletionControl.catch(() => {}); await deletionAcquired;
    const deleting = deleteChannel(deletionChannel.id); void deleting.catch(() => {});
    let deleteWaits = false;
    try {
      for (let poll = 0; poll < 100; poll++) {
        const rows = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, deleteControlPid]);
        if (rows.rows[0].count > 0) { deleteWaits = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      readTask();
      assert.equal(await deletionControl, deletionBinding.taskId, "Channel deletion must wait before closing canonical tasks"); await deleting;
      assert.equal(deleteWaits, true);
    } finally { readTask(); await Promise.allSettled([deletionControl, deleting]); }
    assert.equal((await db.select().from(schema.tasks).where(eq(schema.tasks.id, deletionBinding.taskId)))[0].status, "closed");
  } finally {
    await locker.end().catch(() => {}); if (initialized) await closeDatabase();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end();
  }
});

test("real PostgreSQL room claims have one winner and expired epochs cannot complete a replacement run", { skip: !(url || required), timeout: 120_000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL is required");
  const database = `camp_lease_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  let initialized = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url);
    connection.pathname = `/${database}`;
    const pool = new pg.Pool({ connectionString: connection.toString(), max: 2 });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) }); }
    finally { await pool.end(); }
    await initDatabase(connection.toString());
    initialized = true;
    const db = getDb();
    const [owner] = await db.insert(schema.users).values({ name: "camp-owner", email: `camp-${database}@test.invalid`, passwordHash: "test-only", emailVerified: true }).returning();
    const server = await createServer("Camp lease test", database, owner.id);
    const channel = await createChannel(server.id, "camp-test");
    await addHuman(channel.id, owner.id);
    const identities = await db.insert(schema.agents).values(CAMP_ROLES.map(role => ({ serverId: server.id, name: `camp-${role}`, runtime: "external", model: "external" }))).returning();
    await db.insert(schema.serverAgentMembers).values(identities.map(agent => ({ serverId: server.id, agentId: agent.id, role: "member" as const })));
    const room = await createRoom(server.id, owner.id, { channelId: channel.id, name: "Lease test", project: { name: "test" }, roles: CAMP_ROLES.map((role, index) => ({ role, agentId: identities[index].id })) });
    await createPipeline(room.id, owner.id, { title: "One pipeline", role: "planner" });
    const credential = await mintWorkerToken(room.id, owner.id);
    const principal = await authenticateCampToken(credential.token);
    const setup = await workerSetup(principal);
    const preflight = await recordWorkerPreflight(principal, "setup-only", setup.projectDigest, {
      schemaVersion: 1, workerVersion: "0.4.0", mode: "verification", modelConfigured: false,
      toolchainDigest: null, imageId: null,
      checks: CAMP_PREFLIGHT_CHECK_IDS.map(id => ({ id, status: "skipped", code: "not_run" })),
    });
    assert.equal(preflight.readiness.selfReported, true);
    assert.equal((await db.select().from(schema.campRuns)).length, 0);
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.roomId, room.id)))[0].runCount, 0);
    const [observed] = await db.select().from(schema.campWorkers).where(eq(schema.campWorkers.workerId, "setup-only"));
    assert.equal(observed.preflightProjectDigest, setup.projectDigest); assert.equal(observed.lastClaimAt, null);
    const raced = await Promise.all([claimRun(principal, "worker-1"), claimRun(principal, "worker-2")]);
    const winners = raced.filter(run => run !== null);
    assert.equal(winners.length, 1);
    const first = winners[0]! as CampAgentClaimedRun;
    assert.equal(first.role, "planner");
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, first.id));
    const recovered = await Promise.all([claimRun(principal, "recovery-1"), claimRun(principal, "recovery-2")]);
    const successors = recovered.filter(run => run !== null);
    assert.equal(successors.length, 1);
    const successor = successors[0]! as CampAgentClaimedRun;
    assert.equal(successor.taskId, first.taskId);
    assert.equal(successor.epoch, first.epoch + 1);
    await assert.rejects(completeRun(principal, first.id, first.id === raced[0]?.id ? "worker-1" : "worker-2", first.epoch, { status: "completed", summary: "stale result" }), { code: "stale_run" });
    const [replacement] = await db.select().from(schema.campRuns).where(eq(schema.campRuns.id, successor.id));
    assert.equal(replacement.status, "running");
    assert.equal(replacement.summary, null);
    const [canonical] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, successor.taskId));
    assert.equal(canonical.status, "in_progress");

    // A replica skips a room already owned by another writer instead of
    // waiting behind it. Once released, concurrent sweeps settle it once.
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, successor.id));
    const locker = new pg.Client({ connectionString: connection.toString() });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM camp_rooms WHERE id=$1 FOR UPDATE", [room.id]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const skipped = await Promise.race([reconcileCampPass(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Reconciler blocked on an owned room")), 2000); })]);
      assert.equal(skipped, 0);
      assert.equal((await db.select().from(schema.campRuns).where(eq(schema.campRuns.id, successor.id)))[0].status, "running");
    } finally {
      clearTimeout(timer);
      await locker.query("ROLLBACK"); await locker.end();
    }
    await Promise.all([reconcileCampPass(), reconcileCampPass()]);
    assert.equal((await db.select().from(schema.campEvents).where(and(eq(schema.campEvents.runId, successor.id), eq(schema.campEvents.type, "lease_expired")))).length, 1);
    assert.equal((await db.select().from(schema.campRuns).where(eq(schema.campRuns.id, successor.id)))[0].status, "failed");

    const channel2 = await createChannel(server.id, "claim-replay-test");
    await addHuman(channel2.id, owner.id);
    const room2 = await createRoom(server.id, owner.id, { channelId: channel2.id, name: "Claim replay", project: { name: "test" } });
    const submitted = await createPipeline(room2.id, owner.id, { title: "One bounded run", role: "planner", budget: { maxRuns: 1 } });
    const credential2 = await mintWorkerToken(room2.id, owner.id);
    const principal2 = await authenticateCampToken(credential2.token);
    const claimId = randomUUID();
    const runToken = `camp_run_${createHmac("sha256", credential2.token).update(claimId).digest("hex")}`;
    const intent = { claimId, runToken };
    const [claim1, claim2] = await Promise.all([claimRunDetailed(principal2, "stable-worker", intent), claimRunDetailed(principal2, "stable-worker", intent)]);
    assert.ok(claim1.run && claim2.run);
    assert.equal(claim1.run.executor, "agent"); assert.equal(claim2.run.executor, "agent");
    if (claim1.run.executor !== "agent" || claim2.run.executor !== "agent") throw new Error("Expected legacy agent runs");
    assert.equal(claim1.run.id, claim2.run.id);
    assert.equal(claim2.run.runToken, runToken);
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, submitted.goalId)))[0].runCount, 1);
    const interruptedPayload = { status: "failed" as const, summary: "Known cleanup after worker interruption", error: "worker_interrupted" };
    await completeRun(principal2, claim1.run.id, "stable-worker", claim1.run.epoch, interruptedPayload);
    const [hashedCompletion] = await db.select().from(schema.campRuns).where(eq(schema.campRuns.id, claim1.run.id)); assert.match(hashedCompletion.completionPayloadHash!, /^[a-f0-9]{64}$/);
    const retried = await Promise.allSettled([retryGoal(room2.id, submitted.goalId, owner.id, 1), retryGoal(room2.id, submitted.goalId, owner.id, 1)]);
    assert.equal(retried.filter(result => result.status === "fulfilled").length, 1);
    const denied = retried.find(result => result.status === "rejected");
    assert.equal(denied?.status === "rejected" && denied.reason.code, "goal_attempt_changed");
    assert.equal((await db.select().from(schema.campTasks).where(eq(schema.campTasks.goalId, submitted.goalId))).length, 2);
    assert.deepEqual(await claimRunDetailed(principal2, "stable-worker", intent), { run: null, closed: true });
    assert.equal((await completeRun(principal2, claim1.run.id, "stable-worker", claim1.run.epoch, interruptedPayload)).replayed, true, "Original completion survives a manual replacement goal attempt");

    // Independent PostgreSQL writers must share one serial admission and one
    // accepted-head transition, including a duplicated final HTTP completion.
    const channel3 = await createChannel(server.id, "serial-writers");
    await addHuman(channel3.id, owner.id);
    const room3 = await createRoom(server.id, owner.id, { channelId: channel3.id, name: "Serial writers", project: { name: "serial" } });
    await setVerificationPolicy(room3.id, owner.id, { id: "compat", revision: 1, name: "Compatibility", maxRepairAttempts: 1, checks: [{ id: "checks", label: "Checks", argv: ["node", "--test"], timeoutMs: 1000 }] });
    const admissions = await Promise.allSettled([
      createPipeline(room3.id, owner.id, { title: "First contender" }),
      createPipeline(room3.id, owner.id, { title: "Second contender" }),
    ]);
    assert.equal(admissions.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(admissions.find(value => value.status === "rejected")?.status, "rejected");
    const admitted = admissions.find(value => value.status === "fulfilled");
    assert.ok(admitted?.status === "fulfilled");
    const goal3 = admitted.value.goalId;
    // Preserve the existing v1 ownership/locking regression independently of v2 operations below.
    await db.update(schema.campGoals).set({ protocolVersion: 1, verificationPolicy: null }).where(eq(schema.campGoals.id, goal3));
    const credential3 = await mintWorkerToken(room3.id, owner.id), principal3 = await authenticateCampToken(credential3.token);
    const candidate = { type: "layerfs" as const, projectId: "p-0123456789abcdef", refKind: "layer" as const, refId: `32${"d".repeat(64)}`, layerId: `32${"d".repeat(64)}`, rootId: "e".repeat(64), imageId: `sha256:${"f".repeat(64)}` };
    const [firstBinding] = await db.select().from(schema.campTasks).where(eq(schema.campTasks.goalId, goal3));
    const owners = await Promise.allSettled([
      claimTask(firstBinding.taskId, "user", owner.id),
      assignTask(firstBinding.taskId, { type: "user", id: owner.id }, "user", owner.id),
      claimRun(principal3, "serial-worker", createWorkerDeclaration()),
      claimRun(principal3, "old-unversioned-worker"),
    ]);
    for (const result of owners.slice(0, 2)) { assert.equal(result.status, "rejected"); assert.equal(result.status === "rejected" && result.reason.code, "camp_task_owned"); }
    assert.equal(owners[3].status, "fulfilled"); assert.equal(owners[3].status === "fulfilled" && owners[3].value, null);
    assert.equal(owners[2].status, "fulfilled");
    let active3 = (owners[2].status === "fulfilled" ? owners[2].value! : null!) as CampAgentClaimedRun;
    assert.ok(active3);
    await assert.rejects(forceUpdateTaskStatus(active3.taskId, "closed", "user", owner.id), { code: "camp_task_owned" });
    const [soleOwner] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, active3.taskId));
    assert.equal(soleOwner.claimedByType, "agent"); assert.equal(soleOwner.claimedById, active3.agentId); assert.equal(soleOwner.status, "in_progress");
    await submitPlan(await authenticateCampToken(active3.runToken), active3.id, { workerId: "serial-worker", runId: active3.id, epoch: active3.epoch, planRevision: 1, summary: "A verified no-op", tasks: [{ key: "inspect", title: "Inspect", description: "Confirm it is already correct", acceptance: "Existing content satisfies the goal", verification: "Read and check content" }] });
    const finish = (run: typeof active3) => completeRun(principal3, run.id, "serial-worker", run.epoch, { status: "completed", summary: `${run.taskKind} complete`, inputCandidate: candidate, candidate });
    await finish(active3);
    active3 = (await claimRun(principal3, "serial-worker", createWorkerDeclaration()))! as CampAgentClaimedRun; assert.equal(active3.taskKind, "build"); await finish(active3);
    for (const kind of ["review", "final_review"]) {
      active3 = (await claimRun(principal3, "serial-worker", createWorkerDeclaration()))! as CampAgentClaimedRun; assert.equal(active3.taskKind, kind);
      const context = await runContext(principal3, active3.id);
      await recordRunEvent(await authenticateCampToken(active3.runToken), active3.id, { workerId: "serial-worker", epoch: active3.epoch, type: "artifact", content: "Exact Layer inspected", artifact: { type: "review", outcome: "approved", evidence: "Verified original acceptance", candidate: "reviewTarget" in context ? context.reviewTarget! : undefined } });
      await finish(active3);
    }
    active3 = (await claimRun(principal3, "serial-worker", createWorkerDeclaration()))! as CampAgentClaimedRun; assert.equal(active3.taskKind, "summary");
    await finalizeGoal(await authenticateCampToken(active3.runToken), active3.id, { workerId: "serial-worker", runId: active3.id, epoch: active3.epoch, summary: "All original acceptance satisfied" });
    const conclusions = await Promise.all([finish(active3), finish(active3)]);
    assert.equal(conclusions.filter(value => value.replayed).length, 1);
    const [accepted] = await db.select().from(schema.campRooms).where(eq(schema.campRooms.id, room3.id));
    assert.equal(accepted.acceptedRevision, 1); assert.equal(accepted.acceptedGoalId, goal3); assert.equal(accepted.acceptedCandidate?.refId, candidate.refId);
    assert.equal((await db.select().from(schema.campEvents).where(and(eq(schema.campEvents.runId, active3.id), eq(schema.campEvents.type, "completed")))).length, 1);
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, active3.id));
    assert.equal((await finish(active3)).replayed, true, "final same-epoch replay survives both accepted-head advancement and lease expiry");
    const continuation = await createPipeline(room3.id, owner.id, { title: "Continue accepted result", fromGoalId: goal3 });
    const [nextGoal] = await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, continuation.goalId));
    assert.equal(nextGoal.baseHeadRevision, 1); assert.equal(nextGoal.baseCandidate?.refId, candidate.refId);

    // The verifier competes through the exact same Room claim ledger; two
    // database writers must not create two operations, leases, or receipts.
    const verificationChannel = await createChannel(server.id, "trusted-verification"); await addHuman(verificationChannel.id, owner.id);
    const verificationRoom = await createRoom(server.id, owner.id, { channelId: verificationChannel.id, name: "Trusted verifier", project: { name: "verified" } });
    await setVerificationPolicy(verificationRoom.id, owner.id, { id: "operator", revision: 1, name: "Operator checks", maxRepairAttempts: 1, checks: [{ id: "tests", label: "Tests", argv: ["node", "--test"], timeoutMs: 1000 }] });
    const verificationGoal = await createPipeline(verificationRoom.id, owner.id, { title: "Verify a real immutable no-op" });
    const verificationCredential = await mintWorkerToken(verificationRoom.id, owner.id), verificationPrincipal = await authenticateCampToken(verificationCredential.token);
    const claimAgent = async () => { const run = await claimRun(verificationPrincipal, "trusted-worker", createWorkerDeclaration()); assert.ok(run); if (run.executor !== "agent") throw new Error("Expected agent execution"); return run; };
    const modelFinish = (run: CampAgentClaimedRun) => completeRun(verificationPrincipal, run.id, "trusted-worker", run.epoch, { status: "completed", summary: `${run.taskKind} completed`, inputCandidate: candidate, candidate, ...(run.taskKind === "build" ? { changeSet: { schemaVersion: 1, base: candidate, target: candidate, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } } } : {}) });
    let model = await claimAgent();
    await submitPlan(await authenticateCampToken(model.runToken), model.id, { workerId: "trusted-worker", epoch: model.epoch, planRevision: 1, summary: "One no-op item", tasks: [{ key: "inspect", title: "Inspect", description: "Inspect baseline", acceptance: "Already correct", verification: "Operator checks" }] }); await modelFinish(model);
    model = await claimAgent(); await modelFinish(model); model = await claimAgent();
    const itemContext = await runContext(verificationPrincipal, model.id); assert.ok("reviewTarget" in itemContext);
    await recordRunEvent(await authenticateCampToken(model.runToken), model.id, { epoch: model.epoch, type: "artifact", content: "Reviewed", artifact: { type: "review", outcome: "approved", evidence: "Inspected baseline", candidate: itemContext.reviewTarget! } }); await modelFinish(model);
    const verificationClaims = await Promise.all([claimRun(verificationPrincipal, "trusted-worker", createWorkerDeclaration()), claimRun(verificationPrincipal, "trusted-worker", createWorkerDeclaration())]);
    const verifier = verificationClaims.find(run => run !== null); assert.ok(verifier); assert.equal(verificationClaims.filter(Boolean).length, 1); if (verifier.executor !== "verification") throw new Error("Expected a roleless verification operation");
    assert.equal(verifier.taskId, null); assert.equal(verifier.role, null); assert.equal("runToken" in verifier, false);
    const verificationCompletion = { status: "completed" as const, summary: "Observed operator checks", inputCandidate: candidate, verification: { candidate, policyDigest: verifier.verificationPolicy.digest, checks: [{ id: "tests", argv: ["node", "--test"], exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 2, stdout: "passed", stderr: "", outputTruncated: false }] } };
    const settled = await Promise.all([completeRun(verificationPrincipal, verifier.id, "trusted-worker", verifier.epoch, verificationCompletion), completeRun(verificationPrincipal, verifier.id, "trusted-worker", verifier.epoch, verificationCompletion)]);
    assert.equal(settled.filter(result => result.replayed).length, 1);
    const [operation] = await db.select().from(schema.campOperations).where(eq(schema.campOperations.id, verifier.operationId)); assert.equal(operation.receipt?.status, "passed"); assert.equal(operation.receipt?.checks[0].stdout, "passed");
    assert.equal((await db.select().from(schema.campTasks).where(and(eq(schema.campTasks.goalId, verificationGoal.goalId), eq(schema.campTasks.kind, "final_review")))).length, 1);
    await assert.rejects(db.insert(schema.campRuns).values({ executor: "verification", operationId: verifier.operationId, roomId: verificationRoom.id, taskId: model.taskId, agentId: model.agentId, role: model.role, epoch: 99, workerId: "invalid-owner", runTokenHash: "test-only", leaseExpiresAt: new Date() }), (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint === "camp_runs_executor_owner");

    // A no-op pair still freezes two distinct producer runs even when both
    // candidates are the same immutable Layer. Roleless writers share one lease.
    const pairChannel = await createChannel(server.id, "pair-writers"); await addHuman(pairChannel.id, owner.id);
    const pairRoom = await createRoom(server.id, owner.id, { channelId: pairChannel.id, name: "Pair writers", project: { name: "pair" } });
    await setVerificationPolicy(pairRoom.id, owner.id, { id: "tests", revision: 1, name: "Tests", maxRepairAttempts: 0, checks: [{ id: "tests", label: "Tests", argv: ["node", "--test"], timeoutMs: 1000 }] });
    const pairGoal = await createPipeline(pairRoom.id, owner.id, { title: "Two independent no-ops", planMode: "same_baseline_pair" });
    const pairCredential = await mintWorkerToken(pairRoom.id, owner.id), pairPrincipal = await authenticateCampToken(pairCredential.token);
    const pairAgent = async () => { const run = await claimRun(pairPrincipal, "pair-worker", createWorkerDeclaration()); assert.ok(run); if (run.executor !== "agent") throw new Error("Expected a pair agent"); return run; };
    const pairOutput = { ...candidate, baseRef: candidate.refId };
    const pairFinish = (run: CampAgentClaimedRun) => completeRun(pairPrincipal, run.id, "pair-worker", run.epoch, { status: "completed", summary: "No-op accepted", inputCandidate: candidate, candidate: pairOutput, ...(run.taskKind === "build" ? { changeSet: { schemaVersion: 1, base: candidate, target: pairOutput, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } } } : {}) });
    const preparePairAttempt = async () => {
      let pairModel = await pairAgent();
      await submitPlan(await authenticateCampToken(pairModel.runToken), pairModel.id, { workerId: "pair-worker", epoch: pairModel.epoch, planRevision: 1, summary: "Independent inspections", tasks: ["alpha", "beta"].map(key => ({ key, title: key, description: key, acceptance: "Existing content works", verification: "Inspect it" })) }); await pairFinish(pairModel);
      const producerIds: string[] = [];
      for (const key of ["alpha", "beta"]) {
        pairModel = await pairAgent(); assert.equal(pairModel.planItemKey, key); assert.equal(pairModel.inputCandidate?.refId, candidate.refId); producerIds.push(pairModel.id); await pairFinish(pairModel);
        pairModel = await pairAgent(); const ctx = await runContext(pairPrincipal, pairModel.id); assert.ok("reviewTarget" in ctx);
        await recordRunEvent(await authenticateCampToken(pairModel.runToken), pairModel.id, { epoch: pairModel.epoch, type: "artifact", content: "Inspected", artifact: { type: "review", outcome: "approved", evidence: "Read candidate", candidate: ctx.reviewTarget! } }); await pairFinish(pairModel);
      }
      return producerIds;
    };
    const producerIds = await preparePairAttempt();
    const integrators = await Promise.all([claimRun(pairPrincipal, "pair-worker", createWorkerDeclaration()), claimRun(pairPrincipal, "pair-worker", createWorkerDeclaration())]);
    assert.equal(integrators.filter(Boolean).length, 1); const integrator = integrators.find(Boolean)!; if (integrator.executor !== "integration") throw new Error("Expected roleless integration");
    assert.deepEqual(integrator.integrationInput.parents.map(parent => parent.runId), producerIds);
    const integrationCompletion = { status: "completed" as const, summary: "Validated no-op integration", inputCandidate: candidate, candidate: pairOutput, changeSet: { schemaVersion: 1 as const, base: candidate, target: pairOutput, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } }, integration: { schemaVersion: 1 as const, inputDigest: integrator.inputDigest, algorithm: integrator.integrationInput.algorithm, policy: integrator.integrationInput.policy, status: "merged" as const, candidate: pairOutput, conflicts: [], truncated: false } };
    const pairSettlements = await Promise.all([completeRun(pairPrincipal, integrator.id, "pair-worker", integrator.epoch, integrationCompletion), completeRun(pairPrincipal, integrator.id, "pair-worker", integrator.epoch, integrationCompletion)]);
    assert.equal(pairSettlements.filter(result => result.replayed).length, 1);
    const pairOperations = await db.select().from(schema.campOperations).where(eq(schema.campOperations.goalId, pairGoal.goalId)); assert.equal(pairOperations.filter(operation => operation.kind === "integration").length, 1); assert.equal(pairOperations.filter(operation => operation.kind === "verification").length, 1);
    await assert.rejects(db.insert(schema.campOperations).values({ ...pairOperations.find(operation => operation.kind === "integration")!, id: randomUUID() }), (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint === "camp_operations_integration_attempt");

    const [freshPair] = await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, pairGoal.goalId)); assert.equal(freshPair.integrationInspectionRequired, false);
    await assert.rejects(db.update(schema.campGoals).set({ integrationInspectionRequired: true }).where(eq(schema.campGoals.id, goal3)), (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint === "camp_goals_integration_inspection_pair");
    await cancelGoal(pairRoom.id, pairGoal.goalId, owner.id);
    await retryGoal(pairRoom.id, pairGoal.goalId, owner.id, 1); await preparePairAttempt();
    const uncertain = await claimRun(pairPrincipal, "pair-worker", createWorkerDeclaration()); assert.ok(uncertain); assert.equal(uncertain.executor, "integration");
    await cancelGoal(pairRoom.id, pairGoal.goalId, owner.id);
    const cancelledUnknown = { status: "cancelled" as const, summary: "Resources cleaned but native outcome requires inspection", error: "camp_integration_inspection_required" };
    await completeRun(pairPrincipal, uncertain.id, "pair-worker", uncertain.epoch, cancelledUnknown);
    const [uncertainGoal] = await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, pairGoal.goalId));
    assert.equal(uncertainGoal.status, "cancelled"); assert.equal(uncertainGoal.reason, "cancelled_by_human"); assert.equal(uncertainGoal.integrationInspectionRequired, true);
    await assert.rejects(retryGoal(pairRoom.id, pairGoal.goalId, owner.id, 2), { code: "integration_inspection_required" });
    assert.equal((await completeRun(pairPrincipal, uncertain.id, "pair-worker", uncertain.epoch, cancelledUnknown)).replayed, true);
    // Reapply the exact migration backfill against pre-latch facts: cancellation
    // may hide the lifecycle reason, so the immutable run error is also authority.
    await db.update(schema.campGoals).set({ integrationInspectionRequired: false }).where(eq(schema.campGoals.id, pairGoal.goalId));
    const backfill = (await readFile(fileURLToPath(new URL("../../../drizzle/0382_camp_integration_inspection.sql", import.meta.url)), "utf8")).split("--> statement-breakpoint")[1];
    assert.ok(backfill); await db.execute(sql.raw(backfill));
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, pairGoal.goalId)))[0].integrationInspectionRequired, true);
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, goal3)))[0].integrationInspectionRequired, false);

    // Exercise the real amendment/deletion lock order with two connections.
    // The amendment passes its optimistic membership read, then deletion owns
    // the agent. It must still be able to release that agent's ordinary task;
    // a new task-before-agent lock in the shared writer would deadlock here.
    const [ordinaryAgent] = await db.insert(schema.agents).values({ serverId: server.id, name: "ordinary-lock-order", runtime: "external", model: "external" }).returning();
    await db.insert(schema.serverAgentMembers).values({ serverId: server.id, agentId: ordinaryAgent.id, role: "member" });
    await db.insert(schema.channelAgents).values({ channelId: channel3.id, agentId: ordinaryAgent.id });
    const ordinary = (await createTasks(channel3.id, "user", owner.id, [{ title: "Ordinary task lock order" }])).tasks[0];
    assert.notEqual(typeof await claimTask(ordinary.id, "agent", ordinaryAgent.id), "string");
    let agentHeld!: () => void, allowDelete!: () => void;
    const held = new Promise<void>(resolve => { agentHeld = resolve; });
    const deletionAllowed = new Promise<void>(resolve => { allowDelete = resolve; });
    let deletion: Promise<void> | undefined, deletionPid = 0;
    const registry = new InMemoryFailpointRegistry({ sleep: async () => {
      deletion = db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '2500ms'`);
        await tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, ordinaryAgent.id)).for("update");
        const pid = await tx.execute(sql`select pg_backend_pid() as pid`); deletionPid = Number(pid.rows[0].pid);
        agentHeld(); await deletionAllowed;
        await deleteAgent(ordinaryAgent.id, { executor: tx });
      });
      void deletion.catch(() => {});
      await held;
    } });
    registry.configure("server.task.amend.afterAuthorizationRead", { effect: "delay", payload: 0, mode: "once" });
    __setFailpointsForTests(registry);
    const amendment = amendTask(ordinary.id, { description: "Must not commit after the requester is deleted" }, "agent", ordinaryAgent.id).then(value => ({ value }), error => ({ error }));
    try {
      await held;
      let waiting = false;
      for (let poll = 0; poll < 100; poll++) {
        const blocked = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, deletionPid]);
        if (blocked.rows[0].count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "The amendment reached its second identity fence while deletion held that agent");
      allowDelete(); await deletion;
      const outcome = await amendment; assert.ok("value" in outcome, "No deadlock or lock-timeout error is allowed");
      assert.equal(outcome.value, "only current channel members with post access can amend the card");
      const [ordinaryAfter] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, ordinary.id));
      assert.equal(ordinaryAfter.claimedById, null); assert.equal(ordinaryAfter.description, null);
    } finally {
      allowDelete(); __resetFailpointsForTests(); await Promise.allSettled([amendment, deletion]);
    }


    // A claim includes a preliminary sweep. Even that sweep must acquire role
    // identities before canonical task locks when deletion owns the identity.
    const channel4 = await createChannel(server.id, "camp-delete-race"); await addHuman(channel4.id, owner.id);
    const room4 = await createRoom(server.id, owner.id, { channelId: channel4.id, name: "Camp delete race", project: { name: "race" } });
    await createPipeline(room4.id, owner.id, { title: "Recover without lock inversion", role: "planner" });
    const credential4 = await mintWorkerToken(room4.id, owner.id), principal4 = await authenticateCampToken(credential4.token);
    const old4 = (await claimRun(principal4, "old-worker"))! as CampAgentClaimedRun;
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, old4.id));
    let releaseDeletion!: () => void, campAgentHeld!: () => void, campDeletionPid = 0;
    const deletionMayProceed = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const campHeld = new Promise<void>(resolve => { campAgentHeld = resolve; });
    const campDeletion = db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2500ms'`);
      await tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, old4.agentId)).for("update");
      const pid = await tx.execute(sql`select pg_backend_pid() as pid`); campDeletionPid = Number(pid.rows[0].pid);
      campAgentHeld(); await deletionMayProceed; await deleteAgent(old4.agentId, { executor: tx });
    });
    void campDeletion.catch(() => {}); await campHeld;
    const campRecovery = claimRun(principal4, "replacement-worker").then(value => ({ value }), error => ({ error }));
    try {
      let waiting = false;
      for (let poll = 0; poll < 100; poll++) {
        const blocked = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid))", [database, campDeletionPid]);
        if (blocked.rows[0].count > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "Camp recovery reached its role identity fence");
      releaseDeletion(); await campDeletion;
      const outcome = await campRecovery; assert.ok("value" in outcome, "Camp sweep and deleteAgent cannot deadlock"); assert.equal(outcome.value, null);
      const [released] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, old4.taskId));
      assert.equal(released.claimedById, null, "Camp cannot restore ownership after the role identity was deleted");
      assert.equal((await db.select().from(schema.campRuns).where(eq(schema.campRuns.taskId, old4.taskId))).length, 1);
    } finally { releaseDeletion(); await Promise.allSettled([campDeletion, campRecovery]); }


  } finally {
    if (initialized) await closeDatabase();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});

test("migrations 375 through 380 preserve legacy probes without inventing worker readiness or original completion hashes", { skip: !(url || required), timeout: 120_000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL is required");
  const database = `camp_backfill_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  const folder = await mkdtemp(join(tmpdir(), "camp-374-"));
  await admin.connect();
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url); connection.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: connection.toString() });
    const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const old = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 374) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(old));
    for (const entry of old.entries) await symlink(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const owner = randomUUID(), server = randomUUID(), channel = randomUUID(), room = randomUUID();
    await pool.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'backfill-owner',$2,'test-only')", [owner, `${owner}@test.invalid`]);
    await pool.query("INSERT INTO servers(id,name,slug,owner_id) VALUES($1,'Backfill',$3,$2)", [server, owner, `backfill-${server}`]);
    await pool.query("INSERT INTO channels(id,server_id,name) VALUES($1,$2,'backfill')", [channel, server]);
    await pool.query("INSERT INTO camp_rooms(id,server_id,channel_id,name,project,roles,created_by_user_id) VALUES($1,$2,$3,'Backfill','{\"name\":\"legacy\"}','[]',$4)", [room, server, channel, owner]);
    const roles = ["planner", "builder", "reviewer", "builder", "reviewer", "planner"];
    const ids = roles.map(() => randomUUID());
    for (const [index, role] of roles.entries()) {
      await pool.query("INSERT INTO tasks(id,channel_id,task_number,title,status,created_by_type,created_by_id) VALUES($1,$2,$3,$4,$5,'user',$6)", [ids[index], channel, index + 1, `${role}: legacy ${index === 5 ? "probe" : "pipeline"}`, index === 5 ? "closed" : "done", owner]);
      await pool.query("INSERT INTO camp_tasks(task_id,room_id,role,depends_on,status) VALUES($1,$2,$3,$4,$5)", [ids[index], room, role, JSON.stringify(index === 0 || index === 5 ? [] : [ids[index - 1]]), index === 5 ? "cancelled" : "completed"]);
    }
    const before = (await pool.query("SELECT id,status,revision,title FROM tasks ORDER BY id")).rows;
    const through376 = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 376) };
    for (const entry of through376.entries.filter(entry => entry.idx > 374)) await symlink(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(through376));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const serialGoal = randomUUID(), oldAgent = randomUUID(), oldRun = randomUUID();
    await pool.query("INSERT INTO camp_goals(id,room_id,title,workflow,created_by_user_id) VALUES($1,$2,'Existing serial goal','serial',$3)", [serialGoal, room, owner]);
    await pool.query("INSERT INTO agents(id,server_id,name,runtime,model) VALUES($1,$2,'old-run-agent','external','external')", [oldAgent, server]);
    await pool.query("INSERT INTO camp_runs(id,room_id,task_id,role,agent_id,epoch,worker_id,run_token_hash,status,summary,lease_expires_at) VALUES($1,$2,$3,'planner',$4,1,'old-worker','test-only-no-secret','completed','Preserved legacy completion',now())", [oldRun, room, ids[0], oldAgent]);
    const through379 = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 379) };
    for (const entry of through379.entries.filter(entry => entry.idx > 376)) await symlink(join(migrationsFolder, entry.tag + ".sql"), join(folder, entry.tag + ".sql"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(through379));
    await migrate(drizzle(pool), { migrationsFolder: folder });
    await pool.query("INSERT INTO camp_workers(room_id,worker_id,last_run_id) VALUES($1,'old-worker',$2)", [room, oldRun]);
    const beforeWorkers = (await pool.query("SELECT worker_id,last_run_id,last_seen_at FROM camp_workers")).rows;
    await migrate(drizzle(pool), { migrationsFolder });
    const goals = (await pool.query("SELECT id,roles,status,workflow,protocol_version FROM camp_goals ORDER BY id")).rows;
    assert.equal(goals.length, 3);
    assert.equal(goals.find(goal => goal.id === serialGoal)?.protocol_version, 1);
    assert.ok(goals.filter(goal => goal.id !== serialGoal).every(goal => goal.protocol_version === null));
    assert.deepEqual((await pool.query("SELECT worker_protocol,executor,operation_id,change_set,verification,completion_payload_hash FROM camp_runs WHERE id=$1", [oldRun])).rows, [{ worker_protocol: null, executor: "agent", operation_id: null, change_set: null, verification: null, completion_payload_hash: null }]);
    await assert.rejects(pool.query("UPDATE camp_runs SET completion_payload_hash='invalid' WHERE id=$1", [oldRun]), { code: "23514" });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM camp_operations")).rows[0].count, 0);
    assert.deepEqual((await pool.query("SELECT worker_id,last_run_id,last_seen_at FROM camp_workers")).rows, beforeWorkers);
    assert.deepEqual((await pool.query("SELECT preflight_project_digest,preflight_report,preflight_observed_at FROM camp_workers")).rows, [{ preflight_project_digest: null, preflight_report: null, preflight_observed_at: null }]);
    await assert.rejects(pool.query("UPDATE camp_workers SET preflight_project_digest=$1", ["a".repeat(64)]), { code: "23514" });
    await assert.rejects(pool.query("UPDATE camp_workers SET preflight_project_digest='invalid',preflight_report='{}',preflight_observed_at=now()"), { code: "23514" });
    await assert.rejects(pool.query("UPDATE camp_workers SET preflight_project_digest=$1,preflight_report=$2,preflight_observed_at=now()", ["a".repeat(64), JSON.stringify({ excess: "x".repeat(32769) })]), { code: "23514" });
    assert.deepEqual(goals.find(goal => goal.id === ids[0])?.roles, ["planner", "builder", "reviewer"]);
    assert.deepEqual(goals.find(goal => goal.id === ids[5])?.roles, ["planner"]);
    assert.equal(goals.find(goal => goal.id === ids[0])?.status, "completed");
    assert.equal(goals.find(goal => goal.id === ids[5])?.status, "needs_attention");
    assert.ok(goals.filter(goal => goal.id !== serialGoal).every(goal => goal.workflow === "legacy"));
    const heads = (await pool.query("SELECT accepted_revision,accepted_goal_id,accepted_candidate FROM camp_rooms")).rows;
    assert.deepEqual(heads, [{ accepted_revision: 0, accepted_goal_id: null, accepted_candidate: null }]);
    for (const table of ["camp_plans", "camp_finalizations", "camp_questions"]) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    const bindings = (await pool.query("SELECT task_id,goal_id,kind FROM camp_tasks")).rows;
    for (const [index, role] of roles.entries()) assert.equal(bindings.find(binding => binding.task_id === ids[index])?.kind, role === "planner" ? "plan" : role === "builder" ? "build" : "review");
    for (const id of ids.slice(0, 5)) assert.equal(bindings.find(binding => binding.task_id === id)?.goal_id, ids[0]);
    assert.deepEqual((await pool.query("SELECT id,status,revision,title FROM tasks ORDER BY id")).rows, before);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
