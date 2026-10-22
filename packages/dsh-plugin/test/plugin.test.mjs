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

const env = {
  CAMP_API_URL: "http://camp.test:13018", CAMP_RUN_TOKEN: "short-run-token", CAMP_WORKER_TOKEN: "must-not-use",
  CAMP_WORKER_ID: "worker-1", CAMP_RUN_ID: "run-1", CAMP_RUN_EPOCH: "2", CAMP_ROOM_ID: "room-1",
};

test("requires an explicit run capability and never falls back to the supervisor token", () => {
  assert.equal(runContext(env).token, "short-run-token");
  assert.throws(() => runContext({ ...env, CAMP_RUN_TOKEN: "" }), /CAMP_RUN_TOKEN/);
  assert.throws(() => runContext({ ...env, CAMP_RUN_EPOCH: "0" }), /positive integer/);
  assert.throws(() => runContext({ ...env, CAMP_API_URL: "file:///tmp/state" }), /HTTP/);
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
  assert.deepEqual([...tools.keys()], ["camp_read_context", "camp_read_room", "camp_send_message", "camp_progress", "camp_artifact", "camp_handoff", "camp_review"]);
  assert.equal([...tools.keys()].some((name) => /claim|complete|heartbeat/.test(name)), false);
  assert.match(sections[0].text, /never transfers the task lease/);
  const guard = gates.get("tools/pre-execute");
  let delegated = false;
  assert.equal((await guard({ name: "subagent_fork" }, async () => { delegated = true; })).kind, "deny");
  assert.equal(delegated, false);
  assert.deepEqual(await guard({ name: "bash" }, async () => ({ kind: "allow" })), { kind: "allow" });
  for (const tool of tools.values()) assert.equal(tool.output.schema.type, "object");
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
