import { assertStorageWritable, storageSnapshot } from "./storage";
import { roomOccupancy } from "./executionPool";
import { CAMP_PROTOCOL_VERSION } from "../../../../camp-protocol/src/index.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { asServerId } from "@botiverse/raft-shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { agents, campEvents, campGoals, campOperations, campRooms, campRuns, campTasks, campWorkerTokens, channelAgents, channels, messages } from "../../db/schema";
import { getActorServerRoleInServer } from "../../lib/actorPermissions";
import { lockActorMembershipRow } from "../../lib/actorMembershipFence";
import { assertAgentHandleAvailableInServer, lockServerPrincipalHandles } from "../principalHandleService";
import { serverAgentMembers } from "../../db/schema";
import { addAgent, canUserAccessChannel, canUserPostToChannel } from "../channelService";
import { createAttemptTasks, goalSnapshots, normalizeBudget } from "./goals";
import { CAMP_ROLES, CampError, DEFAULT_CAMP_BUDGET, DEFAULT_SERIAL_CAMP_BUDGET, type CampBudget, type CampProject, type CampRole, type CampRoleConfig, type CampWorkflow } from "./types";
import { assertChannelWritableInTransaction } from "../channelConversionFenceService";
import { operationSnapshots } from "./verification";
import { workerSnapshots } from "./workerCompatibility";
import { assertRoomAdmission } from "./workflow";
import { roomSetup } from "./setup";

export const hashCampToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newCampToken = (kind: "worker" | "run") => `camp_${kind}_${randomBytes(32).toString("base64url")}`;

export async function requireCampAdmin(serverId: string, userId: string) {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (role !== "owner" && role !== "admin") throw new CampError(403, "camp_admin_required", "A server administrator must configure Camp");
}

export async function roomForUser(roomId: string, serverId: string, userId: string) {
  const [room] = await getDb().select().from(campRooms).where(and(eq(campRooms.id, roomId), eq(campRooms.serverId, serverId)));
  if (!room || !await canUserAccessChannel(room.channelId, userId, asServerId(serverId))) throw new CampError(404, "room_not_found", "Room not found");
  return room;
}

