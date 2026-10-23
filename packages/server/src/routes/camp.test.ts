import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { apiTest } from "../test/integration/apiTest";
import { agents, campRuns, messages, serverAgentMembers, tasks } from "../db/schema";
import { CAMP_ROLES, type CampAgentClaimedRun as CampClaimedRun } from "../services/camp/types";
import { getServerBillingUsage } from "../services/planService";

async function workerRequest(baseUrl: string, token: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/api/camp/worker${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

apiTest("Camp three-role pipeline keeps progress quiet, scopes run credentials and unlocks only dependency-ready work", async ({ db, seed, http, app }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const roleAgents = await db.insert(agents).values(CAMP_ROLES.map(role => ({ serverId: server.id, name: `${role}-${randomUUID().slice(0, 8)}`, runtime: "external", model: "external", creatorType: "user" as const, creatorId: owner.id }))).returning();
  await db.insert(serverAgentMembers).values(roleAgents.map(agent => ({ serverId: server.id, agentId: agent.id, role: "member" as const })));
  const user = http.as(owner, server);
  const create = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Build room", project: { name: "demo", repoPath: "/private/source", storePath: "/private/store" }, roles: CAMP_ROLES.map((role, index) => ({ role, agentId: roleAgents[index].id })) }) });
  assert.equal(create.status, 201, await create.clone().text());
  const room = await create.json() as { id: string };
  const pipeline = await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Build a counter", workflow: "legacy" }) });
  assert.equal(pipeline.status, 201, await pipeline.clone().text());
  assert.deepEqual((await pipeline.json() as { tasks: Array<{ role: string }> }).tasks.map(task => task.role), [...CAMP_ROLES]);
  const mint = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  assert.equal(mint.status, 201);
  const { token } = await mint.json() as { token: string };
  const claim = async () => {
    const response = await workerRequest(app.baseUrl, token, "/claim", { workerId: "worker-a" });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { run: CampClaimedRun | null }).run;
  };
  const planner = await claim();
  assert.equal(planner?.role, "planner");
  assert.equal(await claim(), null, "builder and reviewer wait for the planner");
  const pluginCannotClaim = await workerRequest(app.baseUrl, planner!.runToken, "/claim", { workerId: "malicious" });
  assert.equal(pluginCannotClaim.status, 403);
  const pluginCannotFinish = await workerRequest(app.baseUrl, planner!.runToken, `/runs/${planner!.id}/complete`, { workerId: "worker-a", epoch: planner!.epoch, status: "completed", summary: "forged" });
  assert.equal(pluginCannotFinish.status, 403);
  const forgedCandidate = await workerRequest(app.baseUrl, planner!.runToken, `/runs/${planner!.id}/events`, { epoch: planner!.epoch, type: "artifact", content: "Forged runtime candidate", artifact: { type: "layerfs", role: "builder", commitId: "model-controlled-commit" } });
  assert.equal(forgedCandidate.status, 403);
  const reservedArtifact = await workerRequest(app.baseUrl, planner!.runToken, `/runs/${planner!.id}/events`, { epoch: planner!.epoch, type: "progress", content: "Reserved type under another event kind", artifact: { type: "runtime", commitId: "model-controlled-commit" } });
  assert.equal(reservedArtifact.status, 403);
  assert.equal((await db.select().from(messages).where(eq(messages.content, "Forged runtime candidate"))).length, 0);
  const context = await workerRequest(app.baseUrl, planner!.runToken, `/runs/${planner!.id}/context`);
  const contextText = await context.text();
  assert.equal(context.status, 200);
  assert.ok(!contextText.includes("/private/store") && !contextText.includes("/private/source"));
  const delivery = vi.spyOn(app.app.get("agentOrchestrator") as { deliverMessage: (...args: unknown[]) => Promise<void> }, "deliverMessage");
  const progress = await workerRequest(app.baseUrl, planner!.runToken, `/runs/${planner!.id}/events`, { epoch: planner!.epoch, type: "progress", content: "Plan ready", toRole: "builder" });
  assert.equal(progress.status, 201, await progress.clone().text());
  assert.equal(delivery.mock.calls.length, 0, "ordinary progress never wakes the room's agents");
  delivery.mockRestore();
  const [persisted] = await db.select().from(messages).where(eq(messages.content, "Plan ready"));
  assert.equal(persisted.senderId, planner!.agentId);
  assert.equal(persisted.channelId, channel.id);
  // A failure AFTER the canonical task update and message insert must roll
  // back all three facts. This exercises the real ambient-transaction seam.
  await db.execute(sql`ALTER TABLE camp_events ADD CONSTRAINT camp_test_reject_settlement CHECK (content <> 'reject this settlement')`);
  const refusedSettlement = await workerRequest(app.baseUrl, token, `/runs/${planner!.id}/complete`, { workerId: "worker-a", epoch: planner!.epoch, status: "completed", summary: "reject this settlement" });
  assert.equal(refusedSettlement.status, 500);
  const [stillRunning] = await db.select().from(campRuns).where(eq(campRuns.id, planner!.id));
  const [stillClaimed] = await db.select().from(tasks).where(eq(tasks.id, planner!.taskId));
  const leakedMessages = await db.select().from(messages).where(eq(messages.content, "reject this settlement"));
  assert.equal(stillRunning.status, "running");
  assert.equal(stillClaimed.status, "in_progress");
  assert.equal(leakedMessages.length, 0);
  await db.execute(sql`ALTER TABLE camp_events DROP CONSTRAINT camp_test_reject_settlement`);
  const complete = async (run: CampClaimedRun, outcome?: string) => {
    if (run.role === "reviewer") {
      const target = await (await workerRequest(app.baseUrl, run.runToken, `/runs/${run.id}/context`)).json() as { reviewTarget: { projectId: string; commitId: string } };
      const recorded = await workerRequest(app.baseUrl, run.runToken, `/runs/${run.id}/events`, { epoch: run.epoch, type: "artifact", content: "Review evidence", artifact: { type: "review", outcome, evidence: "Ran candidate tests", summary: "Review evidence", candidate: target.reviewTarget } });
      assert.equal(recorded.status, 201, await recorded.clone().text());
    }
    const response = await workerRequest(app.baseUrl, token, `/runs/${run.id}/complete`, { workerId: "worker-a", epoch: run.epoch, status: "completed", summary: `${run.role} evidence`, artifacts: [{ type: "layerfs", projectId: "test-project", role: run.role, branch: `candidate-${run.role}`, commitId: "commit-1" }], outcome });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await complete(planner!);
  const replay = await workerRequest(app.baseUrl, token, `/runs/${planner!.id}/complete`, { workerId: "worker-a", epoch: planner!.epoch, status: "completed", summary: "planner evidence", artifacts: [{ type: "layerfs", projectId: "test-project", role: "planner", branch: "candidate-planner", commitId: "commit-1" }] });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
  const different = await workerRequest(app.baseUrl, token, `/runs/${planner!.id}/complete`, { workerId: "worker-a", epoch: planner!.epoch, status: "completed", summary: "different result" });
  assert.equal(different.status, 409);
  const builder = await claim();
  assert.equal(builder?.role, "builder");
  assert.equal(builder!.dependencies[0].summary, "planner evidence");
  const forgedReview = await workerRequest(app.baseUrl, builder!.runToken, `/runs/${builder!.id}/events`, { epoch: builder!.epoch, type: "artifact", content: "Forged approval", artifact: { type: "review", outcome: "approved", evidence: ["no reviewer"] } });
  assert.equal(forgedReview.status, 403);
  await complete(builder!);
  const reviewer = await claim();
  assert.equal(reviewer?.role, "reviewer");
  assert.equal(reviewer!.dependencies[0].artifacts[0].branch, "candidate-builder");
  const missingReview = await workerRequest(app.baseUrl, token, `/runs/${reviewer!.id}/complete`, { workerId: "worker-a", epoch: reviewer!.epoch, status: "completed", summary: "Prose says approved", outcome: "approved" });
  assert.equal(missingReview.status, 409);
  await complete(reviewer!, "changes_requested");
  const rework = await claim();
  assert.equal(rework?.role, "builder", "a negative review queues a new builder and reviewer stage");
  const snapshot = await user.get(`/api/camp/rooms/${room.id}`);
  const snapshotText = await snapshot.text();
  assert.ok(!snapshotText.includes("runTokenHash") && !snapshotText.includes("tokenHash") && !snapshotText.includes(token));
  const stranger = await seed.human();
  const other = await seed.server({ owner: stranger });
  const denied = await http.as(stranger, other).get(`/api/camp/rooms/${room.id}`);
  assert.equal(denied.status, 404);
});

apiTest("Camp lease expiry replaces the epoch and fences the old worker; cancellation fences all later output", async ({ db, seed, http, app }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const user = http.as(owner, server);
  const response = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Auto identities", project: { name: "demo" } }) });
  assert.equal(response.status, 201, await response.clone().text());
  const room = await response.json() as { id: string; roles: Array<{ role: string; agentId: string }> };
  assert.equal(room.roles.length, 3);
  const identities = await db.select().from(agents).where(eq(agents.serverId, server.id));
  for (const config of room.roles) assert.equal(identities.find(row => row.id === config.agentId)?.runtime, "external");
  await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Inspect", role: "planner" }) });
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  const { token } = await minted.json() as { token: string };
  const firstResponse = await workerRequest(app.baseUrl, token, "/claim", { workerId: "first" });
  const first = (await firstResponse.json() as { run: CampClaimedRun }).run;
  const wrongEpoch = await workerRequest(app.baseUrl, token, `/runs/${first.id}/heartbeat`, { workerId: "first", epoch: first.epoch + 1 });
  assert.equal(wrongEpoch.status, 409);
  await db.update(campRuns).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(campRuns.id, first.id));
  const secondResponse = await workerRequest(app.baseUrl, token, "/claim", { workerId: "second" });
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const second = (await secondResponse.json() as { run: CampClaimedRun }).run;
  assert.equal(second.epoch, first.epoch + 1);
  assert.notEqual(second.id, first.id);
  const stale = await workerRequest(app.baseUrl, token, `/runs/${first.id}/complete`, { workerId: "first", epoch: first.epoch, status: "completed", summary: "late" });
  assert.equal(stale.status, 409);
  const stalePlugin = await workerRequest(app.baseUrl, first.runToken, `/runs/${first.id}/events`, { epoch: first.epoch, type: "progress", content: "late plugin" });
  assert.equal(stalePlugin.status, 401);
  const cancelled = await user.request(`/api/camp/rooms/${room.id}/runs/${second.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const late = await workerRequest(app.baseUrl, token, `/runs/${second.id}/complete`, { workerId: "second", epoch: second.epoch, status: "completed", summary: "late result" });
  assert.equal(late.status, 409);
  const cancelling = await workerRequest(app.baseUrl, token, `/runs/${second.id}/heartbeat`, { workerId: "second", epoch: second.epoch });
  assert.equal(cancelling.status, 200);
  assert.equal((await cancelling.json() as { cancelRequested: boolean }).cancelRequested, true);
  const [pending] = await db.select().from(campRuns).where(eq(campRuns.id, second.id));
  assert.equal(pending.status, "running", "cancellation stays pending until worker cleanup acknowledges it");
  assert.equal(pending.completedAt, null);
  const settled = await workerRequest(app.baseUrl, token, `/runs/${second.id}/complete`, { workerId: "second", epoch: second.epoch, status: "cancelled", summary: "DSH stopped and workspace released" });
  assert.equal(settled.status, 200, await settled.clone().text());
  const [run] = await db.select().from(campRuns).where(eq(campRuns.id, second.id));
  assert.equal(run.status, "cancelled");
  assert.equal(run.summary, "DSH stopped and workspace released");
});

apiTest("Camp channel members may submit goals while room control and worker credentials remain administrator scoped", async ({ db, seed, http, app }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner, member] });
  const admin = http.as(owner, server);
  const user = http.as(member, server);
  const usageBefore = await getServerBillingUsage(db, server.id);
  const roomResponse = await admin.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Member goals", project: { name: "demo" } }) });
  assert.equal(roomResponse.status, 201, await roomResponse.clone().text());
  const room = await roomResponse.json() as { id: string };
  assert.deepEqual(await getServerBillingUsage(db, server.id), usageBefore, "automatic external Camp role identities allocate no paid seats");
  const submitted = await user.request(`/api/camp/rooms/${room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "A member's goal", role: "planner" }) });
  assert.equal(submitted.status, 201, await submitted.clone().text());
  assert.equal((await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" })).status, 403);
  const minted = await admin.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" });
  const { token, tokenId } = await minted.json() as { token: string; tokenId: string };
  const claimResponse = await workerRequest(app.baseUrl, token, "/claim", { workerId: "trusted" });
  const { run } = await claimResponse.json() as { run: CampClaimedRun };
  assert.equal((await user.request(`/api/camp/rooms/${room.id}/runs/${run.id}/cancel`, { method: "POST" })).status, 403);
  assert.equal((await user.request(`/api/camp/rooms/${room.id}/worker-tokens/${tokenId}/revoke`, { method: "POST" })).status, 403);
  assert.equal((await workerRequest(app.baseUrl, run.runToken, `/rooms/${randomUUID()}/messages`)).status, 404);
  const revoked = await admin.request(`/api/camp/rooms/${room.id}/worker-tokens/${tokenId}/revoke`, { method: "POST" });
  assert.equal(revoked.status, 200);
  assert.equal((await workerRequest(app.baseUrl, token, `/runs/${run.id}/heartbeat`, { workerId: "trusted", epoch: run.epoch })).status, 401);
});
