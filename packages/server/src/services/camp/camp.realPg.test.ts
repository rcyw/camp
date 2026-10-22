import assert from "node:assert/strict";
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
import { createServer } from "../serverService";
import { addHuman, createChannel } from "../channelService";
import { createPipeline, createRoom, mintWorkerToken } from "./rooms";
import { authenticateCampToken, claimRun, claimRunDetailed, completeRun } from "./runs";
import { retryGoal } from "./goals";
import { reconcileCampPass } from "./reconcile";
import { CAMP_ROLES } from "./types";

const url = process.env.CAMP_REAL_PG_URL;
const required = process.env.CAMP_REAL_PG_REQUIRED === "1";

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
    await createPipeline(room.id, owner.id, { title: "One pipeline" });
    const credential = await mintWorkerToken(room.id, owner.id);
    const principal = await authenticateCampToken(credential.token);
    const raced = await Promise.all([claimRun(principal, "worker-1"), claimRun(principal, "worker-2")]);
    const winners = raced.filter(run => run !== null);
    assert.equal(winners.length, 1);
    const first = winners[0]!;
    assert.equal(first.role, "planner");
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, first.id));
    const recovered = await Promise.all([claimRun(principal, "recovery-1"), claimRun(principal, "recovery-2")]);
    const successors = recovered.filter(run => run !== null);
    assert.equal(successors.length, 1);
    const successor = successors[0]!;
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
    assert.equal(claim1.run.id, claim2.run.id);
    assert.equal(claim2.run.runToken, runToken);
    assert.equal((await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, submitted.goalId)))[0].runCount, 1);
    await completeRun(principal2, claim1.run.id, "stable-worker", claim1.run.epoch, { status: "failed", summary: "Known cleanup after worker interruption", error: "worker_interrupted" });
    const retried = await Promise.allSettled([retryGoal(room2.id, submitted.goalId, owner.id, 1), retryGoal(room2.id, submitted.goalId, owner.id, 1)]);
    assert.equal(retried.filter(result => result.status === "fulfilled").length, 1);
    const denied = retried.find(result => result.status === "rejected");
    assert.equal(denied?.status === "rejected" && denied.reason.code, "goal_attempt_changed");
    assert.equal((await db.select().from(schema.campTasks).where(eq(schema.campTasks.goalId, submitted.goalId))).length, 2);
    assert.deepEqual(await claimRunDetailed(principal2, "stable-worker", intent), { run: null, closed: true });
  } finally {
    if (initialized) await closeDatabase();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});

test("migration 375 preserves legacy single-role probes and groups rework descendants without changing canonical tasks", { skip: !(url || required), timeout: 120_000 }, async () => {
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
    await migrate(drizzle(pool), { migrationsFolder });
    const goals = (await pool.query("SELECT id,roles,status FROM camp_goals ORDER BY id")).rows;
    assert.equal(goals.length, 2);
    assert.deepEqual(goals.find(goal => goal.id === ids[0])?.roles, ["planner", "builder", "reviewer"]);
    assert.deepEqual(goals.find(goal => goal.id === ids[5])?.roles, ["planner"]);
    assert.equal(goals.find(goal => goal.id === ids[0])?.status, "completed");
    assert.equal(goals.find(goal => goal.id === ids[5])?.status, "needs_attention");
    const bindings = (await pool.query("SELECT task_id,goal_id FROM camp_tasks")).rows;
    for (const id of ids.slice(0, 5)) assert.equal(bindings.find(binding => binding.task_id === id)?.goal_id, ids[0]);
    assert.deepEqual((await pool.query("SELECT id,status,revision,title FROM tasks ORDER BY id")).rows, before);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
