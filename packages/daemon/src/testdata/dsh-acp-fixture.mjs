// A real child-process ACP peer for transport tests; never imports DSH or calls a model.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.DSH_TEST_MODE;
const configOptions = [
  { id: "model", type: "select", currentValue: '["deepseek-official","flash"]', options: [
    { group: "deepseek-official", options: [
      { value: '["deepseek-official","flash"]', name: "Flash" },
      { value: '["deepseek-official","pro"]', name: "Pro" },
    ] },
  ] },
  { id: "reasoning_effort", type: "select", currentValue: "medium", options: [{ value: "medium" }, { value: "high" }] },
];
const write = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const reply = (id, result) => write({ id, result });
let prompt;
let sessionId;
if (mode === "ignore-stop" || mode === "timeout") process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.DSH_TEST_LOG) appendFileSync(process.env.DSH_TEST_LOG, `${line}\n`);
  if (request.method === "initialize") {
    if (mode === "timeout") return;
    if (mode === "malformed") return process.stdout.write("not JSON\n");
    return reply(request.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
  }
  if (request.method === "session/resume" && mode === "missing-session") {
    return write({ id: request.id, error: { code: -32602, message: "Session does not exist" } });
  }
  if (request.method === "session/new" || request.method === "session/resume") {
    sessionId = request.params.sessionId ?? "dsh-session-1";
    return reply(request.id, { sessionId, configOptions });
  }
  if (request.method === "session/set_config_option") return reply(request.id, { configOptions });
  if (request.method === "session/prompt") {
    prompt = request;
    const update = (value, target = sessionId) => write({ method: "session/update", params: { sessionId: target, update: value } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOREIGN" } }, "another-session");
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking the room" } });
    update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "camp_read_room", rawInput: {} });
    update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `worker=${Boolean(process.env.CAMP_WORKER_TOKEN)};run=${Boolean(process.env.CAMP_RUN_TOKEN)}` } });
    if (mode === "permission") write({ id: "permission-1", method: "session/request_permission", params: { sessionId, options: [{ optionId: "once", kind: "allow_once" }] } });
    if (mode !== "running" && mode !== "ignore-stop") setTimeout(() => {
      if (prompt === request) { prompt = undefined; reply(request.id, { stopReason: "end_turn" }); }
    }, 60);
    return;
  }
  if (request.method === "session/cancel") {
    if (mode === "ignore-stop") return;
    if (prompt) { reply(prompt.id, { stopReason: "cancelled" }); prompt = undefined; }
    return;
  }
  if (request.method === "session/close") {
    if (mode !== "ignore-stop") reply(request.id, {});
    return;
  }
});