export async function createRoom(serverId: string, userId: string, input: {
  channelId: string; name: string; project: CampProject;
  roles?: Array<{ role: CampRole; agentId?: string; instructions?: string }>;
}) {
  await requireCampAdmin(serverId, userId);
  const [channel] = await getDb().select().from(channels).where(and(eq(channels.id, input.channelId), eq(channels.serverId, serverId), isNull(channels.deletedAt), isNull(channels.archivedAt)));
  if (!channel || !["channel", "private"].includes(channel.type) || !await canUserAccessChannel(channel.id, userId, asServerId(serverId))) {
    throw new CampError(404, "channel_not_found", "An accessible, active local channel is required");
  }
  const [existing] = await getDb().select({ id: campRooms.id }).from(campRooms).where(eq(campRooms.channelId, channel.id));
  if (existing) throw new CampError(409, "room_exists", "This channel already has a Camp room");
  const id = randomUUID();
  const requested: Array<{ role: CampRole; agentId?: string; instructions?: string }> = input.roles ?? CAMP_ROLES.map(role => ({ role }));
  if (requested.length !== 3 || new Set(requested.map(r => r.role)).size !== 3) {
    throw new CampError(400, "roles_required", "Configure planner, builder and reviewer exactly once");
  }
  return getDb().transaction(async tx => {
    const membership = await lockActorMembershipRow(tx, serverId, userId);
    if (membership !== "owner" && membership !== "admin") throw new CampError(403, "camp_admin_required", "A server administrator must configure Camp");
    await lockServerPrincipalHandles(tx, serverId);
    // Conversion takes its exclusive advisory fence before channel writes.
    await assertChannelWritableInTransaction(tx, channel.id);
    // The server handle fence serializes concurrent admissions. Recheck before
    // creating any role identities rather than surfacing a unique-key 500.
    const [existingRoom] = await tx.select({ id: campRooms.id }).from(campRooms).where(eq(campRooms.channelId, channel.id));
    if (existingRoom) throw new CampError(409, "room_exists", "This channel already has a Camp room");
    // Existing identities may also be roles of another Room. Acquire them in
    // the same stable order as that Room's lifecycle, never request role order.
    const existingIdentities = [...new Set(requested.flatMap(role => role.agentId ? [role.agentId] : []))].sort();
    if (existingIdentities.length) await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, existingIdentities)).orderBy(asc(agents.id)).for("share");
    const roles: CampRoleConfig[] = [];
    // These external identities own no paid engine/runtime allocation. Keep
    // their canonical identity, membership and room binding in one commit.
    for (const role of requested) {
      let agentId = role.agentId;
      if (!agentId) {
        const name = `camp-${role.role}-${id.slice(0, 8)}`;
        await assertAgentHandleAvailableInServer(tx, serverId, name);
        const [agent] = await tx.insert(agents).values({ serverId, name, displayName: `Camp ${role.role}`, runtime: "external", model: "external", creatorType: "user", creatorId: userId }).returning();
        agentId = agent.id;
        await tx.insert(serverAgentMembers).values({ serverId, agentId, role: "member" });
      }
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt))).for("share");
      if (!agent || agent.runtime !== "external") throw new CampError(400, "external_agent_required", "Camp roles require external agent identities so only the Camp worker starts runs");
      const [membership] = await tx.select({ agentId: serverAgentMembers.agentId }).from(serverAgentMembers).where(and(eq(serverAgentMembers.agentId, agentId), eq(serverAgentMembers.serverId, serverId)));
      if (!membership) throw new CampError(400, "agent_server_membership_required", "Camp role identities must be current members of this server");
      roles.push({ ...role, agentId });
    }
    if (new Set(roles.map(r => r.agentId)).size !== 3) throw new CampError(400, "distinct_agents_required", "Each role needs its own agent identity");
    for (const role of roles) await addAgent(channel.id, role.agentId, { executor: tx });
    // Freeze the active channel and recheck all installed roles before this
    // Room becomes visible. New membership inserts already hold the channel's
    // immediate FK lock; existing ON CONFLICT DO NOTHING rows are checked
    // again below. The admission fence serialized competing Room creations.
    const [activeChannel] = await tx.select({ id: channels.id }).from(channels).where(and(eq(channels.id, channel.id), eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt), isNull(channels.archivedAt))).for("share");
    if (!activeChannel || !await canUserAccessChannel(channel.id, userId, asServerId(serverId))) throw new CampError(404, "channel_not_found", "An accessible, active local channel is required");
    const installedRoles = await tx.select({ agentId: channelAgents.agentId }).from(channelAgents).where(and(eq(channelAgents.channelId, channel.id), inArray(channelAgents.agentId, roles.map(role => role.agentId)))).orderBy(asc(channelAgents.agentId)).for("share");
    if (installedRoles.length !== roles.length) throw new CampError(409, "role_membership_changed", "Room role membership changed during creation; retry configuration");
    const [room] = await tx.insert(campRooms).values({ id, serverId, channelId: channel.id, name: input.name, project: input.project, roles, createdByUserId: userId }).returning();
    return room;
  });
}

export async function listRooms(serverId: string, userId: string) {
  const rooms = await getDb().select().from(campRooms).where(eq(campRooms.serverId, serverId)).orderBy(desc(campRooms.createdAt));
  const visible = [];
  for (const room of rooms) if (await canUserAccessChannel(room.channelId, userId, asServerId(serverId))) visible.push(room);
  return visible;
}

/** Identity cleanup (deleteAgent) locks agent before releasing canonical tasks.
 * All Camp paths use the same order, including a claim's preliminary sweep. */
export async function lockRoomTaskIdentities(tx: DatabaseExecutor, room: typeof campRooms.$inferSelect) {
  const ids = [...new Set(room.roles.map(role => role.agentId))].sort();
  if (ids.length) await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids)).orderBy(asc(agents.id)).for("update");
}

/** Hold an active local channel through the lifecycle commit. A plain read
 * allows archive/delete to commit after authorization but before acceptance.
 * Always take the conversion advisory fence BEFORE the channel row lock. */
