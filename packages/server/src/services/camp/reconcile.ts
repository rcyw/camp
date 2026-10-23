import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../../db/index";
import { campGoals, campRooms } from "../../db/schema";
import { reconcileCampRoom } from "./runs";

/** Room locks are shared with claim/complete. SKIP LOCKED prevents another
 * replica's sweep from blocking foreground work or reconciling the same room. */
export async function reconcileCampPass(onRoomChanged?: (room: { id: string; channelId: string; serverId: string }) => Promise<void>) {
  const candidates = await getDb().selectDistinct({ roomId: campGoals.roomId, reconciledAt: campRooms.reconciledAt }).from(campGoals)
    .innerJoin(campRooms, eq(campRooms.id, campGoals.roomId))
    .where(or(inArray(campGoals.status, ["queued", "running", "waiting_question", "cancelling"]), sql`exists(select 1 from camp_runs where camp_runs.room_id = ${campRooms.id} and camp_runs.status = 'running')`, sql`exists(select 1 from camp_tasks where camp_tasks.goal_id = ${campGoals.id} and camp_tasks.goal_attempt = ${campGoals.attempt} and camp_tasks.status = 'queued')`, sql`exists(select 1 from camp_operations where camp_operations.goal_id = ${campGoals.id} and camp_operations.goal_attempt = ${campGoals.attempt} and camp_operations.status = 'queued')`))
    .orderBy(sql`${campRooms.reconciledAt} ASC NULLS FIRST`, asc(campGoals.roomId)).limit(100);
  let reconciled = 0;
  for (const candidate of candidates) {
    let room: typeof campRooms.$inferSelect | null;
    try {
      room = await getDb().transaction(async tx => {
        const [locked] = await tx.select().from(campRooms).where(eq(campRooms.id, candidate.roomId)).for("update", { skipLocked: true });
        if (!locked) return null;
        await reconcileCampRoom(tx, locked);
        await tx.update(campRooms).set({ reconciledAt: sql`clock_timestamp()` }).where(eq(campRooms.id, locked.id));
        return locked;
      });
    } catch (error) {
      console.error("[CampReconciler] room transition failed", candidate.roomId, error);
      // The failed lifecycle transaction rolled back. Rotate only its scan
      // cursor in a fresh transaction, so a temporarily fenced/invalid room
      // cannot occupy the oldest 100 slots forever. Never wait on a new owner.
      await getDb().transaction(async tx => {
        const [locked] = await tx.select({ id: campRooms.id }).from(campRooms).where(eq(campRooms.id, candidate.roomId)).for("update", { skipLocked: true });
        if (locked) await tx.update(campRooms).set({ reconciledAt: sql`clock_timestamp()` }).where(eq(campRooms.id, locked.id));
      });
      continue;
    }
    if (room) {
      reconciled++;
      try { await onRoomChanged?.(room); }
      catch (error) { console.error("[CampReconciler] room notification failed", room.id, error); }
    }
  }
  return reconciled;
}

export function startCampReconciler(onRoomChanged?: (room: { id: string; channelId: string; serverId: string }) => Promise<void>, intervalMs = 5000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await reconcileCampPass(onRoomChanged); }
    catch (error) { console.error("[CampReconciler] pass failed", error); }
    if (!stopped) { timer = setTimeout(() => { void tick(); }, intervalMs); timer.unref(); }
  };
  void tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
