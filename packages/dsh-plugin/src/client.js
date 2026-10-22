/** Camp run-scoped HTTP client. The supervisor's worker credential never enters this package. */

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
      if (response.status === 401 || response.status === 403 || response.status === 409) throw new Error("Camp run is no longer authorized; stop work and let the supervisor handle the lease");
      throw new Error(`Camp request failed (HTTP ${response.status})`);
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
  };
}
