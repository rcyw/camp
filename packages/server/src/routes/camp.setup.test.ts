import assert from "node:assert/strict";
import { CAMP_PREFLIGHT_CHECK_IDS, createWorkerDeclaration, type CampPreflightReport } from "../../../camp-protocol/src/index.js";
import { eq, sql } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import { campEvents, campGoals, campRooms, campRuns, campWorkers } from "../db/schema";
import { projectDigest } from "../services/camp/setup";
import type { CampAgentClaimedRun } from "../services/camp/types";

type Context = { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string } };
type Setup = { roomId: string; project: { name: string; repoPath?: string; baseRef?: string }; projectDigest: string; projectMutable: boolean };
const report: CampPreflightReport = {
  schemaVersion: 1, workerVersion: "0.4.0", mode: "verification", modelConfigured: false,
  toolchainDigest: "a".repeat(64), imageId: "sha256:" + "b".repeat(64),
  checks: CAMP_PREFLIGHT_CHECK_IDS.map(id => ({ id, status: id === "model" || id === "plugin" ? "skipped" : "passed", code: id === "model" || id === "plugin" ? "not_required" : "ok" })),
};
async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}
async function fixture({ seed, http, app }: Context) {
  const owner = await seed.human(), member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner, member] });
  const user = http.as(owner, server), memberClient = http.as(member, server);
  const write = (path: string, body: unknown, client = user, method = "POST") => client.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const room = await json<{ id: string }>(await write("/api/camp/rooms", { channelId: channel.id, name: "First worker setup", project: { name: "Setup fixture", repoPath: "/operator/project", baseRef: "main" } }), 201);
  const prefix = "/api/camp/rooms/" + room.id;
  const { token, tokenId } = await json<{ token: string; tokenId: string }>(await write(prefix + "/worker-token", {}), 201);
  const worker = (path: string, body?: unknown, credential = token) => fetch(app.baseUrl + "/api/camp/worker" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setup = () => worker("/setup").then(value => json<Setup>(value));
  const preflight = (digest: string, value: unknown = report, workerId = "setup-worker") => worker("/preflight", { workerId, projectDigest: digest, report: value });
  const update = (project: unknown, expectedDigest: string, client = user) => write(prefix + "/project", { project, expectedDigest }, client, "PUT");
  const submit = () => write(prefix + "/tasks", { title: "Explicit legacy setup probe", role: "planner" });
  const snapshot = () => user.get(prefix);
  return { owner, server, channel, user, memberClient, room, token, tokenId, prefix, write, worker, setup, preflight, update, submit, snapshot };
}

apiTest("Camp setup discovery and authenticated preflight never allocate work or spend execution budget", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app });
  const setup = await kit.setup(); assert.equal(setup.roomId, kit.room.id); assert.equal(setup.projectMutable, true);
  assert.equal(setup.projectDigest, projectDigest({ baseRef: "main", repoPath: "/operator/project", name: "Setup fixture" }));
  assert.equal((await db.select().from(campWorkers)).length, 0, "Read-only setup does not register a worker");
  await json(await kit.submit(), 201);
  const before = (await db.select().from(campGoals))[0];
  const eventCount = (await db.select().from(campEvents)).length;
  const observed = await json<{ readiness: { selfReported: boolean; observedAt: string; report: CampPreflightReport } }>(await kit.preflight(setup.projectDigest));
  assert.equal(observed.readiness.selfReported, true); assert.equal(observed.readiness.report.modelConfigured, false);
  const [{ now }] = await db.select({ now: sql<string>`clock_timestamp()::text` }).from(campRooms).limit(1);
  assert.ok(Math.abs(Date.parse(observed.readiness.observedAt) - Date.parse(now)) < 10_000, "Observation time comes from the database");
  const after = (await db.select().from(campGoals))[0]; assert.equal(after.runCount, before.runCount); assert.equal(after.startedAt, null); assert.equal(after.status, "queued");
  assert.equal((await db.select().from(campRuns)).length, 0); assert.equal((await db.select().from(campEvents)).length, eventCount);
  const [registry] = await db.select().from(campWorkers); assert.equal(registry.lastRunId, null); assert.equal(registry.lastClaimAt, null); assert.equal(registry.declaration, null);
  const state = await json<{ setup: { projectMutable: boolean; readiness: { selfReported: boolean; observedAt: string } }; canSubmit: boolean; workers: Array<{ preflight: unknown }> }>(await kit.snapshot());
  assert.equal(state.setup.projectMutable, false); assert.equal(state.canSubmit, true); assert.equal(state.setup.readiness.selfReported, true); assert.ok(state.workers[0].preflight);
});

