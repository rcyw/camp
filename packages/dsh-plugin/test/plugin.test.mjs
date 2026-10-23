import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { apply } from "../src/index.js";
import { createRunClient, runContext } from "../src/client.js";
import { createPluginDeclaration, CAMP_TOOL_SCHEMAS } from '../../camp-protocol/src/index.js';

const env = {
  CAMP_API_URL: "http://camp.test:13018", CAMP_RUN_TOKEN: "short-run-token", CAMP_WORKER_TOKEN: "must-not-use",
  CAMP_PROTOCOL_VERSION: '1',
  CAMP_WORKER_ID: "worker-1", CAMP_RUN_ID: "run-1", CAMP_RUN_EPOCH: "2", CAMP_ROOM_ID: "room-1",
};

test("requires an explicit run capability and never falls back to the supervisor token", () => {
  assert.equal(runContext(env).token, "short-run-token");
  assert.throws(() => runContext({ ...env, CAMP_RUN_TOKEN: "" }), /CAMP_RUN_TOKEN/);
  assert.throws(() => runContext({ ...env, CAMP_RUN_EPOCH: "0" }), /positive integer/);
  assert.throws(() => runContext({ ...env, CAMP_API_URL: "file:///tmp/state" }), /HTTP/);
  assert.throws(() => runContext({ ...env, CAMP_PROTOCOL_VERSION: undefined }), /CAMP_PROTOCOL_VERSION/);
  assert.throws(() => runContext({ ...env, CAMP_PROTOCOL_VERSION: '99' }), /Unsupported Camp run protocol/);
});

test("fences requests with run identity, targets the room explicitly, and does not follow redirects or replay rejected writes", async () => {
  const calls = [];
  const client = createRunClient(runContext(env), async (url, options) => {
    calls.push({ url, options });
    return new Response('{"ok":true}', { status: 200 });
  });
  await client.readRoom("previous message");
  await client.send("Need the API contract", "backend", "question");
  await client.event("artifact", "Verified patch", { path: "src/api.ts", commit: "abc" });
  assert.match(calls[0].url, /rooms\/room-1\/messages\?after=previous%20message$/);
  assert.equal(calls[1].options.headers.authorization, "Bearer short-run-token");
  assert.equal(calls[1].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[1].options.body), { workerId: "worker-1", runId: "run-1", epoch: 2, content: "Need the API contract", toRole: "backend", kind: "question" });
  assert.equal(JSON.stringify(calls).includes("must-not-use"), false);
  let attempts = 0;
  const fenced = createRunClient(runContext(env), async () => { attempts++; return new Response("expired", { status: 409 }); });
  await assert.rejects(() => fenced.send("late result", "review", "handoff"), /no longer authorized/);
  assert.equal(attempts, 1);
});

test("registers only scoped collaboration tools and rejects private delegation while delegating other tool gates", async () => {
  const tools = new Map();
  const sections = [];
  const gates = new Map();
  apply({
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { section(value) { sections.push(value); } },
    on(event, cb) { gates.set(event, cb); },
  });
  assert.deepEqual([...tools.keys()], ["camp_read_context", "camp_read_room", "camp_send_message", "camp_progress", "camp_artifact", "camp_handoff", "camp_submit_plan", "camp_ask_question", "camp_answer_question", "camp_escalate_question", "camp_finalize", "camp_review"]);
  assert.equal([...tools.keys()].some((name) => /claim|complete|heartbeat/.test(name)), false);
  assert.match(sections[0].text, /never transfers the task lease/);
  assert.match(sections[0].text, /Never wait or poll for another role/);
  assert.match(sections[0].text, /A final prose answer alone cannot finalize/);
  const guard = gates.get("tools/pre-execute");
  let delegated = false;
  assert.equal((await guard({ name: "subagent_fork" }, async () => { delegated = true; })).kind, "deny");
  assert.equal(delegated, false);
  assert.deepEqual(await guard({ name: "bash" }, async () => ({ kind: "allow" })), { kind: "allow" });
  for (const tool of tools.values()) {
    assert.equal(tool.output.schema.type, "object");
    assert.deepEqual(tool.parameters, CAMP_TOOL_SCHEMAS[tool.name]);
    assert.notEqual(tool.parameters, CAMP_TOOL_SCHEMAS[tool.name]);
  }
});
test('the shipped static plugin descriptor matches its shared source declaration', async () => {
  const descriptor = JSON.parse(await readFile(new URL('../protocol.json', import.meta.url), 'utf8'));
  assert.deepEqual(descriptor, createPluginDeclaration());
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/protocol-descriptor.mjs', import.meta.url)), '--check']);
});

