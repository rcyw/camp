import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { parseCandidate, parseStoragePlan, serializeStoragePlan, parseStorageBackupReceipt, parseStorageRestoreReceipt, type CampCandidate, type CampStoragePlan } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campDagNodes, campEvents, campFinalizations, campGoals, campOperations, campQuestions, campRooms, campRuns, campStorageOperations, campTasks } from "../../db/schema";
import { getActorServerRoleInServer } from "../../lib/actorPermissions";
import { roomForUser, withCampRoomAdmin } from "./rooms";
import { requireWorker, validateWorker } from "./runs";
import { sameCandidate } from "./candidates";
import { CampError, type CampPrincipal } from "./types";
import type { CampStorageKind, CampStorageOperation, CampStorageSnapshot } from "./storageTypes";

type Room = typeof campRooms.$inferSelect;
type Operation = typeof campStorageOperations.$inferSelect;
export const activeStoragePhases = ["prepared", "backup_ready", "restore_ready"] as const;
export const roomProjectId = (roomId: string) => `p-${createHash("sha256").update(`room:${roomId}`).digest("hex").slice(0, 16)}`;
export async function activeStorageOperation(tx: DatabaseExecutor, roomId: string) {
  const [operation] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.roomId, roomId), inArray(campStorageOperations.phase, [...activeStoragePhases])));
  return operation ?? null;
}
export async function assertStorageWritable(tx: DatabaseExecutor, roomId: string) {
  if (await activeStorageOperation(tx, roomId)) throw new CampError(409, "storage_maintenance", "This Room is frozen for storage maintenance");
}
/** A lease timeout fences API ownership, not the old Store. Every historical
 * protocol must have a trusted completion or cleanup ACK before a cold copy. */