apiTest("Camp preflight is a bounded last self-report and preserves negotiated worker observations", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), setup = await kit.setup();
  await json(await kit.submit(), 201);
  await json(await kit.worker("/claim", { workerId: "setup-worker", protocol: { ...createWorkerDeclaration(), taskKinds: ["verification"] } }));
  const [prior] = await db.select().from(campWorkers);
  assert.ok(prior?.declaration); assert.equal((await db.select().from(campRuns)).length, 0);
  await json(await kit.preflight(setup.projectDigest));
  const failed = { ...report, checks: report.checks.map(check => check.id === "source" ? { ...check, status: "failed", code: "source_missing" } : check) };
  await json(await kit.preflight(setup.projectDigest, failed));
  const rows = await db.select().from(campWorkers); assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].declaration, prior?.declaration ?? null); assert.equal(rows[0].lastRunId, null);
  assert.equal(rows[0].preflightReport?.checks.find(check => check.id === "source")?.status, "failed");
  for (const invalid of [{ ...report, details: "/host/private" }, { ...report, checks: report.checks.slice(1) }, { ...report, observedAt: "2099-01-01" }, { ...report, checks: report.checks.map(check => ({ ...check, message: "arbitrary diagnostic" })) }, { ...report, workerVersion: "x".repeat(32769) }]) {
    await json(await kit.preflight(setup.projectDigest, invalid), 400);
  }
  assert.equal((await db.select().from(campWorkers)).length, 1); assert.equal((await db.select().from(campRuns)).length, 0);
});

apiTest("Camp setup and preflight accept only a live room worker capability, never a run or human credential", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), setup = await kit.setup();
  await json(await kit.submit(), 201);
  const { run } = await json<{ run: CampAgentClaimedRun }>(await kit.worker("/claim", { workerId: "owner-worker", protocol: createWorkerDeclaration() }));
  await json(await kit.worker("/setup", undefined, run.runToken), 403);
  await json(await kit.worker("/preflight", { workerId: "owner-worker", projectDigest: setup.projectDigest, report }, run.runToken), 403);
  await json(await kit.user.get("/api/camp/worker/setup"), 401);
  await json(await kit.worker("/preflight", { workerId: "setup-worker", projectDigest: setup.projectDigest, report, roomId: kit.room.id }), 400);
  await json(await kit.preflight("f".repeat(64)), 409);
  assert.equal((await db.select().from(campWorkers)).every(row => row.preflightReport === null), true);
  await json(await kit.write(kit.prefix + "/worker-tokens/" + kit.tokenId + "/revoke", {}));
  await json(await kit.worker("/setup"), 401); await json(await kit.preflight(setup.projectDigest), 401);
});

apiTest("Camp project changes require admin CAS and retain old report identities without exposing Docker configuration", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), initial = await kit.setup();
  await json(await kit.preflight(initial.projectDigest));
  await json(await kit.update({ ...initial.project, repoPath: "/new/source" }, initial.projectDigest, kit.memberClient), 403);
  for (const field of ["volume", "docker", "imageId", "home", "native", "daemon"]) await json(await kit.update({ ...initial.project, [field]: "/attacker" }, initial.projectDigest), 400);
  const updates = await Promise.all(["/new/one", "/new/two"].map(repoPath => kit.update({ ...initial.project, repoPath }, initial.projectDigest)));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  const conflict = await json<{ code: string }>(updates.find(result => result.status === 409)!, 409); assert.equal(conflict.code, "project_changed");
  const changed = await kit.setup(); assert.notEqual(changed.projectDigest, initial.projectDigest); assert.equal(changed.projectMutable, true);
  await json(await kit.preflight(initial.projectDigest), 409);
  const state = await json<{ setup: { readiness: { projectDigest: string } } }>(await kit.snapshot());
  assert.equal(state.setup.readiness.projectDigest, initial.projectDigest, "Old reports remain inspectable with their original config identity");
  await json(await kit.preflight(changed.projectDigest));
  assert.equal((await db.select().from(campWorkers))[0].preflightProjectDigest, changed.projectDigest);
});

apiTest("Camp project is frozen by any goal history, including a goal that has never been claimed", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), initial = await kit.setup();
  // Empty claims and readiness observations carry no execution history.
  await json(await kit.worker("/claim", { workerId: "idle", protocol: createWorkerDeclaration() }));
  await json(await kit.preflight(initial.projectDigest));
  await json(await kit.update({ ...initial.project, repoPath: "/fixed/before-first-goal" }, initial.projectDigest));
  const current = await kit.setup(); await json(await kit.submit(), 201);
  const response = await json<{ code: string }>(await kit.update({ ...current.project, repoPath: "/later" }, current.projectDigest), 409);
  assert.equal(response.code, "project_frozen"); assert.equal((await db.select().from(campRuns)).length, 0);
  await db.update(campGoals).set({ status: "cancelled" }).where(eq(campGoals.roomId, kit.room.id));
  await json(await kit.update(current.project, current.projectDigest), 409);
  assert.equal((await kit.setup()).projectMutable, false);
});

apiTest("Camp project edit and first goal admission serialize under the same Room lock", async ({ seed, http, app, db }) => {
  const kit = await fixture({ seed, http, app }), initial = await kit.setup();
  const [edited, submitted] = await Promise.all([kit.update({ ...initial.project, repoPath: "/race/new" }, initial.projectDigest), kit.submit()]);
  await json(submitted, 201); assert.ok([200, 409].includes(edited.status));
  const current = await kit.setup(); assert.equal(current.projectMutable, false);
  assert.equal((await db.select().from(campGoals).where(eq(campGoals.roomId, kit.room.id))).length, 1);
  if (edited.status === 200) assert.equal(current.project.repoPath, "/race/new");
  else { assert.equal((await edited.json() as { code: string }).code, "project_frozen"); assert.equal(current.project.repoPath, initial.project.repoPath); }
});
