import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campGoals, campRuns, campTasks, tasks, taskEvents } from "../db/schema";
import { getDb } from "../db/index";
import * as taskService from "../services/taskService";
import { lockRoom } from "../services/camp/rooms";
import { withCampTaskMutation } from "../services/camp/taskAuthority";
import { reconcileCampPass } from "../services/camp/reconcile";
import type { CampAgentClaimedRun as CampClaimedRun } from "../services/camp/types";

type Context = { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } };
async function fixture({ seed, http, app }: Context, workflow: "legacy" | "serial" = "legacy") {
  const owner = await seed.human(), server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] }), user = http.as(owner, server);
  const post = (path: string, body: unknown = {}) => user.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/camp/rooms", { channelId: channel.id, name: "Camp owner", project: { name: "fixture" } });
  assert.equal(created.status, 201, await created.clone().text()); const room = await created.json() as { id: string };
  if (workflow === "serial") {
    const configured = await user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: { id: "owner-checks", revision: 1, name: "Owner checks", maxRepairAttempts: 1, checks: [{ id: "node-tests", label: "Node tests", argv: ["node", "--test"], timeoutMs: 120000 }] } }) });
    assert.equal(configured.status, 200, await configured.clone().text());
  }
  const submitted = await post(`/api/camp/rooms/${room.id}/tasks`, { title: "Only the Camp worker owns this task", ...(workflow === "legacy" ? { role: "planner" } : {}) });
  assert.equal(submitted.status, 201, await submitted.clone().text()); const initial = await submitted.json() as { tasks: Array<{ id: string; taskNumber: number }>; goals: Array<{ id: string }> };
  // Retain coverage of pre-verification serial goals across an upgrade;
  // v2 roleless operation ownership is exercised by camp.verification.test.ts.
  if (workflow === "serial") await getDb().update(campGoals).set({ protocolVersion: 1, verificationPolicy: null }).where(eq(campGoals.id, initial.goals[0].id));
  const minted = await post(`/api/camp/rooms/${room.id}/worker-token`), { token } = await minted.json() as { token: string };
  const worker = (path: string, body?: unknown, credential = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const claim = async () => { const response = await worker("/claim", { workerId: "owner-worker", ...(workflow === "serial" ? { protocol: createWorkerDeclaration() } : {}) }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { run: CampClaimedRun | null }).run; };
  const mutate = (taskId: string, verb: string, body: unknown = {}) => user.request(`/api/tasks/${taskId}${verb === "delete" ? "" : `/${verb}`}`, { method: verb === "delete" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { owner, user, channel, room, initial, post, worker, claim, mutate };
}
async function denied(response: Response) {
  assert.equal(response.status, 409, await response.clone().text());
  const error = await response.json() as { code: string; error: string };
  assert.equal(error.code, "camp_task_owned"); assert.match(error.error, /Camp/);
}

apiTest("Camp canonical tasks reject ordinary queued and running claim, assign, unclaim, status and deletion for both workflows", async ({ db, seed, http, app }) => {
  for (const workflow of ["legacy", "serial"] as const) {
    const kit = await fixture({ seed, http, app }, workflow), taskId = kit.initial.tasks[0].id;
    let before = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    await denied(await kit.mutate(taskId, "claim", { campAuthority: { roomId: kit.room.id, taskId }, internal: true }));
    await denied(await kit.mutate(taskId, "assignee", { assignee: { type: "user", id: kit.owner.id } }));
    await denied(await kit.mutate(taskId, "unclaim"));
    for (const status of ["in_progress", "done", "closed"]) await denied(await kit.mutate(taskId, "status", { status }));
    await denied(await kit.mutate(taskId, "delete"));
    await assert.rejects(taskService.batchClaimTasks(kit.channel.id, [before.taskNumber], "user", kit.owner.id), { code: "camp_task_owned" });
    await assert.rejects(taskService.amendTask(taskId, { description: "Ignore the accepted plan" }, "user", kit.owner.id), { code: "camp_task_owned" });
    await assert.rejects(taskService.deleteLegacyTask(taskId), { code: "camp_task_owned" });
    assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0], before);
    const run = (await kit.claim())!; assert.equal(run.taskId, taskId);
    before = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    await denied(await kit.mutate(taskId, "claim"));
    await denied(await kit.mutate(taskId, "assignee", { assignee: null }));
    await denied(await kit.mutate(taskId, "assignee", { assignee: { type: "agent", id: run.agentId } }));
    await denied(await kit.mutate(taskId, "status", { status: "closed" }));
    await assert.rejects(taskService.forceUpdateTaskStatus(taskId, "done", "user", kit.owner.id), { code: "camp_task_owned" });
    assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0], before);
    const cancel = await kit.post(`/api/camp/rooms/${kit.room.id}/goals/${run.goalId}/cancel`); assert.equal(cancel.status, 200, await cancel.clone().text());
    const heartbeat = await kit.worker(`/runs/${run.id}/heartbeat`, { workerId: "owner-worker", epoch: run.epoch }); assert.equal(heartbeat.status, 200); assert.equal((await heartbeat.json() as { cancelRequested: boolean }).cancelRequested, true);
    const stopped = await kit.worker(`/runs/${run.id}/complete`, { workerId: "owner-worker", epoch: run.epoch, status: "cancelled", summary: "Worker removed the sandbox" }); assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status, "closed");
    assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, run.goalId)))[0].status, "cancelled");
    assert.equal((await db.select().from(campTasks).where(eq(campTasks.taskId, taskId))).length, 1, "ordinary delete cannot erase the durable binding");
  }
});

