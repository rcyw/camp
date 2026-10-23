import { CampProtocolError, parseCandidate, parseChangeSet, parseIntegrationReport, parseVerificationReport, serverProtocol } from "../../../camp-protocol/src/index.js";
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from "express";
import type { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, campRooms } from "../db/schema";
import { emitTaskCreated, emitTaskUpdated } from "../services/taskRealtimeEvents";
import { projectMessageSocketPayload } from "../services/messageRealtimeEvents";
import * as rooms from "../services/camp/rooms";
import * as runs from "../services/camp/runs";
import * as goals from "../services/camp/goals";
import * as plans from "../services/camp/plans";
import * as questions from "../services/camp/questions";
import * as storage from "../services/camp/storage";
import { setVerificationPolicy } from "../services/camp/verification";
import { goalVersions, versionChanges, versionVerification } from "../services/camp/changes";
import { goalResultManifest } from "../services/camp/presentation";
import { CAMP_ROLES, CampError, type CampPrincipal } from "../services/camp/types";
import { CAMP_ARTIFACTS_MAX_BYTES } from "./campRequestLimits";
import { recordWorkerPreflight, updateProject, workerSetup } from "../services/camp/setup";
import { campArtifactWorkerRouter } from "./camp.artifacts";
import { renewWorkerCredential } from "../services/camp/workerCredentials";