export async function lockRoomChannel(tx: DatabaseExecutor, room: typeof campRooms.$inferSelect) {
  const active = and(eq(channels.id, room.channelId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt), isNull(channels.archivedAt));
  // Recovery after lifecycle closure must not acquire a new write capability
  // from a retained conversion fence. This read grants no execution authority;
  // the active path still fences and rechecks under the row lock below.
  const [observed] = await tx.select({ id: channels.id }).from(channels).where(active);
  if (!observed) return false;
  await assertChannelWritableInTransaction(tx, room.channelId);
  const [channel] = await tx.select({ id: channels.id }).from(channels).where(active).for("share");
  return Boolean(channel);
}

export async function lockRoom(tx: DatabaseExecutor, roomId: string) {
  const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, roomId)).for("update");
  if (!room) throw new CampError(404, "room_not_found", "Room not found");
  if (!await lockRoomChannel(tx, room)) throw new CampError(409, "room_unavailable", "The room channel is unavailable");
  await lockRoomTaskIdentities(tx, room);
  return room;
}

export async function withCampRoomAdmin<T>(roomId: string, userId: string, work: (tx: DatabaseExecutor, room: typeof campRooms.$inferSelect) => Promise<T>) {
  const [scope] = await getDb().select({ serverId: campRooms.serverId }).from(campRooms).where(eq(campRooms.id, roomId));
  if (!scope) throw new CampError(404, "room_not_found", "Room not found");
  return getDb().transaction(async tx => {
    const role = await lockActorMembershipRow(tx, scope.serverId, userId);
    if (role !== "owner" && role !== "admin") throw new CampError(403, "camp_admin_required", "A server administrator must configure Camp");
    const room = await lockRoom(tx, roomId);
    if (!await canUserAccessChannel(room.channelId, userId, asServerId(room.serverId))) throw new CampError(404, "room_not_found", "Room not found");
    return work(tx, room);
  });
}

