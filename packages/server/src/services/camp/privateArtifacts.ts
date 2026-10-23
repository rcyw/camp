import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { CAMP_ARTIFACT_LIMITS, parsePrivateArtifactManifest, serializePrivateArtifactManifest } from "../../../../camp-protocol/src/index.js";
import type { CampPrivateArtifact, CampPrivateArtifactManifest } from "../../../../camp-protocol/src/index.js";
import { getDb } from "../../db/index";
import type { DatabaseExecutor } from "../../db/index";
import { campEvents, campPrivateArtifacts } from "../../db/schema";
import { workerStorageOperation } from "./storage";
import { privateArtifactStore } from "./privateArtifactStore";
import { CampError } from "./types";
import type { CampPrincipal } from "./types";

type Artifact = typeof campPrivateArtifacts.$inferSelect;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const artifactParts = (manifest: CampPrivateArtifactManifest) => manifest.files.flatMap(file => file.parts.map((part, ordinal) => ({ ...part, name: file.name, ordinal })));
const project = (row: Artifact): CampPrivateArtifact => ({ schemaVersion: 1, id: row.id, state: row.state, manifestDigest: row.manifestDigest, manifest: row.manifest, received: Object.keys(row.parts).map(Number).sort((a, b) => a - b) });
async function authority(tx: DatabaseExecutor, principal: CampPrincipal, operationId: string) {
  const context = await workerStorageOperation(tx, principal, operationId);
  const receipt = context.operation.backupReceipt;
  if (!receipt || context.operation.phase === "cancelled") throw new CampError(409, "artifact_backup_required", "Artifact transport requires an acknowledged native backup");
  return { ...context, receipt, originId: context.operation.plan.backupOperationId ?? operationId };
}
async function owned(tx: DatabaseExecutor, principal: CampPrincipal, operationId: string, artifactId?: string) {
  const context = await authority(tx, principal, operationId);
  const [row] = await tx.select().from(campPrivateArtifacts).where(and(eq(campPrivateArtifacts.roomId, context.room.id), eq(campPrivateArtifacts.operationId, context.originId), artifactId ? eq(campPrivateArtifacts.id, artifactId) : undefined));
  if (!row) throw new CampError(404, "artifact_not_found", "No private artifact belongs to this storage operation");
  return { ...context, row };
}
export async function reservePrivateArtifact(principal: CampPrincipal, operationId: string, value: unknown) {
  const manifest = parsePrivateArtifactManifest(value), manifestDigest = hash(serializePrivateArtifactManifest(manifest));
  await privateArtifactStore().ready();
  return getDb().transaction(async tx => {
    const { room, receipt, originId } = await authority(tx, principal, operationId);
    const native = manifest.files[0], store = manifest.files[2];
    if (native.sha256 !== receipt.manifestDigest || store.sha256 !== receipt.storeSha256 || store.bytes !== receipt.bytes) throw new CampError(409, "artifact_receipt_mismatch", "Transfer must preserve the original manifest and Store bytes");
    const [existing] = await tx.select().from(campPrivateArtifacts).where(and(eq(campPrivateArtifacts.roomId, room.id), eq(campPrivateArtifacts.operationId, originId)));
    if (existing) {
      if (existing.manifestDigest !== manifestDigest) throw new CampError(409, "artifact_conflict", "The accepted transfer manifest is immutable");
      return project(existing);
    }
    const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    const [quota] = await tx.select({ bytes: sql<number>`coalesce(sum(${campPrivateArtifacts.bytes}), 0)::float8`, pending: sql<number>`count(*) FILTER (WHERE ${campPrivateArtifacts.state} = 'uploading')::int` }).from(campPrivateArtifacts).where(eq(campPrivateArtifacts.roomId, room.id));
    if (quota.bytes + bytes > CAMP_ARTIFACT_LIMITS.roomBytes || quota.pending >= CAMP_ARTIFACT_LIMITS.pendingPerRoom) throw new CampError(409, "artifact_quota", "This Room reached its private transfer storage or pending-upload budget");
    const [row] = await tx.insert(campPrivateArtifacts).values({ id: randomUUID(), roomId: room.id, operationId: originId, manifest, manifestDigest, bytes }).returning();
    return project(row);
  });
}
export async function readPrivateArtifact(principal: CampPrincipal, operationId: string) {
  return getDb().transaction(async tx => project((await owned(tx, principal, operationId)).row));
}
/** Discard only an unpublished transfer. Keep the native backup receipt and
 * audit fact; sealed backups require a separate retention policy. */
