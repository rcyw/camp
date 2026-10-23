import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { campTasks, tasks } from "../db/schema";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import type { CampAgentClaimedRun } from "../services/camp/types";

const COMPLETE_LIMIT = 1024 * 1024, TOOL_LIMIT = 1024 * 1024, ROOM_LIMIT = 512 * 1024;
const baseline = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
const policy = { id: "checks", revision: 1, name: "Checks", maxRepairAttempts: 1, checks: [{ id: "node", label: "Node", argv: ["node", "--test"], timeoutMs: 1000 }] };
const pad = (value: unknown, bytes: number) => { const json = JSON.stringify(value); return json + " ".repeat(bytes - Buffer.byteLength(json)); };
async function fixture({ seed, http, app }: { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } }) {
  const owner = await seed.human(), server = await seed.server({ owner }), channel = await seed.channel({ server, members: [owner] });
  const user = http.as(owner, server);
  const created = await user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, name: "Body limits", project: { name: "fixture" } }) });
  assert.equal(created.status, 201, await created.clone().text()); const room = await created.json() as { id: string };
  const configure = (body: string) => user.request(`/api/camp/rooms/${room.id}/verification-policy`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
  assert.equal((await configure(JSON.stringify({ policy }))).status, 200);
  const minted = await user.request(`/api/camp/rooms/${room.id}/worker-token`, { method: "POST" }); const { token } = await minted.json() as { token: string };
  const raw = (path: string, body: string, credential: string | null = token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body });
  const post = (path: string, body: unknown, credential = token) => raw(path, JSON.stringify(body), credential);
  const claim = async () => { const response = await post("/claim", { workerId: "body-worker", protocol: createWorkerDeclaration() }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { run: CampAgentClaimedRun }).run; };
  return { owner, server, channel, user, room, configure, raw, post, claim };
}

apiTest("Camp real application accepts a legal large Unicode plan and cumulative diff above the default parser bound", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const goal = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Large valid report" }) }); assert.equal(goal.status, 201);
  const planner = await kit.claim();
  const items = Array.from({ length: 5 }, (_, index) => ({ key: `item-${index}`, title: "Valid", description: "中".repeat(4000), acceptance: "验".repeat(4000), verification: "测".repeat(4000) }));
  const plan = { workerId: "body-worker", runId: planner.id, epoch: planner.epoch, planRevision: 1, summary: "计".repeat(16000), tasks: items };
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) > 100 * 1024);
  const planned = await kit.post(`/runs/${planner.id}/plan`, plan, planner.runToken); assert.equal(planned.status, 200, await planned.clone().text());
  const completed = await kit.post(`/runs/${planner.id}/complete`, { workerId: "body-worker", epoch: planner.epoch, status: "completed", summary: "Plan ready", inputCandidate: baseline, candidate: baseline }); assert.equal(completed.status, 200, await completed.clone().text());
  const builder = await kit.claim();
  const target = { ...baseline, refKind: "commit", refId: `12${"d".repeat(64)}`, layerId: undefined, commitId: `12${"d".repeat(64)}`, rootId: "e".repeat(64), baseRef: baseline.refId };
  const entries = Array.from({ length: 12 }, (_, index) => ({ path: `file-${index}.txt`, change: "added", before: null, after: { type: "file", mode: 420, size: 12000, sha256: "f".repeat(64) }, binary: false, modeChanged: false, patch: "+" + "x".repeat(12000) + "\n", patchTruncated: false, previewReason: null }));
  const payload = { workerId: "body-worker", epoch: builder.epoch, status: "completed", summary: "Built", inputCandidate: baseline, candidate: target, changeSet: { schemaVersion: 1, base: baseline, target, entries, truncated: false, stats: { added: 12, modified: 0, deleted: 0, typeChanged: 0 } } };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 100 * 1024);
  const built = await kit.post(`/runs/${builder.id}/complete`, payload); assert.equal(built.status, 200, await built.clone().text());
  const replay = await kit.post(`/runs/${builder.id}/complete`, payload); assert.equal(replay.status, 200); assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
});

apiTest("Camp route-specific byte limits return JSON 413 and authenticate before parsing larger bodies", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), runId = randomUUID();
  for (const [path, limit] of [[`/runs/${runId}/complete`, COMPLETE_LIMIT], [`/runs/${runId}/finalize`, TOOL_LIMIT]] as const) {
    const at = await kit.raw(path, pad({}, limit)); assert.notEqual(at.status, 413);
    const over = await kit.raw(path, pad({}, limit + 1)); assert.equal(over.status, 413);
    assert.equal((await over.json() as { code: string; limitBytes: number }).code, "camp_body_too_large");
    assert.equal((await kit.raw(path, pad({}, limit + 1), null)).status, 401);
    assert.equal((await kit.raw(path, pad({}, limit + 1), "camp_worker_invalid")).status, 401);
  }
  assert.equal((await kit.configure(pad({ policy }, ROOM_LIMIT))).status, 200);
  const over = await kit.configure(pad({ policy }, ROOM_LIMIT + 1)); assert.equal(over.status, 413); assert.equal((await over.json() as { limitBytes: number }).limitBytes, ROOM_LIMIT);
  for (const path of ["/claim", `/runs/${runId}/complete-other`]) assert.equal((await kit.raw(path, pad({}, 180 * 1024))).status, 413, "Unrelated paths retain the global 100 KiB limit");
});