apiTest("Camp authority is exact Room/task scope and expires before detached asynchronous work can mutate", async ({ db, seed, http, app }) => {
  const first = await fixture({ seed, http, app }), second = await fixture({ seed, http, app });
  const taskId = first.initial.tasks[0].id, otherId = second.initial.tasks[0].id;
  await assert.rejects(withCampTaskMutation(first.room.id, taskId, () => taskService.assignTask(taskId, null, "user", first.owner.id)), /requires the lifecycle transaction/);
  await getDb().transaction(async tx => {
    await lockRoom(tx, first.room.id);
    await assert.rejects(withCampTaskMutation(second.room.id, taskId, () => taskService.assignTask(taskId, null, "user", first.owner.id)), { code: "camp_task_owned" });
    await assert.rejects(withCampTaskMutation(first.room.id, taskId, () => taskService.assignTask(otherId, null, "user", first.owner.id)), { code: "camp_task_owned" });
    let release!: () => void, detached!: Promise<unknown>;
    await withCampTaskMutation(first.room.id, taskId, async () => {
      assert.notEqual(typeof await taskService.assignTask(taskId, null, "user", first.owner.id), "string");
      detached = new Promise<void>(resolve => { release = resolve; }).then(() => taskService.forceUpdateTaskStatus(taskId, "closed", "user", first.owner.id));
    });
    release(); await assert.rejects(detached, { code: "camp_task_owned" });
  });
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0].status, "todo");
  assert.equal((await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId))).length, 1);
});

apiTest("Camp refuses to steal an unexpected queued owner and a live lease stops immediately after canonical drift", async ({ db, seed, http, app }) => {
  const queued = await fixture({ seed, http, app }), queuedId = queued.initial.tasks[0].id;
  await db.update(tasks).set({ claimedByType: "user", claimedById: queued.owner.id }).where(eq(tasks.id, queuedId));
  const original = (await db.select().from(tasks).where(eq(tasks.id, queuedId)))[0];
  assert.equal(await queued.claim(), null);
  assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, queuedId)))[0], original);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, queued.initial.goals[0].id)))[0].reason, "canonical_task_changed");
  const active = await fixture({ seed, http, app }), run = (await active.claim())!;
  const before = (await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0];
  await db.update(tasks).set({ claimedByType: "user", claimedById: active.owner.id, status: "in_review" }).where(eq(tasks.id, run.taskId));
  const drifted = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
  for (const [path, body, token] of [
    [`/runs/${run.id}/heartbeat`, { workerId: "owner-worker", epoch: run.epoch }, undefined],
    [`/runs/${run.id}/context`, undefined, run.runToken],
    [`/runs/${run.id}/events`, { epoch: run.epoch, type: "progress", content: "Continue incorrectly" }, run.runToken],
    [`/runs/${run.id}/complete`, { workerId: "owner-worker", epoch: run.epoch, status: "completed", summary: "Invalid canonical owner" }, undefined],
  ] as const) {
    const response = await active.worker(path, body, token); assert.equal(response.status, 409, await response.clone().text()); assert.equal((await response.json() as { code: string }).code, "canonical_task_changed");
  }
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0].leaseExpiresAt.getTime(), before.leaseExpiresAt.getTime(), "a failed heartbeat cannot extend the lease");
  await reconcileCampPass();
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, run.goalId)))[0].reason, "canonical_task_changed");
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run.id));
  await reconcileCampPass();
  assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, run.taskId)))[0], drifted, "neither takeover nor expiry cleanup may overwrite the unexpected canonical owner");
  assert.equal(await active.claim(), null);
});

