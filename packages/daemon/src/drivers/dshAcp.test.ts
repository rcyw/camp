import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDshRuntimeSession, dshConfigValue, type DshRuntimeOptions } from "./dshAcp";
import { dshLaunchOptions, DshDriver } from "./dsh";
import type { ParsedEvent, RuntimeSession } from "./types";

const fixture = fileURLToPath(new URL("../testdata/dsh-acp-fixture.mjs", import.meta.url));
const directories: string[] = [];
const runtimes: RuntimeSession[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => {});
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(mode = "normal", overrides: Partial<DshRuntimeOptions> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "camp-dsh-acp-")); directories.push(cwd);
  const log = path.join(cwd, "requests.jsonl");
  const runtime = createDshRuntimeSession({
    command: process.execPath, args: [fixture], cwd, handshakeTimeoutMs: 1_000, cancelGraceMs: 50,
    env: { ...process.env, DSH_TEST_MODE: mode, DSH_TEST_LOG: log, CAMP_WORKER_TOKEN: "supervisor-secret", CAMP_RUN_TOKEN: "run-secret" },
    ...overrides,
  });
  runtimes.push(runtime);
  const events: ParsedEvent[] = []; runtime.on("runtime_event", (event) => events.push(event));
  return { runtime, events, requests: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; result?: unknown }) };
}

async function until(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for fake ACP peer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("negotiates official ACP, selects opaque model options, and maps only the current session's committed events", async () => {
  const { runtime, events, requests } = await setup("normal", { model: "deepseek-official/pro", reasoningEffort: "high", standingPrompt: "Stay in the assigned Camp role." });
  expect(await runtime.start({ text: "Fix the test" })).toEqual({ ok: true, acceptedAs: "prompt" });
  expect(runtime.send({ mode: "busy", text: "Do more" })).toEqual({ ok: false, reason: "busy_rejected" });
  await until(() => events.some((event) => event.kind === "turn_end"));
  expect(events).toContainEqual({ kind: "session_init", sessionId: "dsh-session-1" });
  expect(events).toContainEqual({ kind: "text", text: "worker=false;run=true" });
  expect(events).toContainEqual({ kind: "tool_call", name: "camp_read_room", input: {}, callId: "call-1" });
  expect(events).toContainEqual({ kind: "tool_output", name: "camp_read_room", callId: "call-1", ok: true });
  expect(events.some((event) => event.kind === "text" && event.text === "FOREIGN")).toBe(false);
  const frames = await requests();
  expect(frames.map((frame) => frame.method).slice(0, 5)).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt"]);
  expect(frames[2]?.params?.value).toBe('["deepseek-official","pro"]');
  expect(frames[4]?.params?.prompt).toEqual([{ type: "text", text: "Stay in the assigned Camp role.\n\nFix the test" }]);
  expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
  expect(runtime.send({ mode: "idle", text: "Next task" })).toEqual({ ok: true, acceptedAs: "prompt" });
  await until(() => events.filter((event) => event.kind === "turn_end").length === 2);
});

test("resumes with session/resume and surfaces missing history instead of silently creating a fresh session", async () => {
  const good = await setup("running");
  expect((await good.runtime.start({ text: "Continue", sessionId: "saved-42" })).ok).toBe(true);
  expect(good.runtime.currentSessionId).toBe("saved-42");
  expect((await good.requests()).map((frame) => frame.method)).toContain("session/resume");
  const missing = await setup("missing-session");
  expect((await missing.runtime.start({ text: "Continue", sessionId: "missing" })).ok).toBe(false);
  expect((await missing.requests()).some((frame) => frame.method === "session/new")).toBe(false);
  expect(missing.events.some((event) => event.kind === "error" && event.message.includes("does not exist"))).toBe(true);
});

test("rejects an unavailable model before dispatching work", async () => {
  const { runtime, requests } = await setup("normal", { model: "unknown/model" });
  expect((await runtime.start({ text: "Do not run" })).ok).toBe(false);
  expect((await requests()).some((frame) => frame.method === "session/prompt")).toBe(false);
});

test("cancels and closes a running ACP session before terminating its process", async () => {
  const { runtime, requests } = await setup("running");
  await runtime.start({ text: "Long task" });
  await runtime.stop();
  const methods = (await requests()).map((frame) => frame.method);
  expect(methods.indexOf("session/cancel")).toBeLessThan(methods.indexOf("session/close"));
  expect(runtime.isAlive()).toBe(false);
});

test("force kills a non-cooperative runtime after bounded ACP and TERM grace periods", async () => {
  const { runtime } = await setup("ignore-stop");
  await runtime.start({ text: "Long task" });
  await runtime.stop();
  expect(runtime.signalCode).toBe("SIGKILL");
  expect(runtime.isAlive()).toBe(false);
});

test("bounds handshake failures and contains malformed protocol output", async () => {
  const hung = await setup("timeout", { handshakeTimeoutMs: 50 });
  expect((await hung.runtime.start({ text: "Never start" })).ok).toBe(false);
  expect(hung.runtime.isAlive()).toBe(false);
  const malformed = await setup("malformed");
  expect((await malformed.runtime.start({ text: "Never start" })).ok).toBe(false);
  expect(malformed.runtime.isAlive()).toBe(false);
});

test("supports explicit permission approval and defaults to cancelling approval requests", async () => {
  for (const approvePermissions of [false, true]) {
    const { runtime, requests, events } = await setup("permission", { approvePermissions });
    await runtime.start({ text: "Task" });
    await until(() => events.some((event) => event.kind === "turn_end"));
    const response = (await requests()).find((frame) => frame.result !== undefined);
    expect(response?.result).toEqual({ outcome: approvePermissions ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" } });
  }
});

test("cancellation before start never spawns a process", async () => {
  const controller = new AbortController(); controller.abort();
  const { runtime } = await setup("normal", { signal: controller.signal });
  expect((await runtime.start({ text: "No spawn" })).ok).toBe(false);
  expect(runtime.pid).toBeUndefined();
});

test("keeps the local launcher cwd separate from the container's ACP workspace", async () => {
  const processCwd = os.tmpdir();
  const { runtime, requests } = await setup("normal", { cwd: "/container-only/camp-workspace", processCwd });
  expect((await runtime.start({ text: "Container task" })).ok).toBe(true);
  expect((await requests()).find((frame) => frame.method === "session/new")?.params?.cwd).toBe("/container-only/camp-workspace");
});

test("native driver queues busy delivery and launch arguments preserve spaces without a shell", () => {
  const driver = new DshDriver();
  expect(driver.lifecycle.inFlightWake).toBe("queue");
  expect(driver.busyDeliveryMode).toBe("none");
  expect(dshLaunchOptions({ CAMP_DSH_COMMAND: "/opt/DSH runtime/dsh", CAMP_DSH_ARGS_JSON: '["entry.js"]', CAMP_DSH_PATCHES: '["/config/camp patch.yml"]' })).toEqual({
    command: "/opt/DSH runtime/dsh", args: ["entry.js", "--profile", "camp", "--patch", "/config/camp patch.yml"],
  });
  expect(() => dshConfigValue([], "model", "bad")).toThrow("does not advertise");
});
