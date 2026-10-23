import { parsePlan } from "../../../../camp-protocol/src/index.js";
import { dagNodes, dagProjection } from "./dag";
import { roomOccupancy } from "./executionPool";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/index";
import { campGoals, campPlans, campQuestions, campRuns, campTasks, tasks } from "../../db/schema";
import { deliveryResultReady, needsVerification, requireVerificationGate } from "./verification";
import { needsIntegration, requireIntegrationGate } from "./integration";
import { CampError } from "./types";

type Goal = typeof campGoals.$inferSelect;
export async function goalDeliverySnapshot(goal: Goal, canPost: boolean) {
  const db = getDb();
  const [plan] = await db.select().from(campPlans).where(and(eq(campPlans.goalId, goal.id), eq(campPlans.goalAttempt, goal.attempt)));
  const rows = await db.select({ binding: campTasks, taskNumber: tasks.taskNumber }).from(campTasks).innerJoin(tasks, eq(tasks.id, campTasks.taskId))
    .where(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt))).orderBy(asc(tasks.taskNumber));
  const bindings = rows.map(row => row.binding);
  const runs = bindings.length ? await db.select().from(campRuns).where(inArray(campRuns.taskId, bindings.map(binding => binding.taskId))).orderBy(asc(campRuns.createdAt)) : [];
  const questionRows = await db.select().from(campQuestions).where(and(eq(campQuestions.goalId, goal.id), eq(campQuestions.goalAttempt, goal.attempt))).orderBy(asc(campQuestions.createdAt));
  const questions = questionRows.map(question => {
    const clarification = question.clarificationTaskId ? bindings.find(binding => binding.taskId === question.clarificationTaskId) : null;
    return { ...question, canAnswer: canPost && ["queued", "running", "waiting_question"].includes(goal.status) && question.status === "awaiting_human" && (!clarification || clarification.status === "completed") };
  });
  const occupied = await roomOccupancy(db, goal.roomId);
  const nodeRows = goal.planMode === "bounded_dag" ? await dagNodes(db, goal) : [];
  const items = (plan?.items ?? []).map((item, index) => {
    const stages = bindings.filter(binding => binding.planItemKey === item.key);
    const node = nodeRows.find(value => value.key === item.key);
    const latest = node?.activeTaskId ? stages.find(stage => stage.taskId === node.activeTaskId) : stages[stages.length - 1];
    const reviews = stages.filter(binding => binding.kind === "review").flatMap(binding => runs.filter(run => run.taskId === binding.taskId && run.status === "completed").map(run => {
      const artifact = run.artifacts.find(value => value.type === "review");
      return { runId: run.id, outcome: run.outcome, evidence: artifact?.evidence ?? "", summary: artifact?.summary ?? run.summary ?? "", candidate: run.inputCandidate ?? null, createdAt: run.completedAt ?? run.createdAt };
    }));
    const latestReview = reviews[reviews.length - 1];
    const latestRun = latest ? [...runs].reverse().find(run => run.taskId === latest.taskId) : null;
    const status = !latest ? "pending" : ["failed", "blocked", "cancelled"].includes(latest.status) ? "needs_attention"
      : latest.kind === "review" && latest.status === "completed" && latestReview?.outcome === "approved" ? "approved"
        : latest.kind === "review" ? "reviewing" : "building";
    const dependencyKeys = "dependsOnKeys" in item ? item.dependsOnKeys : [];
    const blockedByKeys = dependencyKeys.filter(key => nodeRows.find(value => value.key === key)?.status !== "approved");
    const schedulingState = node?.status === "blocked" ? "blocked" : node?.status === "waiting_dependencies" ? "waiting_dependencies" : node?.status === "waiting_integration" ? "waiting_integration" : status === "approved" ? "approved" : !latest ? "pending" : latest.status === "waiting_question" ? "waiting_question" : ["blocked", "failed", "cancelled"].includes(latest.status) ? "blocked" : latest.status === "running" ? "running" : latest.status === "queued" && occupied.length >= (["parallel_pair", "bounded_dag"].includes(goal.planMode) ? 2 : 1) ? "waiting_capacity" : latest.kind === "review" && latest.status === "queued" ? "waiting_review" : latest.status === "queued" ? "ready" : "pending";
    const scheduling = { state: schedulingState, blockedByKeys, reason: schedulingState === "waiting_dependencies" ? "dependencies_pending" : schedulingState === "waiting_integration" ? "node_integration_pending" : schedulingState === "waiting_capacity" ? occupied.some(run => run.status !== "running") ? "cleanup_pending" : "room_capacity" : schedulingState === "waiting_review" ? "reviewer_queue" : schedulingState === "waiting_question" ? "question_pending" : schedulingState === "blocked" ? goal.reason : null };
    return { ...item, dependsOnKeys: dependencyKeys, inputSources: node?.inputSources ?? [], inputResolution: node?.inputResolution ?? null, inputCandidate: node?.inputCandidate ?? null, scopedIntegrationOperationId: node?.inputOperationId ?? null, index, status, scheduling, role: "builder", reworkCount: Math.max(0, stages.filter(binding => binding.kind === "build").length - 1), candidate: latestRun?.inputCandidate && latest?.kind === "review" ? latestRun.inputCandidate : latestRun?.candidate ?? latest?.inputCandidate ?? null, reviews };
  });
  const elapsedSeconds = goal.startedAt ? Math.max(0, Math.floor(((goal.completedAt?.getTime() ?? Date.now()) - goal.startedAt.getTime()) / 1000)) : 0;
  const humanAnswers = questions.filter(question => question.answer !== null && (question.answerByUserId !== null || question.answerByRole === "human")).length;
  const agentAnswers = questions.filter(question => question.answer !== null && question.answerByUserId === null && question.answerByRole !== "human").length;
  return { graph: await dagProjection(goal), plan: plan ? parsePlan({ revision: plan.revision, summary: plan.summary, tasks: plan.items }) : null, items, questions, metrics: {
    runs: goal.runCount, reviewRounds: goal.reviewRounds, elapsedSeconds, itemsTotal: items.length, itemsApproved: items.filter(item => item.status === "approved").length,
    questionsAsked: questions.length, questionsAnswered: questions.filter(question => question.answer !== null).length,
    humanAnswers, agentAnswers, roleAnswers: agentAnswers, manualRetries: goal.attempt - 1,
    reworks: items.reduce((sum, item) => sum + item.reworkCount, 0) + bindings.filter(binding => binding.kind === "build" && binding.planItemKey === null).length,
  } };
}
export async function goalResultManifest(roomId: string, goalId: string) {
  const [goal] = await getDb().select().from(campGoals).where(and(eq(campGoals.id, goalId), eq(campGoals.roomId, roomId)));
  if (!goal) throw new CampError(404, "goal_not_found", "Goal not found");
  const view = await goalDeliverySnapshot(goal, false);
  const resultReady = goal.workflow === "serial" && await deliveryResultReady(goal);
  // Export the immutable operator policy and observed receipt together, so a
  // downloaded manifest retains its evidence after the Room policy changes.
  const verification = needsVerification(goal) ? { policy: goal.verificationPolicy, receipt: resultReady && goal.finalCandidate ? await requireVerificationGate(getDb(), goal, goal.finalCandidate) : null } : null;
  return { schemaVersion: 1, roomId, goalId, goalAttempt: goal.attempt, workflow: goal.workflow, planMode: goal.planMode, integration: needsIntegration(goal) && resultReady ? await requireIntegrationGate(getDb(), goal) : null, status: goal.status, resultReady,
    candidate: resultReady ? goal.finalCandidate : null, summary: goal.summary?.summary ?? null, evidence: goal.summary?.evidence ?? null, remaining: goal.summary?.remaining ?? [], verification, metrics: view.metrics };
}