export async function discardPrivateArtifact(principal: CampPrincipal, operationId: string, artifactId: string) {
  const backend = privateArtifactStore();
  const keys = await getDb().transaction(async tx => {
    const { room, originId } = await authority(tx, principal, operationId);
    const [row] = await tx.select().from(campPrivateArtifacts).where(and(eq(campPrivateArtifacts.roomId, room.id), eq(campPrivateArtifacts.operationId, originId), eq(campPrivateArtifacts.id, artifactId)));
    if (!row) return [];
    if (row.state !== "uploading") throw new CampError(409, "artifact_sealed", "A sealed native backup cannot be discarded as an unfinished transfer");
    await tx.delete(campPrivateArtifacts).where(eq(campPrivateArtifacts.id, artifactId));
    await tx.insert(campEvents).values({ roomId: room.id, type: "storage_maintenance", content: `Unpublished private transfer ${artifactId} discarded` });
    return Object.values(row.parts);
  });
  // Publication-before-SQL crashes can already leave orphan objects. Failed
  // discard cleanup has the same explicit orphan-reconciliation boundary.
  await Promise.allSettled(keys.map(key => backend.remove(key)));
  return { artifactId, discarded: true };
}
export async function authorizeArtifactPart(principal: CampPrincipal, operationId: string, artifactId: string, index: number) {
  return getDb().transaction(async tx => {
    const { row } = await owned(tx, principal, operationId, artifactId), part = artifactParts(row.manifest)[index];
    if (!Number.isSafeInteger(index) || index < 0 || !part) throw new CampError(404, "artifact_part_not_found", "Artifact part does not exist");
    return { part, row };
  });
}
export async function putPrivateArtifactPart(principal: CampPrincipal, operationId: string, artifactId: string, index: number, bytes: Buffer) {
  const { part } = await authorizeArtifactPart(principal, operationId, artifactId, index);
  if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw new CampError(409, "artifact_part_mismatch", "Artifact part digest or byte length differs");
  const backend = privateArtifactStore(), key = await backend.put(bytes);
  let retained = false;
  try {
    return await getDb().transaction(async tx => {
      const { row } = await owned(tx, principal, operationId, artifactId);
      if (!row.parts[index]) {
        if (row.state !== "uploading") throw new CampError(409, "artifact_sealed", "A sealed artifact cannot acquire new parts");
        await tx.update(campPrivateArtifacts).set({ parts: { ...row.parts, [index]: key } }).where(eq(campPrivateArtifacts.id, artifactId));
        retained = true;
      }
      return { received: index };
    });
  } finally { if (!retained) await backend.remove(key); }
}
export async function sealPrivateArtifact(principal: CampPrincipal, operationId: string, artifactId: string) {
  const snapshot = await getDb().transaction(async tx => (await owned(tx, principal, operationId, artifactId)).row);
  const parts = artifactParts(snapshot.manifest), backend = privateArtifactStore();
  if (parts.some((_part, index) => !snapshot.parts[index])) throw new CampError(409, "artifact_incomplete", "Every artifact part must be present before sealing");
  let index = 0;
  for (const file of snapshot.manifest.files) {
    const digest = createHash("sha256");
    for (const part of file.parts) {
      const bytes = await backend.get(snapshot.parts[index++], part.bytes);
      if (hash(bytes) !== part.sha256) throw new CampError(409, "artifact_corrupt", "Stored artifact part failed its digest check");
      digest.update(bytes);
    }
    if (digest.digest("hex") !== file.sha256) throw new CampError(409, "artifact_corrupt", "Artifact file failed its complete digest check");
  }
  return getDb().transaction(async tx => {
    const { row } = await owned(tx, principal, operationId, artifactId);
    // Parts are immutable once acknowledged; a concurrent upload may only add
    // a previously absent part, which this complete snapshot already excludes.
    if (row.manifestDigest !== snapshot.manifestDigest || JSON.stringify(row.parts) !== JSON.stringify(snapshot.parts)) throw new CampError(409, "artifact_changed", "Artifact transfer changed during verification");
    const [sealed] = await tx.update(campPrivateArtifacts).set({ state: "ready", sealedAt: sql`coalesce(${campPrivateArtifacts.sealedAt}, clock_timestamp())` }).where(eq(campPrivateArtifacts.id, artifactId)).returning();
    return project(sealed);
  });
}
export async function getPrivateArtifactPart(principal: CampPrincipal, operationId: string, artifactId: string, index: number) {
  const { row, part } = await authorizeArtifactPart(principal, operationId, artifactId, index);
  if (row.state !== "ready" || !row.parts[index]) throw new CampError(409, "artifact_not_ready", "Private artifact is not sealed");
  const bytes = await privateArtifactStore().get(row.parts[index], part.bytes);
  if (hash(bytes) !== part.sha256) throw new CampError(409, "artifact_corrupt", "Stored private artifact failed its digest check");
  return bytes;
}
