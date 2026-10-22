import { createHash, randomBytes, randomUUID } from "node:crypto";
import { asServerId } from "@botiverse/raft-shared";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { agents, campEvents, campGoals, campRooms, campRuns, campTasks, campWorkerTokens, channels, messages } from "../../db/schema";
import { getActorServerRoleInServer } from "../../lib/actorPermissions";
import { lockActorMembershipRow } from "../../lib/actorMembershipFence";
import { assertAgentHandleAvailableInServer, lockServerPrincipalHandles } from "../principalHandleService";
import { serverAgentMembers } from "../../db/schema";
import { addAgent, canUserAccessChannel, canUserPostToChannel } from "../channelService";
import { createAttemptTasks, goalSnapshots, normalizeBudget } from "./goals";
import { CAMP_ROLES, CampError, type CampBudget, type CampProject, type CampRole, type CampRoleConfig } from "./types";

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

export async function lockRoom(tx: DatabaseExecutor, roomId: string) {
  const [room] = await tx.select().from(campRooms).where(eq(campRooms.id, roomId)).for("update");
  if (!room) throw new CampError(404, "room_not_found", "Room not found");
  const [channel] = await tx.select({ id: channels.id }).from(channels).where(and(eq(channels.id, room.channelId), isNull(channels.deletedAt), isNull(channels.archivedAt)));
  if (!channel) throw new CampError(409, "room_unavailable", "The room channel is unavailable");
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
    id: campRuns.id, roomId: campRuns.roomId, taskId: campRuns.taskId, role: campRuns.role,
    agentId: campRuns.agentId, epoch: campRuns.epoch, workerId: campRuns.workerId,
    status: campRuns.status, leaseExpiresAt: campRuns.leaseExpiresAt, cancelRequestedAt: campRuns.cancelRequestedAt,
    summary: campRuns.summary, artifacts: campRuns.artifacts, outcome: campRuns.outcome,
    sessionId: campRuns.sessionId, error: campRuns.error, createdAt: campRuns.createdAt, completedAt: campRuns.completedAt,
    goalId: campTasks.goalId, goalAttempt: campTasks.goalAttempt,
  }).from(campRuns).innerJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).where(eq(campRuns.roomId, roomId)).orderBy(desc(campRuns.createdAt)).limit(200);
  const events = await db.select().from(campEvents).where(eq(campEvents.roomId, roomId)).orderBy(desc(campEvents.seq)).limit(200);
  const cleanupAcks = runs.length ? await db.select({ runId: campEvents.runId }).from(campEvents).where(and(inArray(campEvents.runId, runs.map(run => run.id)), eq(campEvents.type, "cleanup_confirmed"))) : [];
  const confirmed = new Set(cleanupAcks.map(event => event.runId));
  const publicRuns = runs.map(run => ({ ...run, cleanupState: confirmed.has(run.id) || (run.status !== "running" && run.summary !== null) ? "confirmed" as const : run.status === "running" ? "pending" as const : "unknown" as const }));
  const role = userId ? await getActorServerRoleInServer(room.serverId, "user", userId) : null;
  return { room, goals: await goalSnapshots(roomId, role === "owner" || role === "admin"), tasks: ordered.map(binding => ({ ...byId.get(binding.taskId), ...binding, id: binding.taskId, executionStatus: binding.status, taskStatus: byId.get(binding.taskId)?.status })), runs: publicRuns, events: events.reverse() };
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

export async function createPipeline(roomId: string, userId: string, input: { title: string; description?: string; role?: CampRole; dependsOn?: string[]; budget?: Partial<CampBudget> }) {
  const [scope] = await getDb().select({ serverId: campRooms.serverId }).from(campRooms).where(eq(campRooms.id, roomId));
  if (!scope) throw new CampError(404, "room_not_found", "Room not found");
  return getDb().transaction(async tx => {
    await lockActorMembershipRow(tx, scope.serverId, userId);
    const room = await lockRoom(tx, roomId);
    if (!await canUserPostToChannel(room.channelId, userId)) throw new CampError(403, "camp_post_required", "Channel post access is required to submit work");
    const selected = input.role ? [input.role] : [...CAMP_ROLES];
    const dependencies = input.dependsOn ?? [];
    if (dependencies.length) {
      const found = await tx.select().from(campTasks).where(and(eq(campTasks.roomId, roomId), inArray(campTasks.taskId, dependencies)));
      if (found.length !== new Set(dependencies).size) throw new CampError(400, "invalid_dependencies", "Dependencies must belong to this room");
    }
    const [goal] = await tx.insert(campGoals).values({ roomId, title: input.title, description: input.description, roles: selected, initialDependsOn: dependencies, budget: normalizeBudget(input.budget), createdByUserId: userId }).returning();
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