apiTest("Camp annotations have a bounded aggregate byte budget even when the larger completion parser accepts them", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app }), path = `/runs/${randomUUID()}/complete`;
  const response = await kit.post(path, { workerId: "body-worker", epoch: 1, status: "failed", summary: "Stopped", artifacts: [{ type: "file", content: "x".repeat(70000) }, { type: "file", content: "y".repeat(70000) }] });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json() as { code: string }).code, "invalid_input");
});

apiTest("Camp artifact events cannot accumulate beyond the bounded run context and completion envelope", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const created = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Bounded annotations", role: "planner" }) }); assert.equal(created.status, 201);
  const run = await kit.claim();
  const event = (content: string) => kit.post(`/runs/${run.id}/events`, { workerId: "body-worker", epoch: run.epoch, type: "artifact", content: "File evidence", artifact: { type: "file", content } }, run.runToken);
  assert.equal((await event("x".repeat(35000))).status, 201);
  const second = await event("y".repeat(35000)); assert.equal(second.status, 400); assert.equal((await second.json() as { code: string }).code, "artifact_budget_exhausted");
  const contextResponse = await fetch(`${app.baseUrl}/api/camp/worker/runs/${run.id}/context`, { headers: { Authorization: `Bearer ${run.runToken}` } }); assert.equal(contextResponse.status, 200);
  assert.equal((await contextResponse.json() as { artifacts: unknown[] }).artifacts.length, 1);
  const complete = await kit.post(`/runs/${run.id}/complete`, { workerId: "body-worker", epoch: run.epoch, status: "failed", summary: "Stopped after bounded reporting" }); assert.equal(complete.status, 200, await complete.clone().text());
});

apiTest("Camp reserves one trusted candidate slot after thirty model annotations and can still complete", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  assert.equal((await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Full annotations", role: "planner" }) })).status, 201);
  const run = await kit.claim();
  for (let index = 0; index < 30; index++) {
    const response = await kit.post(`/runs/${run.id}/events`, { epoch: run.epoch, type: "artifact", content: `File ${index}`, artifact: { type: "file", path: `file-${index}`, content: "x".repeat(2000) } }, run.runToken); assert.equal(response.status, 201, await response.clone().text());
  }
  const modelOverflow = await kit.post(`/runs/${run.id}/events`, { epoch: run.epoch, type: "artifact", content: "Overflow", artifact: { type: "file", path: "overflow" } }, run.runToken); assert.equal(modelOverflow.status, 400);
  const candidateEvent = { workerId: "body-worker", epoch: run.epoch, type: "artifact", content: "Saved immutable candidate", artifact: baseline };
  const host = await kit.post(`/runs/${run.id}/events`, candidateEvent); assert.equal(host.status, 201, await host.clone().text());
  assert.equal((await kit.post(`/runs/${run.id}/events`, candidateEvent)).status, 400, "Trusted infrastructure reports are bounded too");
  const complete = await kit.post(`/runs/${run.id}/complete`, { workerId: "body-worker", epoch: run.epoch, status: "completed", summary: "All evidence retained", inputCandidate: baseline, candidate: baseline, artifacts: [baseline] }); assert.equal(complete.status, 200, await complete.clone().text());
  const result = await complete.json() as { run: { artifacts: unknown[] } }; assert.equal(result.run.artifacts.length, 31);
});

apiTest("Camp scoped parsers accept legitimate six-byte JSON escapes in room instructions and final summaries", async ({ seed, http, app }) => {
  const kit = await fixture({ seed, http, app });
  const channel = await seed.channel({ server: kit.server, members: [kit.owner] });
  const roomBody = JSON.stringify({ channelId: channel.id, name: "Escaped instructions", project: { name: "fixture" }, roles: ["planner", "builder", "reviewer"].map(role => ({ role, instructions: "\u0001".repeat(16000) })) });
  assert.ok(Buffer.byteLength(roomBody) > 256 * 1024);
  const room = await kit.user.request("/api/camp/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: roomBody }); assert.equal(room.status, 201, await room.clone().text());
  const summary = { workerId: "body-worker", epoch: 1, summary: "\u0001".repeat(16000), evidence: "\u0001".repeat(16000), remaining: Array.from({ length: 20 }, () => "\u0001".repeat(4000)) };
  const body = JSON.stringify(summary); assert.ok(Buffer.byteLength(body) > 512 * 1024);
  const response = await kit.raw(`/runs/${randomUUID()}/finalize`, body); assert.equal(response.status, 409, await response.clone().text()); assert.equal((await response.json() as { code: string }).code, "stale_run", "The valid payload reaches the authenticated lifecycle fence");
});

apiTest("Camp accepts a legal escaped goal with the maximum hundred in-Room task dependencies", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const seeded = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Seed prior dependencies", role: "planner" }) }); assert.equal(seeded.status, 201);
  const { goals } = await seeded.json() as { goals: Array<{ id: string }> };
  const ids = Array.from({ length: 100 }, () => randomUUID());
  await db.insert(tasks).values(ids.map((id, index) => ({ id, channelId: kit.channel.id, taskNumber: index + 2, title: `Prior task ${index}`, status: "done" as const, createdByType: "user" as const, createdById: kit.owner.id })));
  await db.insert(campTasks).values(ids.map(taskId => ({ taskId, roomId: kit.room.id, goalId: goals[0].id, goalAttempt: 1, role: "planner" as const, kind: "plan" as const, status: "completed" as const })));
  const body = JSON.stringify({ title: "\u0001".repeat(500), description: "\u0001".repeat(16000), role: "planner", dependsOn: ids }); assert.ok(Buffer.byteLength(body) > 100 * 1024);
  const response = await kit.user.request(`/api/camp/rooms/${kit.room.id}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body }); assert.equal(response.status, 201, await response.clone().text());
});
