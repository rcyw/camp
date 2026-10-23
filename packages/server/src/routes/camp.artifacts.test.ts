import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import { campPrivateArtifacts, campRooms } from "../db/schema";
import { roomProjectId } from "../services/camp/storage";
import { createWorkerDeclaration } from "../../../camp-protocol/src/index.js";
import type { createSeed } from "../test/integration/seed";
import type { createHttpClient } from "../test/integration/http";
import type { getDb } from "../db/index";

import type { CampPrivateArtifactManifest } from "../../../camp-protocol/src/index.js";

type Context = { seed: ReturnType<typeof createSeed>; http: ReturnType<typeof createHttpClient>; app: { baseUrl: string }; db: ReturnType<typeof getDb> };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture({ seed, http, app, db }: Context) {
  const owner = await seed.human(), server = await seed.server({ owner }), channel = await seed.channel({ server, members: [owner] }), user = http.as(owner, server);
  const humanPost = (path: string, body: unknown) => user.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await humanPost("/api/camp/rooms", { channelId: channel.id, name: "Private artifacts", project: { name: "fixture" } });
  assert.equal(created.status, 201); const room = await created.json() as { id: string };
  const candidate = { type: "layerfs" as const, projectId: roomProjectId(room.id), refKind: "layer" as const, refId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
  await db.update(campRooms).set({ storageId: "d".repeat(64), acceptedRevision: 1, acceptedCandidate: candidate }).where(eq(campRooms.id, room.id));
  const minted = await humanPost(`/api/camp/rooms/${room.id}/worker-token`, {}), credential = await minted.json() as { token: string; tokenId: string };
  const worker = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = credential.token) => fetch(`${app.baseUrl}/api/camp/worker${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" }) }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
  const post = (path: string, body: unknown) => humanPost(`/api/camp/rooms/${room.id}${path}`, body);
  const start = await post("/storage-operations", { requestId: randomUUID(), kind: "backup", expectedEpoch: 1, expectedAcceptedRevision: 1 });
  assert.equal(start.status, 201); const { operation } = await start.json() as { operation: { id: string } };
  const buffers = [Buffer.from('{"private":"native manifest fixture"}'), Buffer.from('opaque authority record'), Buffer.alloc(512, 42)];
  const manifest: CampPrivateArtifactManifest = { schemaVersion: 1, format: "camp-native-store-v1", files: (["manifest.json", "project.record", "store.sqlite"] as const).map((name, index) => ({ name, bytes: buffers[index].length, sha256: hash(buffers[index]), parts: [{ bytes: buffers[index].length, sha256: hash(buffers[index]) }] })) };
  const receipt = { schemaVersion: 1, operationId: operation.id, manifestDigest: hash(buffers[0]), storeSha256: hash(buffers[2]), bytes: 512, toolchainDigest: "e".repeat(64), imageId: candidate.imageId, candidateCount: 1, sourceStorageId: "d".repeat(64), stopped: true, verified: true };
  assert.equal((await worker(`/storage-operations/${operation.id}/backup`, receipt)).status, 200);
  const prefix = `/storage-operations/${operation.id}`;
  return { room, candidate, credential, worker, post, prefix, manifest, buffers, operation, receipt };
}
async function privateStorage<T>(action: (directory: string) => Promise<T>) {
  const previous = process.env.CAMP_PRIVATE_ARTIFACT_DIR, directory = await mkdtemp(join(tmpdir(), "camp-private-artifacts-"));
  process.env.CAMP_PRIVATE_ARTIFACT_DIR = directory;
  try { return await action(directory); } finally { if (previous === undefined) delete process.env.CAMP_PRIVATE_ARTIFACT_DIR; else process.env.CAMP_PRIVATE_ARTIFACT_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}
apiTest("private transfer is immutable, resumable, sealed by hashes and reusable through a migration", async ({ seed, http, app, db }) => privateStorage(async directory => {
  const kit = await fixture({ seed, http, app, db });
  const response = await kit.worker(kit.prefix + "/artifact", kit.manifest); assert.equal(response.status, 201, await response.clone().text());
  const artifact = await response.json(); assert.equal(JSON.stringify(artifact).includes(directory), false);
  assert.equal((await (await kit.worker(kit.prefix + "/artifact", kit.manifest)).json()).id, artifact.id);
  const changed = structuredClone(kit.manifest); changed.files[1].sha256 = "f".repeat(64);
  assert.equal((await kit.worker(kit.prefix + "/artifact", changed)).status, 409);
  const part = (n: number) => `${kit.prefix}/artifacts/${artifact.id}/parts/${n}`, seal = `${kit.prefix}/artifacts/${artifact.id}/seal`;
  assert.equal((await kit.worker(seal, {})).status, 409);
  assert.equal((await kit.worker(part(0), Buffer.alloc(kit.buffers[0].length), "PUT")).status, 409);
  for (const [index, buffer] of kit.buffers.entries()) {
    const acknowledgements = await Promise.all([kit.worker(part(index), buffer, "PUT"), kit.worker(part(index), buffer, "PUT")]);
    for (const acknowledgement of acknowledgements) assert.equal(acknowledgement.status, 200, await acknowledgement.clone().text());
    assert.equal((await (await kit.worker(kit.prefix + "/artifact")).json()).received.includes(index), true);
  }
  for (let replay = 0; replay < 2; replay++) { const sealed = await kit.worker(seal, {}); assert.equal(sealed.status, 200, await sealed.clone().text()); assert.equal((await sealed.json()).state, "ready"); }
  assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}`, undefined, "DELETE")).status, 409);
  for (const [index, buffer] of kit.buffers.entries()) {
    const downloaded = await kit.worker(part(index)); assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get("cache-control"), "no-store"); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), buffer);
  }
  const migration = await kit.post("/storage-operations", { requestId: randomUUID(), kind: "migration", expectedEpoch: 1, expectedAcceptedRevision: 1, backupOperationId: kit.operation.id });
  assert.equal(migration.status, 201); const { operation } = await migration.json();
  const inherited = await kit.worker(`/storage-operations/${operation.id}/artifact`); assert.equal(inherited.status, 200); assert.equal((await inherited.json()).id, artifact.id);
  assert.equal((await db.select().from(campPrivateArtifacts)).length, 1);
}));
apiTest("native bundle bytes reject cross-Room, model Run and revoked worker credentials", async ({ seed, http, app, db }) => privateStorage(async () => {
  const context = { seed, http, app, db }, kit = await fixture(context), other = await fixture(context);
  const reserved = await kit.worker(kit.prefix + "/artifact", kit.manifest); assert.equal(reserved.status, 201); const artifact = await reserved.json();
  assert.equal((await other.worker(kit.prefix + "/artifact")).status, 404);
  assert.equal((await other.worker(`${kit.prefix}/artifacts/${artifact.id}/parts/0`, kit.buffers[0], "PUT")).status, 404);
  assert.equal((await other.post("/tasks", { title: "Model token probe", role: "planner" })).status, 201);
  const pool = { poolId: randomUUID(), storageId: "d".repeat(64), maxParallel: 2, workerIds: ["a", "b"], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };
  const claimed = await other.worker("/claim", { workerId: "a", protocol: { ...createWorkerDeclaration(), executionPool: pool } }), { run } = await claimed.json(); assert.ok(run);
  assert.equal((await other.worker(kit.prefix + "/artifact", undefined, "GET", run.runToken)).status, 403);
  const revoked = await kit.post(`/worker-tokens/${kit.credential.tokenId}/revoke`, {}); assert.equal(revoked.status, 200);
  assert.equal((await kit.worker(kit.prefix + "/artifact")).status, 401);
}));
apiTest("corrupted private objects fail sealing and download instead of producing a ready backup", async ({ seed, http, app, db }) => privateStorage(async directory => {
  const kit = await fixture({ seed, http, app, db }), reservation = await kit.worker(kit.prefix + "/artifact", kit.manifest), artifact = await reservation.json();
  for (const [index, buffer] of kit.buffers.entries()) assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}/parts/${index}`, buffer, "PUT")).status, 200);
  const [row] = await db.select().from(campPrivateArtifacts).where(eq(campPrivateArtifacts.id, artifact.id));
  const file = join(directory, row.parts["1"]); assert.equal((await readFile(file)).length, kit.buffers[1].length);
  await writeFile(file, Buffer.alloc(kit.buffers[1].length, 9));
  const sealed = await kit.worker(`${kit.prefix}/artifacts/${artifact.id}/seal`, {}); assert.equal(sealed.status, 409); assert.equal((await sealed.json()).code, "artifact_corrupt");
  assert.equal((await (await kit.worker(kit.prefix + "/artifact")).json()).state, "uploading");
  assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}/parts/1`)).status, 409);
}));
apiTest("discarding an abandoned upload releases its reservation and preserves native backup provenance", async ({ seed, http, app, db }) => privateStorage(async directory => {
  const kit = await fixture({ seed, http, app, db }), reservation = await kit.worker(kit.prefix + "/artifact", kit.manifest), artifact = await reservation.json();
  assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}/parts/0`, kit.buffers[0], "PUT")).status, 200);
  const [row] = await db.select().from(campPrivateArtifacts).where(eq(campPrivateArtifacts.id, artifact.id)), object = join(directory, row.parts["0"]);
  assert.ok((await readFile(object)).length);
  for (let replay = 0; replay < 2; replay++) assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}`, undefined, "DELETE")).status, 200);
  await assert.rejects(readFile(object), { code: "ENOENT" });
  assert.equal((await kit.worker(`${kit.prefix}/artifacts/${artifact.id}/parts/1`, kit.buffers[1], "PUT")).status, 404);
  assert.equal((await kit.worker(kit.prefix + "/artifact")).status, 404);
  const repeated = await kit.worker(kit.prefix + "/artifact", kit.manifest); assert.equal(repeated.status, 201); assert.notEqual((await repeated.json()).id, artifact.id);
  const operation = await kit.worker(kit.prefix); assert.deepEqual((await operation.json()).operation.backupReceipt, kit.receipt);
}));