async function coldBlockers(tx: DatabaseExecutor, room: Room, excludeOperationId?: string): Promise<string[]> {
  const blockers: string[] = [];
  if (!room.storageId) blockers.push("storage_not_bound");
  if (!room.acceptedCandidate || room.acceptedRevision < 1) blockers.push("accepted_candidate_required");
  if (room.acceptedCandidate && room.acceptedCandidate.projectId !== roomProjectId(room.id)) blockers.push("unsupported_project");
  const [activeGoal] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.roomId, room.id), inArray(campGoals.status, ["queued", "running", "waiting_question", "cancelling"]))).limit(1);
  if (activeGoal) blockers.push("active_goal");
  const [running] = await tx.select({ id: campRuns.id }).from(campRuns).where(and(eq(campRuns.roomId, room.id), eq(campRuns.status, "running"))).limit(1);
  if (running) blockers.push("active_run");
  const [unknown] = await tx.select({ id: campRuns.id }).from(campRuns).where(and(eq(campRuns.roomId, room.id), isNull(campRuns.summary), sql`NOT EXISTS (SELECT 1 FROM ${campEvents} WHERE ${campEvents.runId} = ${campRuns.id} AND ${campEvents.type} = 'cleanup_confirmed')`)).limit(1);
  if (unknown) blockers.push("cleanup_unknown");
  const [inspection] = await tx.select({ id: campGoals.id }).from(campGoals).where(and(eq(campGoals.roomId, room.id), eq(campGoals.integrationInspectionRequired, true))).limit(1);
  if (inspection) blockers.push("integration_inspection_required");
  const [maintenance] = await tx.select({ id: campStorageOperations.id }).from(campStorageOperations).where(and(eq(campStorageOperations.roomId, room.id), inArray(campStorageOperations.phase, [...activeStoragePhases]), excludeOperationId ? ne(campStorageOperations.id, excludeOperationId) : undefined)).limit(1);
  if (maintenance) blockers.push("maintenance_active");
  return blockers;
}
async function candidateInventory(tx: DatabaseExecutor, room: Room): Promise<CampCandidate[]> {
  const found = new Map<string, CampCandidate>();
  const add = (value: unknown) => {
    if (value === null || value === undefined) return;
    const parsed = parseCandidate(value, { requireTagged: false, allowLegacy: true });
    // Mutable branch names and a producer's parent hint are not candidate identity.
    const { branch: _branch, baseRef: _baseRef, ...candidate } = parsed;
    if (candidate.projectId !== roomProjectId(room.id) || candidate.imageId !== room.acceptedCandidate?.imageId) throw new CampError(409, "storage_inventory_invalid", "Historical candidates do not belong to the supported Room Store and image");
    const previous = found.get(candidate.refId);
    if (previous && !sameCandidate(previous, candidate)) throw new CampError(409, "storage_inventory_invalid", "One historical reference has conflicting candidate identities");
    if (!previous && found.size >= 4096) throw new CampError(409, "storage_inventory_limit", "The complete candidate inventory exceeds 4096 references");
    found.set(candidate.refId, candidate);
  };
  add(room.acceptedCandidate);
  const goals = await tx.select({ baseCandidate: campGoals.baseCandidate, currentCandidate: campGoals.currentCandidate, finalCandidate: campGoals.finalCandidate, reviewedItems: campGoals.reviewedItems, dagCandidate: sql<CampCandidate | null>`${campGoals.dagDelivery}->'candidate'` }).from(campGoals).where(eq(campGoals.roomId, room.id));
  for (const goal of goals) { add(goal.baseCandidate); add(goal.currentCandidate); add(goal.finalCandidate); add(goal.dagCandidate); for (const item of Object.values(goal.reviewedItems)) add(item.candidate); }
  const runs = await tx.select({ inputCandidate: campRuns.inputCandidate, candidate: campRuns.candidate,
    changeBase: sql<CampCandidate | null>`${campRuns.changeSet}->'base'`, changeTarget: sql<CampCandidate | null>`${campRuns.changeSet}->'target'`,
    artifacts: sql<unknown[]>`(SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('type', a->'type', 'projectId', a->'projectId', 'refKind', a->'refKind', 'refId', a->'refId', 'commitId', a->'commitId', 'layerId', a->'layerId', 'rootId', a->'rootId', 'imageId', a->'imageId'))), '[]'::jsonb) FROM jsonb_array_elements(${campRuns.artifacts}) a WHERE a->>'type' = 'layerfs')`,
  }).from(campRuns).where(eq(campRuns.roomId, room.id));
  for (const run of runs) {
    add(run.inputCandidate); add(run.candidate); add(run.changeBase); add(run.changeTarget);
    for (const artifact of run.artifacts) add(artifact);
  }
  // A trusted candidate event can commit before the worker loses its lease.
  // Such a run never copies artifacts into its terminal row, but the native
  // reference remains part of this Room's durable historical inventory.
  const events = await tx.select({ candidate: sql<CampCandidate>`jsonb_strip_nulls(jsonb_build_object('type', ${campEvents.artifact}->'type', 'projectId', ${campEvents.artifact}->'projectId', 'refKind', ${campEvents.artifact}->'refKind', 'refId', ${campEvents.artifact}->'refId', 'commitId', ${campEvents.artifact}->'commitId', 'layerId', ${campEvents.artifact}->'layerId', 'rootId', ${campEvents.artifact}->'rootId', 'imageId', ${campEvents.artifact}->'imageId'))` }).from(campEvents).where(and(eq(campEvents.roomId, room.id), sql`${campEvents.artifact}->>'type' = 'layerfs'`));
  for (const event of events) add(event.candidate);
  const graphNodes = await tx.select({ input: campDagNodes.inputCandidate, approved: sql<CampCandidate | null>`${campDagNodes.approvedProducer}->'candidate'`, sources: campDagNodes.inputSources }).from(campDagNodes).innerJoin(campGoals, eq(campGoals.id, campDagNodes.goalId)).where(eq(campGoals.roomId, room.id));
  for (const node of graphNodes) { add(node.input); add(node.approved); for (const parent of node.sources) add(parent.candidate); }
  const bindings = await tx.select({ candidate: campTasks.inputCandidate }).from(campTasks).where(eq(campTasks.roomId, room.id)); for (const binding of bindings) add(binding.candidate);
  const questions = await tx.select({ candidate: campQuestions.candidate }).from(campQuestions).where(eq(campQuestions.roomId, room.id)); for (const question of questions) add(question.candidate);
  const finalizations = await tx.select({ candidate: campFinalizations.candidate }).from(campFinalizations).where(eq(campFinalizations.roomId, room.id)); for (const finalization of finalizations) add(finalization.candidate);
  const operations = await tx.select({ inputCandidate: campOperations.inputCandidate, verified: sql<CampCandidate | null>`${campOperations.receipt}->'candidate'`, integrated: sql<CampCandidate | null>`${campOperations.integrationReport}->'candidate'`, base: sql<CampCandidate | null>`${campOperations.integrationInput}->'base'`, parents: sql<Array<{ candidate: CampCandidate }> | null>`${campOperations.integrationInput}->'parents'` }).from(campOperations).where(eq(campOperations.roomId, room.id));
  for (const operation of operations) { add(operation.inputCandidate); add(operation.verified); add(operation.integrated); add(operation.base); for (const parent of operation.parents ?? []) add(parent.candidate); }
  return [...found.values()].sort((left, right) => left.refId.localeCompare(right.refId));
}
function samePlacement(room: Room, plan: CampStoragePlan) {
  return room.storageEpoch === plan.storageEpoch && room.storageId === plan.sourceStorageId && room.acceptedRevision === plan.acceptedRevision && sameCandidate(room.acceptedCandidate, plan.acceptedCandidate);
}
function sameArtifactSnapshot(left: CampStoragePlan, right: CampStoragePlan) {
  return left.roomId === right.roomId && left.acceptedRevision === right.acceptedRevision && left.projectId === right.projectId && sameCandidate(left.acceptedCandidate, right.acceptedCandidate) && isDeepStrictEqual(left.candidates, right.candidates);
}
async function requireCold(tx: DatabaseExecutor, room: Room, operation?: Operation) {
  const blockers = await coldBlockers(tx, room, operation?.id);
  if (blockers.length) throw new CampError(409, blockers[0], `Storage maintenance is blocked (${blockers.join(", ")})`);
  if (operation && !samePlacement(room, operation.plan)) throw new CampError(409, "storage_changed", "The frozen source placement or accepted baseline changed");
  const candidates = await candidateInventory(tx, room);
  if (operation && !isDeepStrictEqual(candidates, operation.plan.candidates)) throw new CampError(409, "inventory_changed", "The candidate inventory changed after this storage plan was frozen");
  return candidates;
}
function viewOperation(operation: Operation, administrator: boolean, cold: boolean, room: Room, inventory: CampCandidate[] | null, fullInventory = false): CampStorageOperation {
  const snapshotCurrent = room.id === operation.plan.roomId && room.acceptedRevision === operation.plan.acceptedRevision && sameCandidate(room.acceptedCandidate, operation.plan.acceptedCandidate) && operation.plan.projectId === roomProjectId(room.id) && inventory !== null && isDeepStrictEqual(inventory, operation.plan.candidates);
  const current = samePlacement(room, operation.plan) && snapshotCurrent;
  return { id: operation.id, roomId: operation.roomId, requestId: operation.requestId, kind: operation.kind, phase: operation.phase, plan: { ...operation.plan, candidates: fullInventory ? operation.plan.candidates : operation.plan.candidates.slice(0, 8) }, candidateCount: operation.plan.candidates.length, inventoryTruncated: !fullInventory && operation.plan.candidates.length > 8, planDigest: operation.planDigest, backupReceipt: operation.backupReceipt, restoreReceipt: operation.restoreReceipt, createdAt: operation.createdAt.toISOString(), updatedAt: operation.updatedAt.toISOString(), completedAt: operation.completedAt?.toISOString() ?? null, originBackupOperationId: operation.plan.backupOperationId ?? null,
    canActivate: administrator && cold && current && operation.phase === "restore_ready", canCancel: administrator && activeStoragePhases.some(phase => phase === operation.phase), canRestoreFromBackup: administrator && cold && snapshotCurrent && operation.kind === "backup" && operation.phase === "completed" };
}
export async function storageSnapshot(roomId: string, administrator = false, tx: DatabaseExecutor = getDb()): Promise<CampStorageSnapshot> {
  const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, roomId)); if (!room) throw new CampError(404, "room_not_found", "Room not found");
  const operations = await tx.select().from(campStorageOperations).where(eq(campStorageOperations.roomId, roomId)).orderBy(desc(campStorageOperations.createdAt), desc(campStorageOperations.id)).limit(21);
  // created_at is transaction start time, so the active operation is not
  // necessarily among the latest rows after a contended admission.
  const active = await activeStorageOperation(tx, roomId);
  const blockers = await coldBlockers(tx, room, active?.id);
  let inventory: CampCandidate[] | null = null;
  if (!blockers.length) { try { inventory = await candidateInventory(tx, room); } catch { blockers.push("storage_inventory_invalid"); } }
  const cold = blockers.length === 0;
  const visible = active ? [active, ...operations.filter(operation => operation.id !== active.id)] : operations;
  const projected = visible.slice(0, 20).map(operation => {
    const view = viewOperation(operation, administrator, cold, room, inventory);
    return { ...view, canRestoreFromBackup: !active && view.canRestoreFromBackup };
  });
  let operationsTruncated = visible.length > 20;
  while (Buffer.byteLength(JSON.stringify(projected)) > 240 * 1024 && projected.length > 1) { projected.pop(); operationsTruncated = true; }
  return { epoch: room.storageEpoch, storageId: room.storageId, maintenance: Boolean(active), activeOperationId: active?.id ?? null,
    operations: projected, operationsTruncated, canBackup: administrator && cold && !active, canMigrate: administrator && cold && !active && room.storageEpoch < 2147483647, blockers: active ? [...blockers, "maintenance_active"] : blockers };
}
export async function createStorageOperation(roomId: string, userId: string, input: { requestId: string; kind: CampStorageKind; expectedEpoch: number; expectedAcceptedRevision: number; backupOperationId?: string }) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [existing] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.roomId, roomId), eq(campStorageOperations.requestId, input.requestId)));
    if (existing) {
      if (existing.kind !== input.kind || existing.plan.storageEpoch !== input.expectedEpoch || existing.plan.acceptedRevision !== input.expectedAcceptedRevision || (existing.plan.backupOperationId ?? null) !== (input.backupOperationId ?? null)) throw new CampError(409, "storage_request_conflict", "This request identifier names a different storage operation");
      const storage = await storageSnapshot(roomId, true, tx); return { operation: storage.operations.find(operation => operation.id === existing.id) ?? viewOperation(existing, true, false, room, null), storage };
    }
    if (room.storageEpoch !== input.expectedEpoch || room.acceptedRevision !== input.expectedAcceptedRevision) throw new CampError(409, "storage_changed", "Refresh the storage epoch and accepted baseline before maintenance");
    if (input.backupOperationId && input.kind !== "migration") throw new CampError(400, "invalid_storage", "Only a migration can reference an existing backup");
    if (input.kind === "migration" && room.storageEpoch >= 2147483647) throw new CampError(409, "storage_epoch_exhausted", "The storage epoch cannot advance further");
    const candidates = await requireCold(tx, room), operationId = randomUUID();
    const plan = parseStoragePlan({ schemaVersion: 1, operationId, roomId, kind: input.kind, storageEpoch: room.storageEpoch, sourceStorageId: room.storageId, acceptedRevision: room.acceptedRevision, acceptedCandidate: room.acceptedCandidate, projectId: roomProjectId(roomId), candidates, ...(input.backupOperationId ? { backupOperationId: input.backupOperationId } : {}) });
    let backupReceipt: Operation["backupReceipt"] = null;
    if (input.backupOperationId) {
      const [origin] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.id, input.backupOperationId), eq(campStorageOperations.roomId, roomId), eq(campStorageOperations.kind, "backup"), eq(campStorageOperations.phase, "completed")));
      if (!origin?.backupReceipt) throw new CampError(409, "backup_not_available", "Choose a completed backup from this Room");
      if (!sameArtifactSnapshot(origin.plan, plan)) throw new CampError(409, "inventory_changed", "This backup no longer covers the current accepted baseline and complete candidate inventory");
      backupReceipt = origin.backupReceipt;
    }
    await tx.insert(campStorageOperations).values({ id: operationId, roomId, requestId: input.requestId, kind: input.kind, phase: backupReceipt ? "backup_ready" : "prepared", plan, planDigest: createHash("sha256").update(serializeStoragePlan(plan)).digest("hex"), backupReceipt, createdByUserId: userId });
    await tx.insert(campEvents).values({ roomId, type: "storage_maintenance", content: `${input.kind} prepared; new execution is frozen` });
    const storage = await storageSnapshot(roomId, true, tx); return { operation: storage.operations.find(operation => operation.id === operationId)!, storage };
  });
}
export async function workerStorageOperation(tx: DatabaseExecutor, principal: CampPrincipal, operationId: string) {
  requireWorker(principal);
  const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId)).for("update"); if (!room) throw new CampError(404, "room_not_found", "Room not found");
  await validateWorker(tx, principal);
  const [operation] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.id, operationId), eq(campStorageOperations.roomId, room.id)));
  if (!operation) throw new CampError(404, "storage_operation_not_found", "Storage operation not found");
  return { room, operation };
}
export async function readWorkerStorageOperation(principal: CampPrincipal, operationId: string) {
  return getDb().transaction(async tx => { const { room, operation } = await workerStorageOperation(tx, principal, operationId); return { operation: viewOperation(operation, false, false, room, null), plan: operation.plan }; });
}
export async function recordStorageBackup(principal: CampPrincipal, operationId: string, value: unknown) {
  const receipt = parseStorageBackupReceipt(value);
  return getDb().transaction(async tx => {
    const { room, operation } = await workerStorageOperation(tx, principal, operationId);
    if (operation.backupReceipt) {
      if (!isDeepStrictEqual(operation.backupReceipt, receipt)) throw new CampError(409, "storage_receipt_conflict", "The original backup receipt is immutable");
      return { operation: viewOperation(operation, false, false, room, null), replayed: true };
    }
    if (operation.phase !== "prepared" || operation.plan.backupOperationId) throw new CampError(409, "storage_phase_changed", "This operation no longer accepts a source backup");
    await requireCold(tx, room, operation);
    if (receipt.operationId !== operation.id || receipt.sourceStorageId !== operation.plan.sourceStorageId || receipt.candidateCount !== operation.plan.candidates.length || receipt.imageId !== operation.plan.acceptedCandidate.imageId) throw new CampError(409, "storage_receipt_mismatch", "The backup must attest this exact frozen Room inventory and image");
    await tx.update(campStorageOperations).set({ backupReceipt: receipt, phase: operation.kind === "backup" ? "completed" : "backup_ready", updatedAt: sql`clock_timestamp()`, completedAt: operation.kind === "backup" ? sql`clock_timestamp()` : null }).where(eq(campStorageOperations.id, operation.id));
    const [updated] = await tx.select().from(campStorageOperations).where(eq(campStorageOperations.id, operation.id));
    return { operation: viewOperation(updated, false, false, room, null), replayed: false };
  });
}
export async function recordStorageRestore(principal: CampPrincipal, operationId: string, value: unknown) {
  const receipt = parseStorageRestoreReceipt(value);
  return getDb().transaction(async tx => {
    const { room, operation } = await workerStorageOperation(tx, principal, operationId);
    if (operation.restoreReceipt) {
      if (!isDeepStrictEqual(operation.restoreReceipt, receipt)) throw new CampError(409, "storage_receipt_conflict", "The original restore receipt is immutable");
      return { operation: viewOperation(operation, false, false, room, null), replayed: true };
    }
    if (operation.kind !== "migration" || operation.phase !== "backup_ready" || !operation.backupReceipt) throw new CampError(409, "storage_phase_changed", "A migration needs its immutable source backup before restore");
    await requireCold(tx, room, operation);
    const { operationId: _receiptOperation, targetStorageId: _target, verifiedCandidates: _count, historyVerified: _history, ...source } = receipt;
    const { operationId: _sourceOperation, ...frozen } = operation.backupReceipt;
    if (receipt.operationId !== operation.id || receipt.targetStorageId === operation.plan.sourceStorageId || !isDeepStrictEqual(source, frozen)) throw new CampError(409, "storage_receipt_mismatch", "Restore must attest the exact original backup artifact and current operation identity");
    await tx.update(campStorageOperations).set({ restoreReceipt: receipt, phase: "restore_ready", updatedAt: sql`clock_timestamp()` }).where(eq(campStorageOperations.id, operation.id));
    const [updated] = await tx.select().from(campStorageOperations).where(eq(campStorageOperations.id, operation.id));
    return { operation: viewOperation(updated, false, false, room, null), replayed: false };
  });
}
export async function activateStorage(roomId: string, operationId: string, userId: string, expectedEpoch: number, expectedTargetStorageId: string) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [operation] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.id, operationId), eq(campStorageOperations.roomId, roomId)));
    if (!operation) throw new CampError(404, "storage_operation_not_found", "Storage operation not found");
    if (expectedEpoch !== operation.plan.storageEpoch || expectedTargetStorageId !== operation.restoreReceipt?.targetStorageId) throw new CampError(409, "storage_changed", "Refresh before activating this exact restored destination");
    if (operation.phase === "activated") { const storage = await storageSnapshot(roomId, true, tx); return { operation: storage.operations.find(value => value.id === operation.id) ?? viewOperation(operation, true, false, room, null), storage }; }
    if (operation.kind !== "migration" || operation.phase !== "restore_ready" || !operation.restoreReceipt) throw new CampError(409, "storage_phase_changed", "Only an independently restored destination can become active");
    await requireCold(tx, room, operation);
    const [activated] = await tx.update(campRooms).set({ storageId: expectedTargetStorageId, storageEpoch: expectedEpoch + 1 }).where(and(eq(campRooms.id, roomId), eq(campRooms.storageEpoch, expectedEpoch), eq(campRooms.storageId, operation.plan.sourceStorageId), eq(campRooms.acceptedRevision, operation.plan.acceptedRevision))).returning({ id: campRooms.id });
    if (!activated) throw new CampError(409, "storage_changed", "The storage epoch or accepted baseline changed before activation");
    await tx.update(campStorageOperations).set({ phase: "activated", updatedAt: sql`clock_timestamp()`, completedAt: sql`clock_timestamp()` }).where(eq(campStorageOperations.id, operation.id));
    await tx.insert(campEvents).values({ roomId, type: "storage_activated", content: `Verified storage activated at epoch ${expectedEpoch + 1}; historical candidates and pools are unchanged` });
    const [updated] = await tx.select().from(campStorageOperations).where(eq(campStorageOperations.id, operation.id));
    const storage = await storageSnapshot(roomId, true, tx); return { operation: storage.operations.find(value => value.id === operation.id) ?? viewOperation(updated, true, false, room, null), storage };
  });
}
export async function cancelStorage(roomId: string, operationId: string, userId: string) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    const [operation] = await tx.select().from(campStorageOperations).where(and(eq(campStorageOperations.id, operationId), eq(campStorageOperations.roomId, roomId)));
    if (!operation) throw new CampError(404, "storage_operation_not_found", "Storage operation not found");
    if (operation.phase !== "cancelled") {
      if (!activeStoragePhases.some(phase => phase === operation.phase)) throw new CampError(409, "storage_phase_changed", "This completed storage operation cannot be cancelled");
      await tx.update(campStorageOperations).set({ phase: "cancelled", updatedAt: sql`clock_timestamp()`, completedAt: sql`clock_timestamp()` }).where(eq(campStorageOperations.id, operation.id));
    }
    const [updated] = await tx.select().from(campStorageOperations).where(eq(campStorageOperations.id, operation.id));
    const storage = await storageSnapshot(roomId, true, tx); return { operation: storage.operations.find(value => value.id === operation.id) ?? viewOperation(updated, true, false, room, null), storage };
  });
}
export async function userStorageSnapshot(roomId: string, userId: string) {
  const [room] = await getDb().select().from(campRooms).where(eq(campRooms.id, roomId)); if (!room) throw new CampError(404, "room_not_found", "Room not found");
  await roomForUser(roomId, room.serverId, userId);
  const role = await getActorServerRoleInServer(room.serverId, "user", userId);
  return storageSnapshot(roomId, role === "owner" || role === "admin");
}

export async function userStorageOperation(roomId: string, operationId: string, userId: string) {
  const [room] = await getDb().select().from(campRooms).where(eq(campRooms.id, roomId)); if (!room) throw new CampError(404, "room_not_found", "Room not found");
  const [operation] = await getDb().select().from(campStorageOperations).where(and(eq(campStorageOperations.id, operationId), eq(campStorageOperations.roomId, roomId)));
  if (!operation) throw new CampError(404, "storage_operation_not_found", "Storage operation not found");
  const storage = await userStorageSnapshot(roomId, userId);
  const visible = storage.operations.find(value => value.id === operationId);
  return visible ? { ...visible, plan: operation.plan, inventoryTruncated: false } : viewOperation(operation, false, false, room, null, true);
}
