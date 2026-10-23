/** Camp run-scoped HTTP client. The supervisor's worker credential never enters this package. */
import { CAMP_SUPPORTED_PROTOCOL_VERSIONS, parsePlanSubmission } from '../../camp-protocol/src/index.js';

/** @typedef {{apiUrl: string, token: string, workerId: string, runId: string, roomId: string, epoch: number}} RunContext */
/** @param {NodeJS.ProcessEnv} [env] @returns {RunContext} */
export function runContext(env = process.env) {
  const read = (/** @type {string} */ name) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}; Camp room tools require an active leased run`);
    return value;
  };
  const apiUrl = new URL(read("CAMP_API_URL"));
  if (!['https:', 'http:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) throw new Error("CAMP_API_URL must be an HTTP(S) origin without credentials");
  const epoch = Number(read("CAMP_RUN_EPOCH"));
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("CAMP_RUN_EPOCH must be a positive integer");
  if (!CAMP_SUPPORTED_PROTOCOL_VERSIONS.includes(Number(read('CAMP_PROTOCOL_VERSION')))) throw new Error('Unsupported Camp run protocol; stop and let the supervisor recover the run');
  return { apiUrl: apiUrl.toString().replace(/\/$/, ""), token: read("CAMP_RUN_TOKEN"), workerId: read("CAMP_WORKER_ID"), runId: read("CAMP_RUN_ID"), roomId: read("CAMP_ROOM_ID"), epoch };
}

/** @param {RunContext} context @param {typeof fetch} [transport] */
export function createRunClient(context, transport = fetch) {
  /** @param {string} path @param {Record<string, unknown> | undefined} [body] @param {AbortSignal} [signal] */
  async function request(path, body, signal) {
    const response = await transport(`${context.apiUrl}/api/camp/worker${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${context.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify({ workerId: context.workerId, runId: context.runId, epoch: context.epoch, ...body }) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    // One attempt: a lost mutation response is not permission to replay it.
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      const code = details && typeof details.code === "string" && /^[a-z_]{1,80}$/.test(details.code) ? details.code : undefined;
      const conflict = code && ["plan_conflict", "finalize_conflict", "question_conflict", "pending_question", "answer_conflict", "escalation_conflict"].includes(code);
      const message = conflict ? `Camp rejected a changed immutable record (${code}); read the current context and preserve the accepted record`
        : response.status === 401 || response.status === 403 || response.status === 409 ? "Camp run is no longer authorized; stop work and let the supervisor handle the lease"
        : `Camp request failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
      throw Object.assign(new Error(message), { status: response.status, ...(code ? { code } : {}) });
    }
    return response.json();
  }
  return {
    /** @param {AbortSignal} [signal] */
    context: (signal) => request(`/runs/${encodeURIComponent(context.runId)}/context`, undefined, signal),
    /** @param {string | undefined} after @param {AbortSignal} [signal] */
    readRoom: (after, signal) => request(`/rooms/${encodeURIComponent(context.roomId)}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`, undefined, signal),
    /** @param {string} content @param {string | undefined} toRole @param {'progress'|'question'|'handoff'} kind @param {AbortSignal} [signal] */
    send: (content, toRole, kind, signal) => request(`/rooms/${encodeURIComponent(context.roomId)}/messages`, { content, kind, ...(toRole ? { toRole } : {}) }, signal),
    /** @param {'progress'|'artifact'} type @param {string} content @param {Record<string, unknown> | undefined} artifact @param {AbortSignal} [signal] */
    event: (type, content, artifact, signal) => request(`/runs/${encodeURIComponent(context.runId)}/events`, { type, content, ...(artifact ? { artifact } : {}) }, signal),
    /** @param {{planRevision?:1|2,summary:string,tasks:import('../../camp-protocol/src/index.js').CampPlanItem[]}} plan @param {AbortSignal} [signal] */
    submitPlan: (plan, signal) => request(`/runs/${encodeURIComponent(context.runId)}/plan`, parsePlanSubmission({ planRevision: 1, ...plan }), signal),
    /** @param {{questionId: string, content: string, toRole: string, needsHuman?: boolean}} question @param {AbortSignal} [signal] */
    askQuestion: (question, signal) => request(`/runs/${encodeURIComponent(context.runId)}/questions`, question, signal),
    /** @param {string} questionId @param {string} answer @param {AbortSignal} [signal] */
    answerQuestion: (questionId, answer, signal) => request(`/runs/${encodeURIComponent(context.runId)}/questions/${encodeURIComponent(questionId)}/answer`, { answer }, signal),
    /** @param {string} questionId @param {string} reason @param {AbortSignal} [signal] */
    escalateQuestion: (questionId, reason, signal) => request(`/runs/${encodeURIComponent(context.runId)}/questions/${encodeURIComponent(questionId)}/escalate`, { reason }, signal),
    /** @param {{summary: string, evidence?: string, remaining?: string[]}} result @param {AbortSignal} [signal] */
    finalize: (result, signal) => request(`/runs/${encodeURIComponent(context.runId)}/finalize`, result, signal),
  };
}
