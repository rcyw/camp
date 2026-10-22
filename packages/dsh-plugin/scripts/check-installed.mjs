/** Keyless integration check: resolve the real profile and initialize ACP without creating a session or prompting a model. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const modules = process.argv[2];
if (!modules) throw new Error("Usage: node check-installed.mjs /absolute/installed/node_modules");
const home = await mkdtemp(path.join(os.tmpdir(), "camp-dsh-boot-"));
const exec = promisify(execFile);
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
try {
  await exec(process.execPath, [fileURLToPath(new URL("prepare-profile.mjs", import.meta.url)), "--home", home, "--node-modules", path.resolve(modules)]);
  const entry = path.resolve(modules, "@deepseek-ai/dsh/lib/bin.js");
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, DSH_HOME: home };
  delete env.DEEPSEEK_API_KEY;
  const config = await exec(process.execPath, [entry, "--profile", "camp", "--dump-config"], { env, cwd: home, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (!config.stdout.includes("@camp/dsh-plugin") || config.stderr.includes("skipping profile bundle")) throw new Error("Real DSH profile did not load the Camp bundle");
  child = spawn(process.execPath, [entry, "--profile", "camp"], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdout || !child.stdin) throw new Error("ACP process did not expose its stdio transport");
  let diagnostic = "";
  child.stderr?.on("data", (part) => { diagnostic = (diagnostic + part.toString()).slice(-2000); });
  const currentChild = child;
  const stdout = child.stdout;
  /** @type {unknown} */
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ACP initialization timed out: ${diagnostic}`)), 15_000);
    currentChild.once("error", (error) => { clearTimeout(timer); reject(error); });
    currentChild.once("exit", (code) => { clearTimeout(timer); reject(new Error(`ACP boot exited ${code}: ${diagnostic}`)); });
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.id === 1) { clearTimeout(timer); resolve(frame); }
    });
    currentChild.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "camp-keyless-check", version: "1" }, clientCapabilities: {} } })}\n`);
  });
  if (!reply || typeof reply !== "object" || !("result" in reply) || /** @type {{protocolVersion?: number}} */ (reply.result)?.protocolVersion !== 1) throw new Error("Real DSH did not accept ACP initialize");
  process.stdout.write(`${JSON.stringify({ profileResolved: true, campPluginLoaded: true, acpInitialized: true, agentSessionsCreated: 0, modelPromptsSent: 0 })}\n`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const currentChild = child;
    const exited = new Promise((resolve) => currentChild.once("exit", resolve));
    currentChild.kill("SIGTERM");
    const timer = setTimeout(() => currentChild.kill("SIGKILL"), 1_000);
    await exited; clearTimeout(timer);
  }
  await rm(home, { recursive: true, force: true });
}
