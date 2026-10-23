import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { parsePreflightReport, type CampPreflightReport } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campRooms, campWorkers } from "../../db/schema";
import { withCampRoomAdmin } from "./rooms";
import { requireWorker, validateWorker } from "./runs";
import { CampError, type CampPrincipal, type CampProject } from "./types";

/** Only operator project configuration participates; no Docker deployment paths
 * or volume names can be selected through this API. Optional fields have one
 * canonical absent representation, independent of input object key order. */
export function projectDigest(project: CampProject): string {
  return createHash("sha256").update(JSON.stringify({ name: project.name, repoPath: project.repoPath ?? null, storePath: project.storePath ?? null, baseRef: project.baseRef ?? null })).digest("hex");
}

export type CampReadiness = {
  selfReported: true; workerId: string; projectDigest: string;
  observedAt: Date; report: CampPreflightReport;
};

export function workerPreflight(row: Pick<typeof campWorkers.$inferSelect, "workerId" | "preflightProjectDigest" | "preflightObservedAt" | "preflightReport">): CampReadiness | null {
  return row.preflightProjectDigest && row.preflightObservedAt && row.preflightReport
    ? { selfReported: true, workerId: row.workerId, projectDigest: row.preflightProjectDigest, observedAt: row.preflightObservedAt, report: row.preflightReport }
    : null;
}

async function mutableProject(tx: DatabaseExecutor, room: typeof campRooms.$inferSelect): Promise<boolean> {
  const [state] = await tx.select({ mutable: sql<boolean>`
    NOT EXISTS (SELECT 1 FROM camp_goals WHERE room_id = ${room.id})
    AND NOT EXISTS (SELECT 1 FROM camp_tasks WHERE room_id = ${room.id})
    AND NOT EXISTS (SELECT 1 FROM camp_runs WHERE room_id = ${room.id})
    AND NOT EXISTS (SELECT 1 FROM camp_operations WHERE room_id = ${room.id})
  ` }).from(campRooms).where(eq(campRooms.id, room.id));
  return Boolean(state?.mutable) && room.acceptedRevision === 0 && room.acceptedGoalId === null && room.acceptedCandidate === null;
}

export async function roomSetup(room: typeof campRooms.$inferSelect, tx: DatabaseExecutor = getDb()) {
  const [observation] = await tx.select().from(campWorkers).where(and(eq(campWorkers.roomId, room.id), isNotNull(campWorkers.preflightObservedAt))).orderBy(desc(campWorkers.preflightObservedAt), campWorkers.workerId).limit(1);
  return { projectDigest: projectDigest(room.project), projectMutable: await mutableProject(tx, room), readiness: observation ? workerPreflight(observation) : null };
}

/** Discovery is deliberately independent of claims, protocol negotiation and
 * goal budgets. A run-scoped model credential cannot discover host paths. */
export async function workerSetup(principal: CampPrincipal) {
  requireWorker(principal);
  return getDb().transaction(async tx => {
    await validateWorker(tx, principal);
    const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId));
    if (!room) throw new CampError(404, "room_not_found", "Room not found");
    return { roomId: room.id, project: room.project, projectDigest: projectDigest(room.project), projectMutable: await mutableProject(tx, room) };
  });
}

export async function recordWorkerPreflight(principal: CampPrincipal, workerId: string, expectedDigest: string, input: unknown) {
  requireWorker(principal);
  const report = parsePreflightReport(input);
  return getDb().transaction(async tx => {
    // Serialize with project changes and goal creation. Revalidate the room
    // capability after waiting for the lock, including concurrent revocation.
    const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, principal.roomId)).for("update");
    if (!room) throw new CampError(404, "room_not_found", "Room not found");
    await validateWorker(tx, principal);
    const digest = projectDigest(room.project);
    if (digest !== expectedDigest) throw new CampError(409, "project_changed", "Project configuration changed; repeat setup checks");
    const [observation] = await tx.insert(campWorkers).values({ roomId: room.id, workerId, preflightProjectDigest: digest, preflightReport: report, preflightObservedAt: sql`clock_timestamp()`, lastSeenAt: sql`clock_timestamp()` }).onConflictDoUpdate({
      target: [campWorkers.roomId, campWorkers.workerId],
      set: { preflightProjectDigest: digest, preflightReport: report, preflightObservedAt: sql`clock_timestamp()`, lastSeenAt: sql`clock_timestamp()` },
    }).returning();
    return { roomId: room.id, projectDigest: digest, readiness: workerPreflight(observation)! };
  });
}

export async function updateProject(roomId: string, userId: string, project: CampProject, expectedDigest: string) {
  return withCampRoomAdmin(roomId, userId, async (tx, room) => {
    if (projectDigest(room.project) !== expectedDigest) throw new CampError(409, "project_changed", "Project configuration changed; refresh before saving");
    if (!await mutableProject(tx, room)) throw new CampError(409, "project_frozen", "Project configuration is immutable after execution history is created");
    await tx.update(campRooms).set({ project }).where(eq(campRooms.id, room.id));
  });
}
