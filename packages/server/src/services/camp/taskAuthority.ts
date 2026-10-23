import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { isInTransaction } from "../../db/ambientTransaction";
import { campTasks } from "../../db/schema";

/** This authority is process-local and never accepted from HTTP input. The
 * lifecycle caller already owns the Room lock; ordinary writers must not take
 * that lock after a channel lock and invert Camp's Room -> channel lock order. */
type Grant = { roomId: string; taskId: string; active: boolean };
const authority = new AsyncLocalStorage<Grant>();
export class CampTaskOwnershipError extends Error {
  readonly status = 409;
  readonly code = "camp_task_owned";
  constructor() {
    super("This task is managed by Camp. Use the Camp goal or run controls to cancel or retry it; submit a new goal to change its instructions.");
    this.name = "CampTaskOwnershipError";
  }
}

export async function assertCampTaskMutation(executor: DatabaseExecutor, taskId: string): Promise<void> {
  const [binding] = await executor.select({ roomId: campTasks.roomId }).from(campTasks).where(eq(campTasks.taskId, taskId));
  if (!binding) return;
  const grant = authority.getStore();
  if (!grant?.active || grant.taskId !== taskId || grant.roomId !== binding.roomId) throw new CampTaskOwnershipError();
}

/** Exact task/Room scope for existing canonical writers. Keep this around the
 * awaited writer only; a detached promise cannot retain authority after return. */
export async function withCampTaskMutation<T>(roomId: string, taskId: string, work: () => Promise<T>): Promise<T> {
  if (!isInTransaction()) throw new Error("Camp task authority requires the lifecycle transaction and Room lock");
  const [binding] = await getDb().select({ roomId: campTasks.roomId }).from(campTasks).where(eq(campTasks.taskId, taskId));
  if (!binding || binding.roomId !== roomId) throw new CampTaskOwnershipError();
  const grant: Grant = { roomId, taskId, active: true };
  try { return await authority.run(grant, work); }
  finally { grant.active = false; }
}
