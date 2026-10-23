/** Cordis plugin exposing a leased Camp role's room and progress tools to DSH. */
import { randomUUID } from "node:crypto";
import { createRunClient, runContext } from "./client.js";
import { CAMP_TOOL_SCHEMAS, CAMP_DAG_PLAN_TOOL_SCHEMA, parsePlanSubmission } from '../../camp-protocol/src/index.js';
export { pluginProtocol } from './protocol.js';

export const name = "camp-room-tools";
export const inject = ["tools", "systemPrompt"];

/** @typedef {{signal?: AbortSignal}} ToolExecution */
/** @typedef {{name: string, description: string, parameters: Record<string, unknown>, output: {schema: Record<string, unknown>, render(args: unknown, value: unknown): {type: 'text', text: string}[]}, execute(args: unknown, exec: ToolExecution): Promise<unknown>}} Tool */
/** @typedef {{tools: {register(tool: Tool): () => void}, systemPrompt: {section(section: {name: string, order: number, text: string, interpolate?: boolean}): unknown}, on(event: string, callback: (exec: {name: string}, next: () => Promise<unknown>) => Promise<unknown>): unknown}} PluginContext */

/** @param {unknown} args @returns {Record<string, unknown>} */
function object(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  return /** @type {Record<string, unknown>} */ (args);
}
/** @param {Record<string, unknown>} args @param {string} key @param {boolean} [optional] */
function text(args, key, optional = false) {
  const value = args[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be non-empty text`);
  return value;
}

/** @param {Record<string, unknown>} target @returns {Record<string, string>} */
function reviewCandidate(target) {
  const projectId = text(target, "projectId") ?? "";
  if (target.refId !== undefined || target.refKind !== undefined) {
    const refId = text(target, "refId") ?? "";
    if (target.refKind !== "layer" && target.refKind !== "commit") throw new Error("The authorized review snapshot must identify a layer or commit");
    if ((target.commitId !== undefined && (target.refKind !== "commit" || target.commitId !== refId)) || (target.layerId !== undefined && (target.refKind !== "layer" || target.layerId !== refId))) throw new Error("The authorized review snapshot has inconsistent reference aliases");
    return { projectId, refId, refKind: target.refKind, ...(target.refKind === "commit" ? { commitId: refId } : { layerId: refId }) };
  }
  return { projectId, commitId: text(target, "commitId") ?? "" };
}

/** @param {PluginContext} ctx */
export function apply(ctx) {
  const dag = Number(process.env.CAMP_PROTOCOL_VERSION) === 5;
  // Resolve on tool invocation: the same installed bundle can be boot-checked without a live run.
  const client = () => createRunClient(runContext());
  ctx.systemPrompt.section({
    name: "camp:room-role", order: 990, interpolate: false,
    text: "You are one leased Camp platform role in a shared room. Read room context before acting. "
      + "Use camp_progress for brief evidence-backed milestones, camp_ask_question for blocking questions, camp_send_message for room notes, and camp_handoff for a structured handoff suggestion. "
      + "Do not reply to every progress update or acknowledge messages without new information. "
      + "The supervisor alone claims tasks, renews leases, accepts final results, and creates platform roles. "
      + "Never spawn, fork, or create private subagents or workflows. A handoff is a suggestion; it never transfers the task lease. "
      + "Report artifact paths and test evidence; do not claim validation that you did not run. On authorization loss, stop working. "
      + "The room roles are planner, builder, and reviewer. During a review or final_review task (or a legacy reviewer run), verify the immutable candidate named by camp_read_context.reviewTarget, then use camp_review with an explicit approved or changes_requested verdict and test evidence before finishing. A clarification task only answers or escalates its assigned question. "
      + "Preserve the workspace's files unchanged during review; put temporary test or diagnostic files under /tmp and report review notes with camp_review. A modified workspace cannot approve the original candidate. "
      + "For serial goals, read context.taskKind and context.planMode before acting. During plan, inspect the original requirement and submit one plan with camp_submit_plan; do not implement or change project files. Ordered modes use the item order. In bounded_dag, every node must include dependsOnKeys (an empty array means a root), with at most six nodes, two direct parents per node and two final nodes. Reject cycles and redundant ancestor dependencies; add explicit join nodes when needed. Independent nodes may run concurrently, so give them separate file ownership where possible. Every item needs explicit acceptance criteria and verification steps. The platform integrates multiple parents before execution. A final text plan is not an accepted plan. If context already contains an accepted plan for this attempt, preserve that exact plan and finish without replacing it. "
      + "During build, implement only the current plan item, check its acceptance criteria and report the actual verification. During review, check the current item; during final_review, check the entire original requirement against the authorized combined candidate. "
      + "Use camp_ask_question for a blocking question that needs another role or a human. When its response requiresSuspension is true, stop editing and finish your turn promptly so the supervisor can save your candidate and schedule the recipient. If requiresSuspension is false, use the existing answer and continue instead. Never wait or poll for another role while holding the only worker. "
      + "On a resumed task, read answered questions in context and continue from the mounted saved candidate. Do not ask an already answered question again. Ordinary room notes and progress never request scheduling. "
      + "During clarification, answer the assigned pending question from the requirement and available evidence with camp_answer_question. If a product decision needs the human, call camp_escalate_question and finish; never invent the human's decision. If the assigned question is already answered or escalated, preserve that decision and finish without rewriting it. Preserve project files. "
      + "During summary, verify the final candidate and accepted plan results in context, then call camp_finalize with one concise delivery summary, actual test evidence and remaining limitations. A final prose answer alone cannot finalize the goal. Preserve project files. Do not invent commits, mark unfinished work done, or publish to the source repository. "
      + "Finish with a clear final result for the supervisor; do not claim or complete tasks using another API.",
  });
  // Defense in depth if an operator patch accidentally re-enables a private delegation tool.
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (/^(?:subagent(?:_|$)|spawn_agent$|fork_agent$|create_agent$|workflow$)/.test(exec.name)) {
      return { kind: "deny", reason: "Camp owns platform agents. Send a room handoff suggestion instead of spawning a private agent." };
    }
    return next();
  });

  /** @param {keyof typeof CAMP_TOOL_SCHEMAS} toolName @param {string} description @param {(args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>} execute */
  function tool(toolName, description, execute) {
    ctx.tools.register({
      name: toolName, description, parameters: structuredClone(toolName === 'camp_submit_plan' && dag ? CAMP_DAG_PLAN_TOOL_SCHEMA : CAMP_TOOL_SCHEMAS[toolName]),
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute: async (args, exec) => execute(object(args), exec.signal),
    });
  }
  tool("camp_read_context", "Read your current task, role, dependency artifacts, and run context.", (_args, signal) => client().context(signal));
  tool("camp_read_room", "Read recent room messages. Use after only with a message id returned by the room.", (args, signal) => client().readRoom(text(args, "after", true), signal));
  tool("camp_send_message", "Post a room note to a role. This does not schedule a reply. For a blocking question use camp_ask_question; ordinary progress belongs in camp_progress.", (args, signal) => client().send(text(args, "content") ?? "", text(args, "to_role"), "handoff", signal));
  tool("camp_progress", "Report a meaningful milestone or blocker without waking every role.", (args, signal) => client().event("progress", text(args, "content") ?? "", undefined, signal));
  tool("camp_artifact", "Attach an output path or immutable branch/commit reference and its verification evidence.", (args, signal) => {
    const artifact = { type: "file", path: text(args, "path"), summary: text(args, "summary"),
      ...(args.branch === undefined ? {} : { branch: text(args, "branch") }),
      ...(args.commit === undefined ? {} : { commitId: text(args, "commit") }),
      ...(args.evidence === undefined ? {} : { evidence: text(args, "evidence") }),
    };
    return client().event("artifact", String(artifact.summary), artifact, signal);
  });
  tool("camp_handoff", "Suggest the next responsible role with a summary and remaining work. This never changes ownership or completes a task.", (args, signal) => {
    return client().send(`${text(args, "summary")}\n\nRemaining: ${text(args, "remaining")}`, text(args, "to_role"), "handoff", signal);
  });
  tool("camp_submit_plan", "Planner plan task only: submit the implementation plan required by context.planMode. In bounded_dag include dependsOnKeys for every node; other modes use ordered items. The server persists it before builders can claim work. Identical replay is idempotent; changing an accepted plan is a conflict.", (args, signal) => {
    const plan = parsePlanSubmission({ planRevision: dag ? 2 : 1, summary: text(args, 'summary') ?? '', tasks: args.tasks });
    return client().submitPlan(plan, signal);
  });
  tool("camp_ask_question", "Suspend work for a blocking question. The supervisor saves your candidate and releases the worker to route the question. After this tool succeeds, stop editing and finish the turn promptly. Use needs_human only for a decision the human must make.", (args, signal) => {
    if (args.needs_human !== undefined && typeof args.needs_human !== "boolean") throw new Error("needs_human must be a boolean");
    return client().askQuestion({ questionId: randomUUID(), content: text(args, "content") ?? "", toRole: text(args, "to_role") ?? "planner", ...(args.needs_human === undefined ? {} : { needsHuman: args.needs_human }) }, signal);
  });
  tool("camp_answer_question", "Clarification task only: answer the assigned pending question using the requirement and project evidence. The server resumes the suspended task after the clarification turn finishes.", (args, signal) => client().answerQuestion(text(args, "question_id") ?? "", text(args, "answer") ?? "", signal));
  tool("camp_escalate_question", "Clarification task only: request a human decision for the assigned question. Give the precise missing decision and finish the turn; do not wait while holding the worker.", (args, signal) => client().escalateQuestion(text(args, "question_id") ?? "", text(args, "reason") ?? "", signal));
  tool("camp_finalize", "Summary task only: record delivery after all item reviews and final acceptance passed. The server binds the authorized final candidate. Report actual verification and remaining limitations; a prose answer alone does not finalize delivery.", (args, signal) => {
    if (args.remaining !== undefined && (!Array.isArray(args.remaining) || args.remaining.some(value => typeof value !== "string" || value.trim().length === 0))) throw new Error("remaining must be an array of nonempty limitations");
    return client().finalize({ summary: text(args, "summary") ?? "", ...(args.evidence === undefined ? {} : { evidence: text(args, "evidence") }), ...(args.remaining === undefined ? {} : { remaining: /** @type {string[]} */ (args.remaining) }) }, signal);
  });
  tool("camp_review", "Reviewer only: record an explicit verdict with concrete verification evidence for the authorized immutable review candidate. The tool binds that identity from server context; prose alone never approves work.", async (args, signal) => {
    const outcome = text(args, "outcome");
    if (outcome !== "approved" && outcome !== "changes_requested") throw new Error("Review outcome must be approved or changes_requested");
    const summary = text(args, "summary");
    const evidence = text(args, "evidence");
    const runClient = client();
    const context = object(await runClient.context(signal));
    if (!context.reviewTarget || typeof context.reviewTarget !== "object" || Array.isArray(context.reviewTarget)) {
      throw new Error("No immutable review candidate is authorized for this run. Stop and ask the supervisor to recover the task.");
    }
    const target = object(context.reviewTarget);
    const candidate = reviewCandidate(target);
    const artifact = { type: "review", outcome, summary, evidence, candidate };
    return runClient.event("artifact", String(summary), artifact, signal);
  });
}
