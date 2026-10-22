import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from "express";
import type { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { emitTaskCreated, emitTaskUpdated } from "../services/taskRealtimeEvents";
import { projectMessageSocketPayload } from "../services/messageRealtimeEvents";
import * as rooms from "../services/camp/rooms";
import * as runs from "../services/camp/runs";
import * as goals from "../services/camp/goals";
import { CAMP_ROLES, CampError, type CampPrincipal } from "../services/camp/types";

export const campRouter: RouterType = Router();
export const campWorkerRouter: RouterType = Router();
const role = z.enum(CAMP_ROLES);
const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);
const artifact = z.object({ type: z.string().min(1).max(100) }).catchall(z.unknown());
const roomInput = z.object({
  channelId: id, name: z.string().trim().min(1).max(120),
  project: z.object({ name: z.string().trim().min(1).max(200), repoPath: z.string().max(4096).optional(), storePath: z.string().max(4096).optional(), baseRef: z.string().max(1024).optional() }),
  roles: z.array(z.object({ role, agentId: id.optional(), instructions: z.string().max(16000).optional() })).length(3).optional(),
});
const budgetInput = z.object({ maxRuns: z.number().int().min(1).max(100).optional(), maxReviewRounds: z.number().int().min(1).max(20).optional(), maxDurationSeconds: z.number().int().min(1).max(86400).optional() });
const pipelineInput = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(16000).optional(), role: role.optional(), dependsOn: z.array(id).max(100).optional(), budget: budgetInput.optional() });
const leaseInput = z.object({ workerId: z.string().trim().min(1).max(200), epoch: z.number().int().positive() });
const eventInput = z.object({ workerId: z.string().max(200).optional(), epoch: z.number().int().positive(), type: z.enum(["progress", "artifact", "question", "handoff"]), content: text, artifact: artifact.optional(), toRole: role.optional() });
const completionInput = leaseInput.extend({ status: z.enum(["completed", "failed", "cancelled"]), summary: text, artifacts: z.array(artifact).max(30).optional(), sessionId: z.string().max(1024).optional(), error: z.string().max(16000).optional(), outcome: z.enum(["approved", "changes_requested", "handoff"]).optional() });
const principal = (res: Response): CampPrincipal => res.locals.campPrincipal;

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(error => {
      if (error instanceof CampError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid Camp request", code: "invalid_input", issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) }); return; }
      next(error);
    });
  };
}

async function emitState(req: Request, roomId: string, created = false) {
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) return;
  const state = await rooms.roomSnapshot(roomId);
  const target = { channelId: state.room.channelId, channelType: "channel" as const, serverId: state.room.serverId };
  const canonicalTasks = state.tasks.map(task => ({ ...task, status: task.taskStatus }));
  if (created) emitTaskCreated(io, target, { channelId: target.channelId, tasks: canonicalTasks });
  else for (const task of canonicalTasks) emitTaskUpdated(io, target, { channelId: target.channelId, task });
  io.to(`channel:${target.channelId}`).emit("camp:updated", { roomId });
}

async function emitMessage(req: Request, effect: Awaited<ReturnType<typeof runs.recordRunEvent>>) {
  const io = req.app.get("io") as SocketServer | undefined;
  if (!io) return;
  const [sender] = await getDb().select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, effect.message.senderId));
  // Camp events reach people in this channel. They deliberately never invoke
  // Raft's broad agent-delivery path; the Camp worker alone schedules role work.
  io.to(`channel:${effect.room.channelId}`).emit("message:new", projectMessageSocketPayload(effect.message, sender?.displayName ?? sender?.name ?? "Camp"));
  io.to(`channel:${effect.room.channelId}`).emit("camp:updated", { roomId: effect.room.id });
}

campRouter.get("/rooms", endpoint(async (req, res) => {
  const channelId = req.query.channelId === undefined ? undefined : id.parse(req.query.channelId);
  const all = await rooms.listRooms(req.serverId!, req.userId!);
  res.json({ rooms: channelId ? all.filter(room => room.channelId === channelId) : all });
}));
campRouter.post("/rooms", endpoint(async (req, res) => {
  res.status(201).json(await rooms.createRoom(req.serverId!, req.userId!, roomInput.parse(req.body)));
}));
campRouter.get("/rooms/:roomId", endpoint(async (req, res) => {
  await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await rooms.roomSnapshot(id.parse(req.params.roomId), req.userId!));
}));
campRouter.post("/rooms/:roomId/tasks", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const created = await rooms.createPipeline(room.id, req.userId!, pipelineInput.parse(req.body));
  const io = req.app.get("io") as SocketServer | undefined;
  if (io) for (const message of created.hostMessages) io.to(`channel:${room.channelId}`).emit("message:new", projectMessageSocketPayload(message, "Camp"));
  await emitState(req, room.id, true);
  res.status(201).json(await rooms.roomSnapshot(room.id, req.userId!));
}));
campRouter.post("/rooms/:roomId/goals/:goalId/retry", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ expectedAttempt: z.number().int().positive(), budget: budgetInput.optional() }).parse(req.body);
  await goals.retryGoal(room.id, id.parse(req.params.goalId), req.userId!, body.expectedAttempt, body.budget);
  await emitState(req, room.id, true);
  res.json(await rooms.roomSnapshot(room.id, req.userId!));
}));
campRouter.post("/rooms/:roomId/goals/:goalId/cancel", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  await goals.cancelGoal(room.id, id.parse(req.params.goalId), req.userId!);
  await emitState(req, room.id);
  res.json(await rooms.roomSnapshot(room.id, req.userId!));
}));
campRouter.post("/rooms/:roomId/worker-token", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  await rooms.requireCampAdmin(req.serverId!, req.userId!);
  res.status(201).json(await rooms.mintWorkerToken(room.id, req.userId!));
}));
campRouter.post("/rooms/:roomId/worker-tokens/:tokenId/revoke", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  await rooms.requireCampAdmin(req.serverId!, req.userId!);
  const tokenId = id.parse(req.params.tokenId);
  await rooms.revokeWorkerToken(room.id, tokenId, req.userId!);
  res.json({ revoked: true });
}));
campRouter.post("/rooms/:roomId/runs/:runId/cancel", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  await rooms.requireCampAdmin(req.serverId!, req.userId!);
  const result = await runs.cancelRun(room.id, id.parse(req.params.runId), req.userId!);
  await emitState(req, room.id);
  res.json({ run: result.run });
}));

