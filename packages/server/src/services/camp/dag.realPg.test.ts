import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import { test } from "vitest";
import { createWorkerDeclaration, type CampCandidate } from "../../../../camp-protocol/src/index.js";
import * as schema from "../../db/schema";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { createServer } from "../serverService";
import { addHuman, createChannel } from "../channelService";
import { createPipeline, createRoom, mintWorkerToken } from "./rooms";
import { authenticateCampToken, claimRunDetailed, completeRun, recordRunEvent, runContext } from "./runs";
import { submitPlan } from "./plans";
import { setVerificationPolicy } from "./verification";
import { reconcileCampPass } from "./reconcile";
import { retryGoal } from "./goals";
import type { CampAgentClaimedRun } from "./types";
const url = process.env.CAMP_REAL_PG_URL, required = process.env.CAMP_REAL_PG_REQUIRED === "1";
test("real PostgreSQL serializes DAG scoped fan-in, final budget debit and unknown-native recovery across both pool lanes", { skip: !(url || required), timeout: 120000 }, async () => {
  assert.ok(url, "CAMP_REAL_PG_URL required"); const name = `camp_dag_${randomUUID().replaceAll("-", "")}`, admin = new pg.Client({ connectionString: url }); await admin.connect(); let initialized = false;
  const connection = new URL(url); connection.pathname = `/${name}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); const pool = new pg.Pool({ connectionString: connection.toString() });
    try { await migrate(drizzle(pool, { schema }), { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) }); } finally { await pool.end(); }
    await initDatabase(connection.toString()); initialized = true; const db = getDb();
    const [owner] = await db.insert(schema.users).values({ name: "dag-owner", email: `${name}@test.invalid`, passwordHash: "test-only", emailVerified: true }).returning();
    const server = await createServer("Graph fixture", name, owner.id), channel = await createChannel(server.id, "graph-test"); await addHuman(channel.id, owner.id);
    const room = await createRoom(server.id, owner.id, { channelId: channel.id, name: "Graph", project: { name: "fixture" } });
    await setVerificationPolicy(room.id, owner.id, { id: "acceptance", revision: 1, name: "Acceptance", checks: [{ id: "check", label: "Check", argv: ["true"], timeoutMs: 1000 }], maxRepairAttempts: 1 });
    const submission = await createPipeline(room.id, owner.id, { title: "Two reviewed parents feed a third node", planMode: "bounded_dag", budget: { maxRuns: 6 } });
    const token = await mintWorkerToken(room.id, owner.id), principal = await authenticateCampToken(token.token), executionPool = { poolId: randomUUID(), storageId: "1".repeat(64), maxParallel: 2 as const, workerIds: ["lane-1", "lane-2"], resources: { maxContainers: 4 as const, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } }, declaration = { ...createWorkerDeclaration(), executionPool };
    const claim = async (workerId = "lane-1") => (await claimRunDetailed(principal, workerId, undefined, declaration)).run;
    const baseline: CampCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
    const planner = await claim() as CampAgentClaimedRun; assert.equal(planner.protocolVersion, 5);
    const item = (key: string, dependsOnKeys: string[]) => ({ key, title: key, description: key, acceptance: key, verification: key, dependsOnKeys });
    await submitPlan(principal, planner.id, { epoch: planner.epoch, workerId: "lane-1", planRevision: 2, summary: "Bounded fan-in", tasks: [item("a", []), item("b", []), item("c", ["a", "b"])] });
    await completeRun(principal, planner.id, "lane-1", planner.epoch, { status: "completed", summary: "Plan", inputCandidate: baseline, candidate: { ...baseline, baseRef: baseline.refId } });
    const builds = await Promise.all([claim(), claim("lane-2")]) as CampAgentClaimedRun[]; assert.equal(builds.filter(Boolean).length, 2);
    for (const [index, build] of builds.entries()) {
      const refId = `12${String(index + 1).repeat(64)}`, candidate: CampCandidate = { ...baseline, refKind: "commit", refId, layerId: undefined, commitId: refId, rootId: String(index + 2).repeat(64), baseRef: baseline.refId };
      await completeRun(principal, build.id, `lane-${index + 1}`, build.epoch, { status: "completed", summary: "Build", inputCandidate: baseline, candidate, changeSet: { schemaVersion: 1, base: baseline, target: candidate, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } } });
    }
    for (let index = 0; index < 2; index++) {
      const reviewer = await claim() as CampAgentClaimedRun, context = await runContext(principal, reviewer.id); assert.ok("reviewTarget" in context);
      await recordRunEvent(principal, reviewer.id, { workerId: "lane-1", epoch: reviewer.epoch, type: "artifact", content: "Approved", artifact: { type: "review", outcome: "approved", evidence: "Exact reviewed input", candidate: context.reviewTarget! } });
      const completion = { status: "completed" as const, summary: "Reviewed", outcome: "approved" as const, inputCandidate: reviewer.inputCandidate!, candidate: { ...reviewer.inputCandidate!, baseRef: reviewer.inputCandidate!.refId } };
      const settled = await Promise.all([completeRun(principal, reviewer.id, "lane-1", reviewer.epoch, completion), completeRun(principal, reviewer.id, "lane-1", reviewer.epoch, completion)]); assert.equal(settled.filter(result => result.replayed).length, 1);
    }
    const operations = await db.select().from(schema.campOperations); assert.equal(operations.length, 1); assert.equal(operations[0].scope, "node_input"); assert.equal(operations[0].planItemKey, "c");
    const finalBudget = await Promise.all([claim(), claim("lane-2")]); assert.equal(finalBudget.filter(Boolean).length, 1); const run = finalBudget.find(Boolean)!; assert.equal(run.executor, "integration");
    const [goal] = await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, submission.goalId)); assert.equal(goal.runCount, 6);
    await db.update(schema.campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.campRuns.id, run.id)); await reconcileCampPass();
    const [fenced] = await db.select().from(schema.campGoals).where(eq(schema.campGoals.id, goal.id)); assert.equal(fenced.integrationInspectionRequired, true); assert.equal(fenced.status, "needs_attention"); assert.equal(await claim(), null); await assert.rejects(retryGoal(room.id, goal.id, owner.id, 1), { code: "integration_inspection_required" });
    assert.equal((await db.select().from(schema.campRuns)).length, 6);
  } finally { if (initialized) await closeDatabase(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
});
