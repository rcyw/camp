import { desc, eq, sql } from "drizzle-orm";
import type { CampWorkerDeclaration, CampTaskRequirements, CampWorkerCompatibility } from "../../../../camp-protocol/src/index.js";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campWorkers } from "../../db/schema";
import { workerPreflight } from "./setup";

/** This registry records a last authenticated observation, never an allocation
 * authority. Task requirements and a declaration are checked again under the
 * Room lock before each new run; credentials are deliberately absent. */
export async function observeWorker(tx: DatabaseExecutor, roomId: string, workerId: string, declaration: CampWorkerDeclaration | null, compatibility: CampWorkerCompatibility | null, requirements: CampTaskRequirements | null, runId?: string) {
  await tx.insert(campWorkers).values({ roomId, workerId, declaration, compatibility, requirements, lastSeenAt: sql`clock_timestamp()`, ...(runId ? { lastClaimAt: sql`clock_timestamp()`, lastRunId: runId } : {}) }).onConflictDoUpdate({
    target: [campWorkers.roomId, campWorkers.workerId],
    set: { declaration, compatibility, requirements, lastSeenAt: sql`clock_timestamp()`, ...(runId ? { lastClaimAt: sql`clock_timestamp()`, lastRunId: runId } : {}) },
  });
}

export async function workerSnapshots(roomId: string) {
  const rows = await getDb().select({ workerId: campWorkers.workerId, declaration: campWorkers.declaration, compatibility: campWorkers.compatibility, requirements: campWorkers.requirements, lastSeenAt: campWorkers.lastSeenAt, lastClaimAt: campWorkers.lastClaimAt, lastRunId: campWorkers.lastRunId, preflightProjectDigest: campWorkers.preflightProjectDigest, preflightObservedAt: campWorkers.preflightObservedAt, preflightReport: campWorkers.preflightReport })
    .from(campWorkers).where(eq(campWorkers.roomId, roomId)).orderBy(desc(campWorkers.lastSeenAt), campWorkers.workerId).limit(50);
  return rows.map(({ preflightProjectDigest, preflightObservedAt, preflightReport, ...row }) => ({ ...row, preflight: workerPreflight({ workerId: row.workerId, preflightProjectDigest, preflightObservedAt, preflightReport }) }));
}
