import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { campEvents, campGoals, campQuestions, campRooms, campRuns, campTasks } from "../../db/schema";
import { lockActorMembershipRow } from "../../lib/actorMembershipFence";
import { canUserPostToChannel } from "../channelService";
import { bodyHash, currentRunScope, type CampPluginInput } from "./plans";
import { enqueueStage } from "./workflow";
import { lockRoom } from "./rooms";
import { assertGoalDeadline } from "./goals";
import { CampError, type CampCandidate, type CampPrincipal, type CampRole } from "./types";

type Room = typeof campRooms.$inferSelect;
type Goal = typeof campGoals.$inferSelect;
type Binding = typeof campTasks.$inferSelect;
type Run = typeof campRuns.$inferSelect;
type Question = typeof campQuestions.$inferSelect;
function answerText(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 16000) throw new CampError(400, "invalid_answer", "A nonempty answer of at most 16000 characters is required");
  return value.trim();
}
export async function blockingQuestion(tx: DatabaseExecutor, taskId: string, runId: string) {
  const [question] = await tx.select().from(campQuestions).where(and(eq(campQuestions.taskId, taskId), eq(campQuestions.activeRunId, runId), eq(campQuestions.status, "pending"), isNull(campQuestions.resumedAt)));
  return question ?? null;
}
export async function askQuestion(principal: CampPrincipal, runId: string, input: CampPluginInput & { questionId: string; content: string; toRole: CampRole; needsHuman?: boolean }) {
  return getDb().transaction(async tx => {
    const { room, run, binding, goal } = await currentRunScope(tx, principal, runId, input.epoch, input);
    if (binding.kind === "clarification") throw new CampError(409, "clarification_must_answer", "A clarification task must answer or escalate its assigned question");
    const content = answerText(input.content), needsHuman = input.needsHuman ?? false;
    const fingerprint = bodyHash({ content, toRole: input.toRole, needsHuman });
    const [byId] = await tx.select().from(campQuestions).where(eq(campQuestions.id, input.questionId));
    if (byId && (byId.taskId !== binding.taskId || byId.goalAttempt !== goal.attempt || byId.fingerprint !== fingerprint)) throw new CampError(409, "question_conflict", "This question identifier already names a different question");
    const [same] = byId ? [byId] : await tx.select().from(campQuestions).where(and(eq(campQuestions.taskId, binding.taskId), eq(campQuestions.fingerprint, fingerprint)));
    if (same) return { question: same, requiresSuspension: same.status === "pending" && same.activeRunId === run.id, replayed: true, room };
    const [pending] = await tx.select().from(campQuestions).where(and(eq(campQuestions.taskId, binding.taskId), isNull(campQuestions.resumedAt), ne(campQuestions.status, "cancelled")));
    if (pending) throw new CampError(409, "pending_question", "This task already has one unanswered or unconsumed question");
    const [question] = await tx.insert(campQuestions).values({ id: input.questionId, roomId: room.id, goalId: goal.id, goalAttempt: goal.attempt, taskId: binding.taskId, originRunId: run.id, activeRunId: run.id, originEpoch: run.epoch, fromRole: run.role, toRole: input.toRole, needsHuman, content, fingerprint }).returning();
    await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: "question_created", content });
    return { question, requiresSuspension: true, replayed: false, room };
  });
}
export async function suspendForQuestion(tx: DatabaseExecutor, room: Room, goal: Goal, binding: Binding, run: Run, questionId: string | undefined, candidate: CampCandidate) {
  const question = await blockingQuestion(tx, binding.taskId, run.id);
  if (!question || question.id !== questionId) throw new CampError(409, "question_required", "Suspension must name this run's pending durable question");
  if (binding.kind === "clarification") throw new CampError(409, "clarification_must_answer", "Clarifications must answer or escalate instead of recursively suspending");
  await tx.update(campTasks).set({ status: "waiting_question", inputCandidate: candidate }).where(eq(campTasks.taskId, binding.taskId));
  await tx.update(campQuestions).set({ status: question.needsHuman ? "awaiting_human" : "awaiting_role", candidate }).where(eq(campQuestions.id, question.id));
  await tx.update(campGoals).set({ currentCandidate: candidate, status: question.needsHuman ? "waiting_question" : "running" }).where(eq(campGoals.id, goal.id));
  if (!question.needsHuman) {
    const taskId = await enqueueStage(tx, room, goal, { kind: "clarification", candidate, role: question.toRole, questionId: question.id, feedback: `Answer this blocking question with camp_answer_question, or escalate it to a human if you cannot answer. Do not ask a second question.\nQuestion ${question.id} from ${question.fromRole}: ${question.content}` });
    await tx.update(campQuestions).set({ clarificationTaskId: taskId }).where(eq(campQuestions.id, question.id));
  }
}
async function assignedQuestion(tx: DatabaseExecutor, principal: CampPrincipal, runId: string, questionId: string, identity: CampPluginInput) {
  const scope = await currentRunScope(tx, principal, runId, identity.epoch, identity);
  const [question] = await tx.select().from(campQuestions).where(and(eq(campQuestions.id, questionId), eq(campQuestions.roomId, scope.room.id), eq(campQuestions.goalId, scope.goal.id), eq(campQuestions.goalAttempt, scope.goal.attempt)));
  if (!question || scope.binding.kind !== "clarification" || scope.binding.questionId !== question.id || question.clarificationTaskId !== scope.binding.taskId || scope.run.role !== question.toRole) throw new CampError(403, "clarification_task_required", "Only the assigned clarification task may answer or escalate this question");
  return { ...scope, question };
}
export async function answerQuestionByRole(principal: CampPrincipal, runId: string, questionId: string, input: CampPluginInput & { answer: string }) {
  return getDb().transaction(async tx => {
    const { room, run, goal, question } = await assignedQuestion(tx, principal, runId, questionId, input);
    const answer = answerText(input.answer);
    if (question.status === "answered") {
      if (question.answer !== answer || question.answerByRole !== run.role) throw new CampError(409, "answer_conflict", "This question already has a different immutable answer");
      return { question, replayed: true, room };
    }
    if (question.status !== "awaiting_role") throw new CampError(409, "question_not_answerable", "This question is no longer waiting for a role answer");
    const [answered] = await tx.update(campQuestions).set({ status: "answered", answer, answerByRole: run.role, answeredAt: sql`clock_timestamp()` }).where(eq(campQuestions.id, question.id)).returning();
    await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: "question_answered", content: answer });
    return { question: answered, replayed: false, room };
  });
}
export async function escalateQuestion(principal: CampPrincipal, runId: string, questionId: string, input: CampPluginInput & { reason: string }) {
  return getDb().transaction(async tx => {
    const { room, goal, question } = await assignedQuestion(tx, principal, runId, questionId, input);
    const reason = answerText(input.reason);
    if (question.status === "awaiting_human") {
      if (question.escalationReason !== reason) throw new CampError(409, "escalation_conflict", "This question already has a different escalation reason");
      return { question, replayed: true, room };
    }
    if (question.status !== "awaiting_role") throw new CampError(409, "question_not_answerable", "An answered or cancelled question cannot be escalated");
    const [escalated] = await tx.update(campQuestions).set({ status: "awaiting_human", needsHuman: true, escalationReason: reason }).where(eq(campQuestions.id, question.id)).returning();
    await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId, type: "question_escalated", content: reason });
    return { question: escalated, replayed: false, room };
  });
}
async function resumeQuestion(tx: DatabaseExecutor, room: Room, goal: Goal, question: Question) {
  if (question.status !== "answered" || !question.answer || question.resumedAt || !question.candidate) return;
  const [origin] = await tx.select().from(campTasks).where(and(eq(campTasks.taskId, question.taskId), eq(campTasks.goalAttempt, goal.attempt)));
  if (!origin || origin.status !== "waiting_question") return;
  await tx.update(campTasks).set({ status: "queued", inputCandidate: question.candidate }).where(eq(campTasks.taskId, origin.taskId));
  await tx.update(campQuestions).set({ resumedAt: sql`clock_timestamp()` }).where(eq(campQuestions.id, question.id));
  await tx.update(campGoals).set({ status: "running", reason: null }).where(eq(campGoals.id, goal.id));
  await tx.insert(campEvents).values({ roomId: room.id, goalId: goal.id, runId: question.originRunId, type: "question_resumed", content: "The answered task is queued for a new fenced run" });
}
export async function requireClarificationResult(tx: DatabaseExecutor, binding: Binding) {
  const [question] = await tx.select().from(campQuestions).where(eq(campQuestions.id, binding.questionId!));
  if (!question || !["answered", "awaiting_human"].includes(question.status)) throw new CampError(409, "clarification_result_required", "Answer or escalate the assigned question before ending clarification");
}
export async function completeClarification(tx: DatabaseExecutor, room: Room, goal: Goal, binding: Binding) {
  const [question] = await tx.select().from(campQuestions).where(eq(campQuestions.id, binding.questionId!));
  if (question.status === "answered") await resumeQuestion(tx, room, goal, question);
  else await tx.update(campGoals).set({ status: "waiting_question" }).where(eq(campGoals.id, goal.id));
}
export async function answerQuestionByHuman(roomId: string, questionId: string, userId: string, rawAnswer: string) {
  const [scope] = await getDb().select({ serverId: campRooms.serverId }).from(campRooms).where(eq(campRooms.id, roomId));
  if (!scope) throw new CampError(404, "room_not_found", "Room not found");
  return getDb().transaction(async tx => {
    await lockActorMembershipRow(tx, scope.serverId, userId);
    const room = await lockRoom(tx, roomId);
    if (!await canUserPostToChannel(room.channelId, userId)) throw new CampError(403, "camp_post_required", "Channel post access is required to answer a question");
    const [question] = await tx.select().from(campQuestions).where(and(eq(campQuestions.id, questionId), eq(campQuestions.roomId, roomId)));
    if (!question) throw new CampError(404, "question_not_found", "Question not found");
    const [goal] = await tx.select().from(campGoals).where(eq(campGoals.id, question.goalId));
    if (!goal || goal.attempt !== question.goalAttempt || !["queued", "running", "waiting_question"].includes(goal.status)) throw new CampError(409, "question_attempt_stopped", "This question belongs to a stopped or replaced attempt");
    await assertGoalDeadline(tx, goal.id);
    const answer = answerText(rawAnswer);
    if (question.status === "answered") {
      if (question.answer !== answer || !question.answerByUserId) throw new CampError(409, "answer_conflict", "This question already has a different immutable answer");
      return { question, room, replayed: true };
    }
    if (!question.needsHuman || question.status !== "awaiting_human") throw new CampError(409, "question_not_answerable", "This question is not waiting for a human answer");
    if (question.clarificationTaskId) {
      const [clarification] = await tx.select().from(campTasks).where(eq(campTasks.taskId, question.clarificationTaskId));
      if (clarification && clarification.status !== "completed") throw new CampError(409, "clarification_pending", "The clarification worker must finish before the human answer can resume execution");
    }
    const [answered] = await tx.update(campQuestions).set({ status: "answered", answer, answerByRole: "human", answerByUserId: userId, answeredAt: sql`clock_timestamp()` }).where(eq(campQuestions.id, question.id)).returning();
    await resumeQuestion(tx, room, goal, answered);
    await tx.insert(campEvents).values({ roomId, goalId: goal.id, type: "question_answered_by_human", content: answer });
    return { question: answered, room, replayed: false };
  });
}
