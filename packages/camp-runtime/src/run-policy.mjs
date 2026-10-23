import { checkedCandidate } from './candidate.mjs';
import { CAMP_AGENT_TASK_KINDS, parsePlan } from '../../camp-protocol/src/index.js';

export const taskKinds = new Set(CAMP_AGENT_TASK_KINDS);
export function checkedRunPolicy(claim, project) {
  if (!['serial', 'legacy'].includes(claim.workflow) || !taskKinds.has(claim.taskKind)) throw new Error('Server must provide an explicit workflow and task kind');
  if (typeof claim.baseRef !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(claim.baseRef)) throw new Error('Server must provide one explicit input baseRef');
  if (claim.inputCandidates || Array.isArray(claim.inputCandidate) || claim.inputCandidate === undefined) throw new Error('Multiple or ambiguous candidate parents are not supported');
  if (claim.inputCandidate !== null) {
    const input = checkedCandidate(claim.inputCandidate, { projectId: project.projectId, imageId: project.imageId, requireImage: claim.workflow === 'serial', requireTagged: claim.workflow === 'serial' });
    if (claim.baseRef !== input.refId) throw new Error('Explicit baseRef differs from the server input candidate');
  } else if (claim.workflow === 'serial' && claim.taskKind !== 'plan') throw new Error('Only the initial plan may resolve a baseline without an input candidate');
  return claim.inputCandidate;
}
export function checkedPlan(plan) {
  try { return parsePlan(plan); }
  catch (error) { throw Object.assign(new Error(`A structured ordered plan is required: ${error.message}`), { code: error.code, status: error.status }); }
}
/** Only the server's current-run pending question can authorize suspension. */
export function currentBlockingQuestion(claim, context) {
  const question = context.blockingQuestion;
  if (!question) return null;
  if (claim.taskKind === 'clarification') throw new Error('Clarification must answer or escalate its assigned question before finishing');
  if (typeof question.id !== 'string' || !question.id || question.status !== 'pending' || question.activeRunId !== claim.id || question.resumedAt != null) throw new Error('Blocking question does not belong to this active run');
  return question;
}
export function controlledTurnResult(claim, context) {
  const question = currentBlockingQuestion(claim, context);
  if (question) return { kind: 'question', question };
  const assigned = context.assignedQuestion ?? context.question;
  if (claim.taskKind === 'clarification' && ['answered', 'awaiting_human'].includes(assigned?.status)) return { kind: 'clarification', question: assigned };
  return null;
}
export function completionSummary(claim, context, text) {
  const blocking = currentBlockingQuestion(claim, context);
  if (blocking) return `Waiting for ${blocking.needsHuman ? 'human' : blocking.toRole ?? 'coordinator'}: ${blocking.content ?? blocking.id}`.slice(0, 15000);
  const assigned = context.assignedQuestion ?? context.question;
  if (claim.taskKind === 'clarification') {
    if (assigned?.status === 'answered') return `Answer from ${claim.role}: ${assigned.answer ?? ''}`.slice(0, 15000);
    if (assigned?.status === 'awaiting_human') return `Waiting for human: ${assigned.escalationReason ?? assigned.content ?? assigned.id}`.slice(0, 15000);
  }
  return text.trim().slice(0, 15000) || 'DSH completed the task and saved a LayerFS candidate.';
}
export function completionPolicy(claim, context, inputCandidate, candidate) {
  const input = checkedCandidate(inputCandidate, { requireImage: claim.workflow === 'serial', requireTagged: claim.workflow === 'serial' });
  checkedCandidate(candidate, { projectId: inputCandidate.projectId, imageId: inputCandidate.imageId, requireImage: claim.workflow === 'serial', requireTagged: claim.workflow === 'serial' });
  if (candidate.baseRef !== input.refId) throw new Error('Output candidate does not name its immutable input reference');
  if (claim.taskKind !== 'build' && candidate.rootId !== inputCandidate.rootId) throw new Error(`readonly_workspace_changed: ${claim.taskKind} changed the workspace`);
  const question = currentBlockingQuestion(claim, context);
  if (question) {
    return { status: 'suspended', questionId: question.id };
  }
  if (claim.workflow === 'serial' && claim.taskKind !== 'clarification') checkedPlan(context.plan);
  if (claim.taskKind === 'clarification' && !['answered', 'awaiting_human'].includes((context.assignedQuestion ?? context.question)?.status)) throw new Error('Clarification must durably answer or escalate its assigned question');
  if (claim.workflow === 'serial' && claim.taskKind === 'summary' && (typeof context.finalization?.summary !== 'string' || !context.finalization.summary.trim())) throw new Error('Planner summary must record camp_finalize before completing');
  if (['review', 'final_review'].includes(claim.taskKind)) {
    const review = context.review ?? context.run?.review;
    const evidence = review?.evidence;
    const validEvidence = typeof evidence === 'string' ? evidence.trim() : Array.isArray(evidence) && evidence.length && evidence.every(item => typeof item === 'string' && item.trim());
    if (!review || !['approved', 'changes_requested'].includes(review.outcome) || !validEvidence) throw new Error('Reviewer did not record a structured verdict with evidence through camp_review');
    return { status: 'completed', outcome: review.outcome };
  }
  return { status: 'completed' };
}