test("a plan conflict preserves its business reason without replaying the write or pretending the lease expired", async () => {
  let attempts = 0;
  const client = createRunClient(runContext(env), async () => { attempts++; return Response.json({ code: "plan_conflict", error: "This attempt already has a different immutable plan" }, { status: 409 }); });
  await assert.rejects(() => client.submitPlan({ summary: "Changed", tasks: [{ key: 'one', title: 'First', description: 'A valid change', acceptance: 'Correct behavior', verification: 'Run tests' }] }), { code: "plan_conflict", status: 409, message: /preserve the accepted record/ });
  assert.equal(attempts, 1);
});

test("ordered plans preserve acceptance and verification while rejecting malformed or duplicate items before sending", async () => {
  const previous = { ...process.env }; const originalFetch = globalThis.fetch;
  const tools = new Map(); const calls = [];
  const item = { key: "parser", title: "Parse input", description: "Implement a bounded parser", acceptance: "Empty input returns a validation error", verification: "Run node --test test/parser.test.mjs" };
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ plan: { revision: 1 } }); };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    const submit = tools.get("camp_submit_plan");
    await assert.rejects(() => submit.execute({ summary: "Plan", tasks: [] }, {}), /one to five/);
    await assert.rejects(() => submit.execute({ summary: "Plan", tasks: [item, item] }, {}), /unique/);
    await assert.rejects(() => submit.execute({ summary: "Plan", tasks: [{ ...item, acceptance: " " }] }, {}), /acceptance/);
    await assert.rejects(() => submit.execute({ summary: "Plan", tasks: [{ ...item, key: "../other" }] }, {}), /identifier/);
    assert.equal(calls.length, 0);
    await submit.execute({ summary: "One safe change", tasks: [item], workerId: "forged", candidate: "forged" }, {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/runs\/run-1\/plan$/);
    assert.deepEqual(calls[0].body, { workerId: "worker-1", runId: "run-1", epoch: 2, planRevision: 1, summary: "One safe change", tasks: [item] });
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("blocking questions, answers and escalation use durable run-scoped endpoints without a claim or a polling loop", async () => {
  const previous = { ...process.env }; const originalFetch = globalThis.fetch;
  const tools = new Map(); const calls = [];
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), token: init.headers.authorization }); return Response.json({ question: { status: "pending" } }); };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    await assert.rejects(() => tools.get("camp_ask_question").execute({ content: "Choose ordering", to_role: "planner", needs_human: "yes" }, {}), /boolean/);
    await tools.get("camp_ask_question").execute({ content: "Which ordering follows the requirement?", to_role: "planner" }, {});
    const questionId = calls[0].body.questionId;
    assert.match(questionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(calls[0].body.toRole, "planner");
    await tools.get("camp_answer_question").execute({ question_id: questionId, answer: "Ascending, as specified in the requirement" }, {});
    await tools.get("camp_escalate_question").execute({ question_id: questionId, reason: "The requirement leaves the supported region unspecified" }, {});
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
      "/api/camp/worker/runs/run-1/questions", `/api/camp/worker/runs/run-1/questions/${questionId}/answer`, `/api/camp/worker/runs/run-1/questions/${questionId}/escalate`,
    ]);
    assert.ok(calls.every(call => call.token === "Bearer short-run-token" && call.body.epoch === 2));
    assert.equal(JSON.stringify(calls).includes("must-not-use"), false);
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("finalization reports evidence and limitations without accepting a model-selected candidate or replaying a rejection", async () => {
  const previous = { ...process.env }; const originalFetch = globalThis.fetch;
  const tools = new Map(); const calls = [];
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("fenced", { status: 409 }); };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    const finalize = tools.get("camp_finalize");
    await assert.rejects(() => finalize.execute({ summary: "Done", remaining: [""] }, {}), /limitations/);
    await assert.rejects(() => finalize.execute({ summary: "Parser and UI delivered", evidence: "node --test passed 8 checks", remaining: ["Deployment is not included"], candidate: { commitId: "forged" } }, {}), /no longer authorized/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/runs\/run-1\/finalize$/);
    assert.deepEqual(calls[0].body, { workerId: "worker-1", runId: "run-1", epoch: 2, summary: "Parser and UI delivered", evidence: "node --test passed 8 checks", remaining: ["Deployment is not included"] });
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("review and file tools produce typed artifacts, and a review cannot default to approval", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tools = new Map(); const calls = [];
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (_url, init) => {
      if (init.method === "GET") return Response.json({ reviewTarget: { projectId: "project-current", commitId: "candidate-current", branch: "review" } });
      calls.push(JSON.parse(init.body)); return new Response('{"event":{"id":"event-1"}}');
    };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    await tools.get("camp_artifact").execute({ path: "src/app.ts", summary: "Implemented", commit: "candidate-1" }, {});
    assert.deepEqual(calls[0].artifact, { type: "file", path: "src/app.ts", summary: "Implemented", commitId: "candidate-1" });
    await tools.get("camp_review").execute({ outcome: "changes_requested", summary: "Regression", evidence: "node test.js exited 1", candidate: { projectId: "forged", commitId: "other" } }, {});
    assert.equal(calls[1].artifact.type, "review");
    assert.equal(calls[1].artifact.outcome, "changes_requested");
    assert.deepEqual(calls[1].artifact.candidate, { projectId: "project-current", commitId: "candidate-current" });
    await assert.rejects(async () => tools.get("camp_review").execute({ summary: "Looks good", evidence: "None" }, {}), /outcome/);
    assert.equal(calls.length, 2);
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("a review without a server-authorized immutable candidate never submits an unbound verdict", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tools = new Map();
  let writes = 0;
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (_url, init) => {
      if (init.method !== "GET") writes += 1;
      return Response.json({ reviewTarget: null });
    };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    await assert.rejects(() => tools.get("camp_review").execute({ outcome: "approved", summary: "Reviewed", evidence: "Tests passed" }, {}), /No immutable review candidate/);
    assert.equal(writes, 0);
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("review binds an immutable initial Layer or Commit reference without inventing a commit for a no-op project", async () => {
  const previous = { ...process.env }; const originalFetch = globalThis.fetch;
  const tools = new Map(); const writes = [];
  let target = { projectId: "p-0123456789abcdef", refKind: "layer", refId: "32" + "a".repeat(64), layerId: "32" + "a".repeat(64) };
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (_url, init) => {
      if (init.method === "GET") return Response.json({ reviewTarget: target });
      writes.push(JSON.parse(init.body)); return Response.json({ event: { id: "bound-review" } });
    };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    const review = tools.get("camp_review");
    await review.execute({ outcome: "approved", summary: "Already satisfies acceptance", evidence: "Read-only tests passed", candidate: { commitId: "forged" } }, {});
    assert.deepEqual(writes[0].artifact.candidate, target);
    assert.equal("commitId" in writes[0].artifact.candidate, false);
    target = { projectId: "p-0123456789abcdef", refKind: "commit", refId: "12" + "b".repeat(64), commitId: "12" + "b".repeat(64) };
    await review.execute({ outcome: "approved", summary: "Implemented and verified", evidence: "Tests passed" }, {});
    assert.deepEqual(writes[1].artifact.candidate, target);
    target = { ...target, commitId: "12" + "c".repeat(64) };
    await assert.rejects(() => review.execute({ outcome: "approved", summary: "Must refuse inconsistent server state", evidence: "No write" }, {}), /inconsistent reference/);
    assert.equal(writes.length, 2);
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("a review rejected after context lookup is never replayed or rebound to another candidate", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  const tools = new Map();
  let reads = 0; let writes = 0;
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async (_url, init) => {
      if (init.method === "GET") { reads += 1; return Response.json({ reviewTarget: { projectId: "p", commitId: "candidate-before-fence" } }); }
      writes += 1;
      assert.deepEqual(JSON.parse(init.body).artifact.candidate, { projectId: "p", commitId: "candidate-before-fence" });
      return new Response("superseded", { status: 409 });
    };
    apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {} }, on() {} });
    await assert.rejects(() => tools.get("camp_review").execute({ outcome: "approved", summary: "Reviewed", evidence: "node --test passed" }, {}), /no longer authorized/);
    assert.equal(reads, 1); assert.equal(writes, 1);
  } finally { process.env = previous; globalThis.fetch = originalFetch; }
});

test("profile assembly reuses installed official bundles and disables the official private spawn/fork surfaces", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "camp-dsh-profile-"));
  try {
    const modules = path.join(directory, "installed/node_modules");
    for (const name of ["dsh-base", "dsh-acp-app"]) {
      const root = path.join(modules, "@deepseek-ai", name);
      await mkdir(root, { recursive: true }); await writeFile(path.join(root, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: "test" }));
    }
    const home = path.join(directory, "home");
    const script = fileURLToPath(new URL("../scripts/prepare-profile.mjs", import.meta.url));
    await promisify(execFile)(process.execPath, [script, "--home", home, "--node-modules", modules]);
    const manifest = JSON.parse(await readFile(path.join(home, "profiles/camp/package.json"), "utf8"));
    assert.deepEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "@camp/dsh-plugin"]);
    const pluginManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pluginManifest.dsh.bundle.patch, "./cordis.patch.yml");
    const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
    for (const id of ["subagent-spawn-in-process", "subagent-fork-in-process", "tool-subagent", "tool-subagent-fork", "workflow-ptc"]) assert.match(patch, new RegExp(`id: ${id}\\n  disabled: true`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