export async function roomSnapshot(roomId: string, userId?: string) {
  const db = getDb();
  const [room] = await db.select().from(campRooms).where(eq(campRooms.id, roomId));
  if (!room) throw new CampError(404, "room_not_found", "Room not found");
  const bindings = await db.select().from(campTasks).where(eq(campTasks.roomId, roomId)).orderBy(asc(campTasks.createdAt));
  // A pipeline's rows share a transaction timestamp. Order ready nodes
  // deterministically so the UI always presents prerequisites first.
  const pending = [...bindings].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
    || CAMP_ROLES.indexOf(left.role) - CAMP_ROLES.indexOf(right.role) || left.taskId.localeCompare(right.taskId));
  const ordered: typeof bindings = [];
  const ids = new Set(bindings.map(binding => binding.taskId));
  const emitted = new Set<string>();
  while (pending.length) {
    const ready = pending.findIndex(binding => binding.dependsOn.every(id => !ids.has(id) || emitted.has(id)));
    // Old malformed data must remain inspectable even if it contains a cycle.
    const [next] = pending.splice(ready < 0 ? 0 : ready, 1);
    ordered.push(next);
    emitted.add(next.taskId);
  }
  const { listTasks } = await import("../taskService");
  const canonical = await listTasks(room.channelId);
  const byId = new Map(canonical.map(task => [task.id, task]));
  const runs = await db.select({
    id: campRuns.id, executor: campRuns.executor, operationId: campRuns.operationId, roomId: campRuns.roomId, taskId: campRuns.taskId, role: campRuns.role,
    agentId: campRuns.agentId, epoch: campRuns.epoch, workerId: campRuns.workerId,
    leaseValid: sql<boolean>`${campRuns.status} = 'running' AND ${campRuns.leaseExpiresAt} > clock_timestamp()`,
    status: campRuns.status, leaseExpiresAt: campRuns.leaseExpiresAt, cancelRequestedAt: campRuns.cancelRequestedAt,
    summary: campRuns.summary, artifacts: campRuns.artifacts, outcome: campRuns.outcome,
    sessionId: campRuns.sessionId, error: campRuns.error, createdAt: campRuns.createdAt, completedAt: campRuns.completedAt,
    goalId: sql<string>`coalesce(${campTasks.goalId}, ${campOperations.goalId})`, goalAttempt: sql<number>`coalesce(${campTasks.goalAttempt}, ${campOperations.goalAttempt})`,
    taskKind: sql<import("./types").CampTaskKind>`case when ${campRuns.executor} <> 'agent' then ${campRuns.executor} else ${campTasks.kind} end`, planItemKey: campTasks.planItemKey, inputCandidate: campRuns.inputCandidate, candidate: campRuns.candidate, questionId: campRuns.questionId, workerProtocol: campRuns.workerProtocol,
  }).from(campRuns).leftJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).leftJoin(campOperations, eq(campOperations.id, campRuns.operationId)).where(eq(campRuns.roomId, roomId)).orderBy(desc(campRuns.createdAt)).limit(200);
  const events = await db.select().from(campEvents).where(eq(campEvents.roomId, roomId)).orderBy(desc(campEvents.seq)).limit(200);
  const cleanupAcks = runs.length ? await db.select({ runId: campEvents.runId }).from(campEvents).where(and(inArray(campEvents.runId, runs.map(run => run.id)), eq(campEvents.type, "cleanup_confirmed"))) : [];
  const confirmed = new Set(cleanupAcks.map(event => event.runId));
  const publicRuns = runs.map(run => ({ ...run, cleanupState: confirmed.has(run.id) || (run.status !== "running" && run.summary !== null) ? "confirmed" as const : run.status === "running" ? "pending" as const : "unknown" as const }));
  const role = userId ? await getActorServerRoleInServer(room.serverId, "user", userId) : null;
  const canSubmit = userId ? await canUserPostToChannel(room.channelId, userId) : false;
  const operations = await operationSnapshots(roomId);
  const goals = await goalSnapshots(roomId, role === "owner" || role === "admin", canSubmit, operations);
  const storage = await storageSnapshot(roomId, role === "owner" || role === "admin");
  const roomBusy = storage.maintenance || (await roomOccupancy(db, roomId)).some(run => run.status !== "running") || goals.some(goal => ["queued", "running", "waiting_question", "cancelling"].includes(goal.status) || goal.activeRuns > 0);
  return { storage, supportedPlanModes: ["sequential", "same_baseline_pair", "parallel_pair", "bounded_dag"], setup: await roomSetup(room), operations, canManage: role === "owner" || role === "admin", workers: await workerSnapshots(roomId), room: { ...room, acceptedHead: { revision: room.acceptedRevision, goalId: room.acceptedGoalId, candidate: room.acceptedCandidate } }, goals, canSubmit, roomBusy, defaultBudget: { serial: DEFAULT_SERIAL_CAMP_BUDGET, legacy: DEFAULT_CAMP_BUDGET }, questions: goals.flatMap(goal => goal.questions), tasks: ordered.map(binding => ({ ...byId.get(binding.taskId), ...binding, id: binding.taskId, executionStatus: binding.status, taskStatus: byId.get(binding.taskId)?.status })), runs: publicRuns, events: events.reverse() };
}

export async function mintWorkerToken(roomId: string, userId: string) {
  return withCampRoomAdmin(roomId, userId, async tx => {
    const token = newCampToken("worker");
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    const [row] = await tx.insert(campWorkerTokens).values({ roomId, tokenHash: hashCampToken(token), expiresAt }).returning({ id: campWorkerTokens.id });
    return { token, tokenId: row.id, roomId, expiresAt: expiresAt.toISOString() };
  });
}

export async function revokeWorkerToken(roomId: string, tokenId: string, userId: string) {
  return withCampRoomAdmin(roomId, userId, async tx => {
    await tx.update(campWorkerTokens).set({ revokedAt: new Date() }).where(and(eq(campWorkerTokens.id, tokenId), eq(campWorkerTokens.roomId, roomId)));
  });
}