apiTest("Camp trusted workers cannot renew or complete model work after the role loses channel membership", async ({ db, seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), run = (await kit.claim())!;
  const before = (await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0];
  const removed = await kit.user.request(`/api/channels/${kit.channel.id}/members/agent/${run.agentId}`, { method: "DELETE" });
  assert.equal(removed.status, 200, await removed.clone().text());
  const heartbeat = await kit.worker(`/runs/${run.id}/heartbeat`, { workerId: "owner-worker", epoch: run.epoch });
  const completion = await kit.worker(`/runs/${run.id}/complete`, { workerId: "owner-worker", epoch: run.epoch, status: "completed", summary: "Must not accept a removed role's late result" });
  assert.deepEqual({ heartbeat: heartbeat.status, completion: completion.status }, { heartbeat: 403, completion: 403 });
  const after = (await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0];
  assert.equal(after.leaseExpiresAt.getTime(), before.leaseExpiresAt.getTime()); assert.equal(after.status, "running"); assert.equal(after.summary, null);
  await reconcileCampPass();
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.id, run.goalId)))[0].reason, "role_unavailable");
  const cancelled = await kit.worker(`/runs/${run.id}/complete`, { workerId: "owner-worker", epoch: run.epoch, status: "cancelled", summary: "The removed role's sandbox was cleaned" });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, run.id)))[0].status, "cancelled");
});

apiTest("Deleted channels reconcile already-closed Camp tasks, including suspended human questions and live lease cleanup", async ({ db, seed, http, app }) => {
  for (const mode of ["queued", "running", "waiting_question"] as const) {
    const kit = await fixture({ seed, http, app }, mode === "waiting_question" ? "serial" : "legacy");
    const taskId = kit.initial.tasks[0].id;
    let run: CampClaimedRun | null = null;
    if (mode !== "queued") run = (await kit.claim())!;
    if (mode === "waiting_question") {
      const questionId = "2c3436cc-f3a7-49dd-8b29-637dbdf40f1b";
      const asked = await kit.worker(`/runs/${run!.id}/questions`, { workerId: "owner-worker", runId: run!.id, epoch: run!.epoch, questionId, content: "A human must choose the requirement", toRole: "planner", needsHuman: true }, run!.runToken);
      assert.equal(asked.status, 200, await asked.clone().text());
      const candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
      const suspended = await kit.worker(`/runs/${run!.id}/complete`, { workerId: "owner-worker", epoch: run!.epoch, status: "suspended", summary: "Sandbox removed while waiting for a decision", questionId, inputCandidate: candidate, candidate });
      assert.equal(suspended.status, 200, await suspended.clone().text());
    }
    const deleted = await kit.user.request(`/api/channels/${kit.channel.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const canonical = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]; assert.equal(canonical.status, "closed");
    await reconcileCampPass(); await reconcileCampPass();
    const goal = (await db.select().from(campGoals).where(eq(campGoals.id, kit.initial.goals[0].id)))[0];
    assert.equal(goal.status, "needs_attention"); assert.equal(goal.reason, "channel_unavailable");
    if (mode === "running") {
      assert.ok((await db.select().from(campRuns).where(eq(campRuns.id, run!.id)))[0].cancelRequestedAt);
      await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, run!.id));
      await reconcileCampPass();
      assert.equal((await db.select().from(campRuns).where(eq(campRuns.id, run!.id)))[0].status, "cancelled");
    }
    assert.deepEqual((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0], canonical, "projecting an already-closed canonical row cannot append revisions or events");
    assert.ok(!["queued", "running", "waiting_question"].includes((await db.select().from(campTasks).where(eq(campTasks.taskId, taskId)))[0].status));
  }
});
