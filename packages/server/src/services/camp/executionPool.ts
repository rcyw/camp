import { and, eq, sql } from "drizzle-orm";
import { serializeExecutionPool, type CampWorkerCompatibility, type CampWorkerDeclaration } from "../../../../camp-protocol/src/index.js";
import type { DatabaseExecutor } from "../../db/index";
import { campEvents, campGoals, campRooms, campRuns } from "../../db/schema";

type Goal = typeof campGoals.$inferSelect;
type Room = typeof campRooms.$inferSelect;
/** Physical uncertainty counts toward the Room's bound until the trusted
 * owner confirms cleanup. A lease fence alone never stops an old sandbox. */
export async function roomOccupancy(tx: DatabaseExecutor, roomId: string) {
  return tx.select().from(campRuns).where(and(eq(campRuns.roomId, roomId), sql`(
    ${campRuns.status} = 'running' OR (
      (${campRuns.workerProtocol}->>'version')::integer >= 4
      AND ${campRuns.summary} IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${campEvents} WHERE ${campEvents.runId} = ${campRuns.id} AND ${campEvents.type} = 'cleanup_confirmed')
    )
  )`));
}
/** A registered Store is an authority fence even when no task is ready. */
export function physicalPoolCompatibility(room: Room, workerId: string, declaration: CampWorkerDeclaration | null, compatibility: CampWorkerCompatibility): CampWorkerCompatibility {
  const pool = declaration?.executionPool;
  const incompatible = (code: CampWorkerCompatibility["code"]): CampWorkerCompatibility => ({ ...compatibility, status: "incompatible", code });
  if (!pool) return incompatible("pool_required");
  if (!pool.workerIds.includes(workerId)) return incompatible("lane_not_registered");
  if (room.storageId && room.storageId !== pool.storageId) return incompatible("storage_mismatch");
  return compatibility;
}
export function poolCompatibility(room: Room, goal: Goal, workerId: string, declaration: CampWorkerDeclaration | null, compatibility: CampWorkerCompatibility): CampWorkerCompatibility {
  if ((!room.storageId && goal.protocolVersion !== 4) || compatibility.status === "incompatible") return compatibility;
  const checked = physicalPoolCompatibility(room, workerId, declaration, compatibility);
  if (checked.status === "incompatible") return checked;
  if (goal.executionPool && serializeExecutionPool(goal.executionPool) !== serializeExecutionPool(declaration!.executionPool!)) return { ...compatibility, status: "incompatible", code: "pool_mismatch" };
  return checked;
}
/** Called only after all admission checks under the existing Room row lock. */
export async function pinExecutionPool(tx: DatabaseExecutor, room: Room, goal: Goal, declaration: CampWorkerDeclaration | null) {
  if (goal.protocolVersion !== 4 || !declaration?.executionPool) return;
  if (!room.storageId) await tx.update(campRooms).set({ storageId: declaration.executionPool.storageId }).where(eq(campRooms.id, room.id));
  if (!goal.executionPool) await tx.update(campGoals).set({ executionPool: declaration.executionPool }).where(eq(campGoals.id, goal.id));
}