export async function createPipeline(roomId: string, userId: string, input: { title: string; description?: string; role?: CampRole; dependsOn?: string[]; budget?: Partial<CampBudget>; workflow?: CampWorkflow; fromGoalId?: string; planMode?: "sequential" | "same_baseline_pair" | "parallel_pair" | "bounded_dag" }) {
  const [scope] = await getDb().select({ serverId: campRooms.serverId }).from(campRooms).where(eq(campRooms.id, roomId));
  if (!scope) throw new CampError(404, "room_not_found", "Room not found");
  return getDb().transaction(async tx => {
    await lockActorMembershipRow(tx, scope.serverId, userId);
    const room = await lockRoom(tx, roomId);
    if (!await canUserPostToChannel(room.channelId, userId)) throw new CampError(403, "camp_post_required", "Channel post access is required to submit work");
    await assertStorageWritable(tx, room.id);
    const selected = input.role ? [input.role] : [...CAMP_ROLES];
    const workflow = input.role ? "legacy" : input.workflow ?? "serial";
    if (["same_baseline_pair", "parallel_pair", "bounded_dag"].includes(input.planMode ?? "") && workflow !== "serial") throw new CampError(400, "serial_workflow_required", "A same-baseline pair requires the serial workflow");
    if (workflow === "serial" && CAMP_PROTOCOL_VERSION >= 2 && !room.verificationPolicy) throw new CampError(409, "verification_policy_required", "Configure an operator verification policy before submitting a new serial goal");
    if (input.role && input.workflow === "serial") throw new CampError(400, "serial_role_not_supported", "A serial goal uses the planner, builder and reviewer roles automatically");
    await assertRoomAdmission(tx, room, workflow);
    if (input.fromGoalId) {
      const [source] = await tx.select().from(campGoals).where(and(eq(campGoals.id, input.fromGoalId), eq(campGoals.roomId, room.id), eq(campGoals.status, "completed")));
      if (workflow !== "serial" || !source || source.id !== room.acceptedGoalId || !room.acceptedCandidate) throw new CampError(409, "invalid_continuation", "Continue only from this Room's current accepted completed goal");
    }
    const dependencies = input.dependsOn ?? [];
    if (workflow === "serial" && dependencies.length) throw new CampError(400, "serial_dependencies_not_supported", "Serial goals continue from the accepted Room head; arbitrary task dependencies remain a legacy feature");
    if (dependencies.length) {
      const found = await tx.select().from(campTasks).where(and(eq(campTasks.roomId, roomId), inArray(campTasks.taskId, dependencies)));
      if (found.length !== new Set(dependencies).size) throw new CampError(400, "invalid_dependencies", "Dependencies must belong to this room");
    }
    const [goal] = await tx.insert(campGoals).values({ protocolVersion: workflow === "serial" ? input.planMode === "bounded_dag" ? 5 : input.planMode === "parallel_pair" ? 4 : input.planMode === "same_baseline_pair" ? 3 : 2 : null, planMode: input.planMode ?? "sequential", verificationPolicy: workflow === "serial" ? room.verificationPolicy : null, roomId, title: input.title, description: input.description, roles: selected, workflow, baseHeadRevision: room.acceptedRevision, fromGoalId: input.fromGoalId ?? room.acceptedGoalId, baseCandidate: workflow === "serial" ? room.acceptedCandidate : null, currentCandidate: workflow === "serial" ? room.acceptedCandidate : null, initialDependsOn: dependencies, budget: normalizeBudget(input.planMode === "bounded_dag" ? { maxRuns: 40, maxReviewRounds: 12, maxDurationSeconds: 3600, ...input.budget } : input.budget, workflow), createdByUserId: userId }).returning();
    const result = await createAttemptTasks(tx, room, goal, "user", userId, dependencies);
    await tx.insert(campEvents).values({ roomId, goalId: goal.id, type: "goal_created", content: input.title });
    return { ...result, roomId, goalId: goal.id };
  });
}

export async function roomMessages(roomId: string, after?: string) {
  const [room] = await getDb().select().from(campRooms).where(eq(campRooms.id, roomId));
  if (!room) throw new CampError(404, "room_not_found", "Room not found");
  const rows = await getDb().select({ id: messages.id, content: messages.content, senderType: messages.senderType, senderId: messages.senderId, createdAt: messages.createdAt, seq: messages.seq })
    .from(messages).where(eq(messages.channelId, room.channelId)).orderBy(desc(messages.seq)).limit(100);
  const ordered = rows.reverse();
  const index = after ? ordered.findIndex(row => row.id === after) : -1;
  const events = await getDb().select().from(campEvents).where(eq(campEvents.roomId, roomId)).orderBy(desc(campEvents.seq)).limit(100);
  return { messages: index >= 0 ? ordered.slice(index + 1) : ordered, events: events.reverse() };
}