campWorkerRouter.use((req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) { res.status(401).json({ error: "A Camp credential is required", code: "camp_auth_required" }); return; }
  void runs.authenticateCampToken(token).then(value => { res.locals.campPrincipal = value; next(); }).catch(error => {
    if (error instanceof CampError) res.status(error.status).json({ error: error.message, code: error.code });
    else next(error);
  });
});
campWorkerRouter.post("/claim", endpoint(async (req, res) => {
  const body = leaseInput.omit({ epoch: true }).extend({ claimId: id.optional(), runToken: z.string().regex(/^camp_run_[A-Za-z0-9_-]{32,128}$/).optional() }).refine(value => Boolean(value.claimId) === Boolean(value.runToken), "claimId and runToken must be supplied together").parse(req.body);
  const claim = await runs.claimRunDetailed(principal(res), body.workerId, body.claimId ? { claimId: body.claimId, runToken: body.runToken! } : undefined);
  if (claim.run) await emitState(req, claim.run.roomId);
  res.json(claim);
}));
campWorkerRouter.get("/reconcile", endpoint(async (req, res) => {
  res.json(await runs.workerStates(principal(res), leaseInput.shape.workerId.parse(req.query.workerId)));
}));
campWorkerRouter.get("/runs/:runId/state", endpoint(async (req, res) => {
  res.json(await runs.runState(principal(res), id.parse(req.params.runId)));
}));
campWorkerRouter.post("/runs/:runId/cleanup", endpoint(async (req, res) => {
  const body = leaseInput.parse(req.body);
  const result = await runs.confirmRunCleanup(principal(res), id.parse(req.params.runId), body.workerId, body.epoch);
  await emitState(req, result.room.id);
  const { room: _, ...state } = result;
  res.json(state);
}));
campWorkerRouter.post("/runs/:runId/heartbeat", endpoint(async (req, res) => {
  const body = leaseInput.parse(req.body);
  res.json(await runs.heartbeatRun(principal(res), id.parse(req.params.runId), body.workerId, body.epoch));
}));
campWorkerRouter.get("/runs/:runId/context", endpoint(async (req, res) => {
  res.json(await runs.runContext(principal(res), id.parse(req.params.runId)));
}));
campWorkerRouter.post("/runs/:runId/events", endpoint(async (req, res) => {
  const effect = await runs.recordRunEvent(principal(res), id.parse(req.params.runId), eventInput.parse(req.body));
  await emitMessage(req, effect);
  res.status(201).json({ event: effect.event, message: { id: effect.message.id, content: effect.message.content, createdAt: effect.message.createdAt } });
}));
campWorkerRouter.post("/runs/:runId/complete", endpoint(async (req, res) => {
  const body = completionInput.parse(req.body);
  const effect = await runs.completeRun(principal(res), id.parse(req.params.runId), body.workerId, body.epoch, body);
  if (!effect.replayed) {
    await emitMessage(req, effect);
    await emitState(req, effect.room.id);
  }
  res.json({ run: effect.run, replayed: effect.replayed });
}));
campWorkerRouter.get("/rooms/:roomId/messages", endpoint(async (req, res) => {
  if (id.parse(req.params.roomId) !== principal(res).roomId) throw new CampError(404, "room_not_found", "Room not found");
  const after = req.query.after === undefined ? undefined : id.parse(req.query.after);
  res.json(await rooms.roomMessages(id.parse(req.params.roomId), after));
}));
campWorkerRouter.post("/rooms/:roomId/messages", endpoint(async (req, res) => {
  if (id.parse(req.params.roomId) !== principal(res).roomId) throw new CampError(404, "room_not_found", "Room not found");
  const body = eventInput.omit({ type: true }).extend({ runId: id, kind: z.enum(["progress", "question", "handoff"]).default("progress") }).parse(req.body);
  const effect = await runs.recordRunEvent(principal(res), body.runId, { ...body, type: body.kind });
  await emitMessage(req, effect);
  res.status(201).json({ message: { id: effect.message.id, content: effect.message.content, createdAt: effect.message.createdAt }, event: effect.event });
}));
