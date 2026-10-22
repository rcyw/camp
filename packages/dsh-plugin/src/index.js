/** Cordis plugin exposing a leased Camp role's room and progress tools to DSH. */
import { createRunClient, runContext } from "./client.js";

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

/** @param {PluginContext} ctx */
export function apply(ctx) {
  // Resolve on tool invocation: the same installed bundle can be boot-checked without a live run.
  const client = () => createRunClient(runContext());
  ctx.systemPrompt.section({
    name: "camp:room-role", order: 990, interpolate: false,
    text: "You are one leased Camp platform role in a shared room. Read room context before acting. "
      + "Use camp_progress for brief evidence-backed milestones, camp_send_message for explicit questions, and camp_handoff for a structured handoff suggestion. "
      + "Do not reply to every progress update or acknowledge messages without new information. "
      + "The supervisor alone claims tasks, renews leases, accepts final results, and creates platform roles. "
      + "Never spawn, fork, or create private subagents or workflows. A handoff is a suggestion; it never transfers the task lease. "
      + "Report artifact paths and test evidence; do not claim validation that you did not run. On authorization loss, stop working. "
      + "The room roles are planner, builder, and reviewer. A reviewer must verify the immutable candidate named by camp_read_context.reviewTarget, then use camp_review with an explicit approved or changes_requested verdict and test evidence before finishing. "
      + "As reviewer, preserve the workspace's files unchanged; put temporary test or diagnostic files under /tmp and report review notes with camp_review. A modified workspace cannot approve the original candidate. "
      + "Finish with a clear final result for the supervisor; do not claim or complete tasks using another API.",
  });
  // Defense in depth if an operator patch accidentally re-enables a private delegation tool.
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (/^(?:subagent(?:_|$)|spawn_agent$|fork_agent$|create_agent$|workflow$)/.test(exec.name)) {
      return { kind: "deny", reason: "Camp owns platform agents. Send a room handoff suggestion instead of spawning a private agent." };
    }
    return next();
  });

  /** @param {string} toolName @param {string} description @param {Record<string, unknown>} properties @param {string[]} required @param {(args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>} execute */
  function tool(toolName, description, properties, required, execute) {
    ctx.tools.register({
      name: toolName, description, parameters: { type: "object", properties, required, additionalProperties: false },
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      execute: (args, exec) => execute(object(args), exec.signal),
    });
  }
  const string = { type: "string" };
  const role = { type: "string", enum: ["planner", "builder", "reviewer"] };
  tool("camp_read_context", "Read your current task, role, dependency artifacts, and run context.", {}, [], (_args, signal) => client().context(signal));
  tool("camp_read_room", "Read recent room messages. Use after only with a message id returned by the room.", { after: string }, [], (args, signal) => client().readRoom(text(args, "after", true), signal));
  tool("camp_send_message", "Ask a specific role a concrete question. Ordinary progress belongs in camp_progress.", { content: string, to_role: role }, ["content", "to_role"], (args, signal) => client().send(text(args, "content") ?? "", text(args, "to_role"), "question", signal));
  tool("camp_progress", "Report a meaningful milestone or blocker without waking every role.", { content: string }, ["content"], (args, signal) => client().event("progress", text(args, "content") ?? "", undefined, signal));
  tool("camp_artifact", "Attach an output path or immutable branch/commit reference and its verification evidence.", { path: string, summary: string, branch: string, commit: string, evidence: string }, ["path", "summary"], (args, signal) => {
    const artifact = { type: "file", path: text(args, "path"), summary: text(args, "summary"),
      ...(args.branch === undefined ? {} : { branch: text(args, "branch") }),
      ...(args.commit === undefined ? {} : { commitId: text(args, "commit") }),
      ...(args.evidence === undefined ? {} : { evidence: text(args, "evidence") }),
    };
    return client().event("artifact", String(artifact.summary), artifact, signal);
  });
  tool("camp_handoff", "Suggest the next responsible role with a summary and remaining work. This never changes ownership or completes a task.", { to_role: role, summary: string, remaining: string }, ["to_role", "summary", "remaining"], (args, signal) => {
    return client().send(`${text(args, "summary")}\n\nRemaining: ${text(args, "remaining")}`, text(args, "to_role"), "handoff", signal);
  });
  tool("camp_review", "Reviewer only: record an explicit verdict with concrete verification evidence for the authorized immutable review candidate. The tool binds that identity from server context; prose alone never approves work.", {
    outcome: { type: "string", enum: ["approved", "changes_requested"] }, summary: string, evidence: string,
  }, ["outcome", "summary", "evidence"], async (args, signal) => {
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
    const candidate = { projectId: text(target, "projectId"), commitId: text(target, "commitId") };
    const artifact = { type: "review", outcome, summary, evidence, candidate };
    return runClient.event("artifact", String(summary), artifact, signal);
  });
}