export const campRouter: RouterType = Router();
export const campWorkerRouter: RouterType = Router();
const role = z.enum(CAMP_ROLES);
const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);
const artifact = z.object({ type: z.string().min(1).max(100) }).catchall(z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= CAMP_ARTIFACTS_MAX_BYTES, "Artifact exceeds its aggregate byte budget");
const artifactList = z.array(artifact).max(30).refine(value => Buffer.byteLength(JSON.stringify(value)) <= CAMP_ARTIFACTS_MAX_BYTES, "Artifacts exceed their aggregate byte budget");
const runtimeCandidate = z.unknown().transform(value => parseCandidate(value));
const projectPath = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Project paths cannot contain control characters");
const projectInput = z.object({ name: z.string().trim().min(1).max(200), repoPath: projectPath.optional(), storePath: projectPath.optional(), baseRef: z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Project references cannot contain control characters").optional() }).strict();
const roomInput = z.object({
  channelId: id, name: z.string().trim().min(1).max(120),
  project: projectInput,
  roles: z.array(z.object({ role, agentId: id.optional(), instructions: z.string().max(16000).optional() })).length(3).optional(),
});
const budgetInput = z.object({ maxRuns: z.number().int().min(1).max(100).optional(), maxReviewRounds: z.number().int().min(1).max(20).optional(), maxDurationSeconds: z.number().int().min(1).max(86400).optional() });
const pipelineInput = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(16000).optional(), role: role.optional(), dependsOn: z.array(id).max(100).optional(), budget: budgetInput.optional(), workflow: z.enum(["serial", "legacy"]).optional(), fromGoalId: id.optional(), planMode: z.enum(["sequential", "same_baseline_pair", "parallel_pair", "bounded_dag"]).optional() }).strict();
const leaseInput = z.object({ workerId: z.string().trim().min(1).max(200), epoch: z.number().int().positive() });
const pluginIdentity = { epoch: leaseInput.shape.epoch, workerId: leaseInput.shape.workerId.optional(), runId: id.optional() };
const eventInput = z.object({ workerId: z.string().max(200).optional(), epoch: z.number().int().positive(), type: z.enum(["progress", "artifact", "question", "handoff"]), content: text, artifact: artifact.optional(), toRole: role.optional() });
const completionInput = leaseInput.extend({ status: z.enum(["completed", "failed", "cancelled", "suspended"]), summary: text, artifacts: artifactList.optional(), sessionId: z.string().max(1024).optional(), error: z.string().max(16000).optional(), outcome: z.enum(["approved", "changes_requested", "handoff"]).optional(), inputCandidate: runtimeCandidate.optional(), candidate: runtimeCandidate.optional(), questionId: id.optional(), changeSet: z.unknown().transform(value => parseChangeSet(value)).optional(), verification: z.unknown().transform(value => parseVerificationReport(value)).optional(), integration: z.unknown().transform(value => parseIntegrationReport(value)).optional() });
const principal = (res: Response): CampPrincipal => res.locals.campPrincipal;

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.params.runId && req.body?.runId !== undefined && req.body.runId !== req.params.runId) { res.status(400).json({ code: "run_identifier_mismatch", error: "Body runId must match the authenticated run route" }); return; }
    void handler(req, res).catch(error => {
      if (error instanceof CampError || error instanceof CampProtocolError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
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
campRouter.put("/rooms/:roomId/verification-policy", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ policy: z.unknown().nullable(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict().parse(req.body);
  if (!("policy" in body)) throw new CampError(400, "invalid_verification_policy", "Provide a policy or explicit null");
  await setVerificationPolicy(room.id, req.userId!, body.policy, body.expectedDigest);
  await emitState(req, room.id);
  res.json(await rooms.roomSnapshot(room.id, req.userId!));
}));
campRouter.put("/rooms/:roomId/project", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ project: projectInput, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
  await updateProject(room.id, req.userId!, body.project, body.expectedDigest);
  await emitState(req, room.id);
  res.json(await rooms.roomSnapshot(room.id, req.userId!));
}));
campRouter.get("/rooms/:roomId/storage", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await storage.userStorageSnapshot(room.id, req.userId!));
}));
campRouter.get("/rooms/:roomId/storage-operations/:operationId", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await storage.userStorageOperation(room.id, id.parse(req.params.operationId), req.userId!));
}));
campRouter.post("/rooms/:roomId/storage-operations", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ requestId: id, kind: z.enum(["backup", "migration"]), expectedEpoch: z.number().int().positive(), expectedAcceptedRevision: z.number().int().positive(), backupOperationId: id.optional() }).strict().parse(req.body);
  const result = await storage.createStorageOperation(room.id, req.userId!, body);
  await emitState(req, room.id); res.status(201).json(result);
}));
campRouter.post("/rooms/:roomId/storage-operations/:operationId/activate", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ expectedEpoch: z.number().int().positive(), expectedTargetStorageId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
  const result = await storage.activateStorage(room.id, id.parse(req.params.operationId), req.userId!, body.expectedEpoch, body.expectedTargetStorageId);
  await emitState(req, room.id); res.json(result);
}));
campRouter.post("/rooms/:roomId/storage-operations/:operationId/cancel", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  z.object({}).strict().parse(req.body ?? {});
  const result = await storage.cancelStorage(room.id, id.parse(req.params.operationId), req.userId!);
  await emitState(req, room.id); res.json(result);
}));
campRouter.get("/rooms/:roomId/goals/:goalId/versions", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await goalVersions(room.id, id.parse(req.params.goalId)));
}));
campRouter.get("/rooms/:roomId/goals/:goalId/versions/:runId/changes", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await versionChanges(room.id, id.parse(req.params.goalId), id.parse(req.params.runId)));
}));
campRouter.get("/rooms/:roomId/goals/:goalId/versions/:runId/verification", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await versionVerification(room.id, id.parse(req.params.goalId), id.parse(req.params.runId)));
}));
campRouter.get("/rooms/:roomId/goals/:goalId/result", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  res.json(await goalResultManifest(room.id, id.parse(req.params.goalId)));
}));
campRouter.post("/rooms/:roomId/questions/:questionId/answer", endpoint(async (req, res) => {
  const room = await rooms.roomForUser(id.parse(req.params.roomId), req.serverId!, req.userId!);
  const body = z.object({ answer: text }).strict().parse(req.body);
  await questions.answerQuestionByHuman(room.id, id.parse(req.params.questionId), req.userId!, body.answer);
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

export function authenticateCampRequest(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) { res.status(401).json({ error: "A Camp credential is required", code: "camp_auth_required" }); return; }
  void runs.authenticateCampToken(token).then(value => { res.locals.campPrincipal = value; next(); }).catch(error => {
    if (error instanceof CampError) res.status(error.status).json({ error: error.message, code: error.code });
    else next(error);
  });
}
campWorkerRouter.use(authenticateCampRequest);
campWorkerRouter.use(campArtifactWorkerRouter);
campWorkerRouter.post("/credential/renew", endpoint(async (req, res) => {
  z.object({}).strict().parse(req.body);
  res.json(await renewWorkerCredential(principal(res)));
}));
campWorkerRouter.get("/protocol", endpoint(async (_req, res) => {
  runs.requireWorker(principal(res));
  res.json(serverProtocol());
}));
campWorkerRouter.get("/setup", endpoint(async (_req, res) => {
  res.json(await workerSetup(principal(res)));
}));
campWorkerRouter.post("/preflight", endpoint(async (req, res) => {
  runs.requireWorker(principal(res));
  const body = z.object({ workerId: leaseInput.shape.workerId, projectDigest: z.string().regex(/^[a-f0-9]{64}$/), report: z.unknown() }).strict().parse(req.body);
  const observation = await recordWorkerPreflight(principal(res), body.workerId, body.projectDigest, body.report);
  const io = req.app.get("io") as SocketServer | undefined;
  if (io) {
    const [room] = await getDb().select({ channelId: campRooms.channelId }).from(campRooms).where(eq(campRooms.id, observation.roomId));
    if (room) io.to(`channel:${room.channelId}`).emit("camp:updated", { roomId: observation.roomId });
  }
  res.json(observation);
}));
campWorkerRouter.get("/storage-operations/:operationId", endpoint(async (req, res) => {
  res.json(await storage.readWorkerStorageOperation(principal(res), id.parse(req.params.operationId)));
}));
campWorkerRouter.post("/storage-operations/:operationId/backup", endpoint(async (req, res) => {
  const result = await storage.recordStorageBackup(principal(res), id.parse(req.params.operationId), req.body);
  await emitState(req, principal(res).roomId); res.json(result);
}));
campWorkerRouter.post("/storage-operations/:operationId/restore", endpoint(async (req, res) => {
  const result = await storage.recordStorageRestore(principal(res), id.parse(req.params.operationId), req.body);
  await emitState(req, principal(res).roomId); res.json(result);
}));
campWorkerRouter.post("/claim", endpoint(async (req, res) => {
  const body = leaseInput.omit({ epoch: true }).extend({ claimId: id.optional(), runToken: z.string().regex(/^camp_run_[A-Za-z0-9_-]{32,128}$/).optional(), protocol: z.unknown().optional(), restoreOnly: z.boolean().optional() }).strict().refine(value => Boolean(value.claimId) === Boolean(value.runToken), "claimId and runToken must be supplied together").refine(value => !value.restoreOnly || Boolean(value.claimId), "restoreOnly requires claimId and runToken").parse(req.body);
  const claim = await runs.claimRunDetailed(principal(res), body.workerId, body.claimId ? { claimId: body.claimId, runToken: body.runToken! } : undefined, body.protocol as Parameters<typeof runs.claimRunDetailed>[3], body.restoreOnly);
  if (claim.run) await emitState(req, claim.run.roomId);
  else if (claim.compatibility) {
    const io = req.app.get("io") as SocketServer | undefined;
    if (io) {
      const room = await rooms.roomSnapshot(principal(res).roomId);
      io.to(`channel:${room.room.channelId}`).emit("camp:updated", { roomId: room.room.id });
    }
  }
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
campWorkerRouter.get("/goals/:goalId/result", endpoint(async (req, res) => {
  runs.requireWorker(principal(res));
  res.json(await goalResultManifest(principal(res).roomId, id.parse(req.params.goalId)));
}));
campWorkerRouter.post("/runs/:runId/plan", endpoint(async (req, res) => {
  const body = z.object({ ...pluginIdentity, planRevision: z.union([z.literal(1), z.literal(2)]), summary: text, tasks: z.array(z.unknown()).min(1).max(6) }).strict().parse(req.body);
  const effect = await plans.submitPlan(principal(res), id.parse(req.params.runId), body);
  if (!effect.replayed) await emitState(req, effect.room.id);
  res.json({ plan: effect.plan, replayed: effect.replayed });
}));
campWorkerRouter.post("/runs/:runId/finalize", endpoint(async (req, res) => {
  const body = z.object({ ...pluginIdentity, summary: text, evidence: text.optional(), remaining: z.array(z.string().trim().min(1).max(4000)).max(20).optional() }).strict().parse(req.body);
  const effect = await plans.finalizeGoal(principal(res), id.parse(req.params.runId), body);
  if (!effect.replayed) await emitState(req, effect.room.id);
  res.json({ summary: effect.summary, candidate: effect.candidate, replayed: effect.replayed });
}));
campWorkerRouter.post("/runs/:runId/questions", endpoint(async (req, res) => {
  const body = z.object({ ...pluginIdentity, questionId: id, content: text, toRole: role, needsHuman: z.boolean().optional() }).strict().parse(req.body);
  const effect = await questions.askQuestion(principal(res), id.parse(req.params.runId), body);
  if (!effect.replayed) await emitState(req, effect.room.id);
  res.json({ question: effect.question, requiresSuspension: effect.requiresSuspension, replayed: effect.replayed });
}));
campWorkerRouter.post("/runs/:runId/questions/:questionId/answer", endpoint(async (req, res) => {
  const body = z.object({ ...pluginIdentity, answer: text }).strict().parse(req.body);
  const effect = await questions.answerQuestionByRole(principal(res), id.parse(req.params.runId), id.parse(req.params.questionId), body);
  if (!effect.replayed) await emitState(req, effect.room.id);
  res.json({ question: effect.question, replayed: effect.replayed });
}));
campWorkerRouter.post("/runs/:runId/questions/:questionId/escalate", endpoint(async (req, res) => {
  const body = z.object({ ...pluginIdentity, reason: text }).strict().parse(req.body);
  const effect = await questions.escalateQuestion(principal(res), id.parse(req.params.runId), id.parse(req.params.questionId), body);
  if (!effect.replayed) await emitState(req, effect.room.id);
  res.json({ question: effect.question, replayed: effect.replayed });
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
    if (effect.message) await emitMessage(req, { ...effect, message: effect.message });
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
