/** Native Raft lifecycle adapter around the same ACP session used by Camp sandbox workers. */
import { execFileSync } from "node:child_process";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig, type AxSurfaceText } from "@botiverse/raft-shared";
import { ambientProcessEnv } from "../processEnvPatch";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { createDshRuntimeSession, type DshRuntimeOptions } from "./dshAcp";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, RuntimeSession, SpawnContext, SpawnResult } from "./types";

function stringList(value: string | undefined, name: string): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) throw new Error(`${name} must be a JSON array of strings`);
  return parsed as string[];
}

/** Deployment launch configuration; arguments are passed directly, never through a shell. */
export function dshLaunchOptions(env: NodeJS.ProcessEnv = ambientProcessEnv()): Pick<DshRuntimeOptions, "command" | "args"> {
  const prefix = stringList(env.CAMP_DSH_ARGS_JSON, "CAMP_DSH_ARGS_JSON");
  const patches = stringList(env.CAMP_DSH_PATCHES, "CAMP_DSH_PATCHES");
  return {
    command: env.CAMP_DSH_COMMAND || "dsh",
    args: [...prefix, "--profile", env.CAMP_DSH_PROFILE || "camp", ...patches.flatMap((patch) => ["--patch", patch])],
  };
}

export class DshDriver implements RuntimeDriver {
  readonly id = "dsh";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "queue" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only", toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }) } as const;
  readonly stdoutChannel = "structured_protocol" as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "none" as const;
  readonly supportsNativeStandingPrompt = false;
  readonly startupReadiness = "initial_turn" as const;
  readonly requiresSessionInitForDelivery = true as const;

  probe(): RuntimeProbeResult {
    const env = ambientProcessEnv();
    try {
      const launch = dshLaunchOptions(env);
      const version = execFileSync(launch.command!, [...stringList(env.CAMP_DSH_ARGS_JSON, "CAMP_DSH_ARGS_JSON"), "--version"], {
        env, encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      }).trim();
      return { available: true, version: version.slice(0, 120) };
    } catch (error) {
      return { available: false, unavailableReason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : "probe_failed" };
    }
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    // Transport preparation is asynchronous, so defer it until RuntimeSession.start().
    let runtime: RuntimeSession | undefined;
    const deferredListeners: Array<{ event: string; cb: (...args: never[]) => void }> = [];
    let stopping = false;
    const deferred: RuntimeSession = {
      descriptor: {
        transport: "child_process", lifecycle: "app_server", stdout: { channel: "structured_protocol" },
        input: { initial: "request", idle: "request", busy: "unsupported" }, readiness: "healthcheck",
        turnBoundary: "parsed_event", startPolicy: "immediate", inFlightWake: "queue", busyDelivery: "none", postTurn: "keep_alive",
      },
      get pid() { return runtime?.pid; },
      get currentSessionId() { return runtime?.currentSessionId; },
      get currentRuntimeHomeDir() { return runtime?.currentRuntimeHomeDir; },
      get exitCode() { return runtime?.exitCode ?? null; },
      get signalCode() { return runtime?.signalCode ?? null; },
      get closed() { return stopping || (runtime?.closed ?? false); },
      isAlive: () => runtime?.isAlive(),
      on(event, cb) {
        // Event overloads are preserved by RuntimeSession; this queue only defers attachment.
        const listener = { event, cb: cb as (...args: never[]) => void };
        if (runtime) attach(runtime, listener);
        else deferredListeners.push(listener);
      },
      async start(input) {
        if (stopping) return { ok: false, reason: "closed" };
        const { spawnEnv } = await prepareCliTransport(ctx);
        if (stopping || ctx.launchSignal?.aborted) return { ok: false, reason: "closed" };
        const fields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
        runtime = createDshRuntimeSession({
          ...dshLaunchOptions(spawnEnv), cwd: ctx.workingDirectory, env: spawnEnv,
          model: fields.model, reasoningEffort: fields.reasoningEffort,
          sessionId: ctx.config.sessionId, signal: ctx.launchSignal, assertLaunchCurrent: ctx.assertLaunchCurrent,
          approvePermissions: true,
        });
        for (const listener of deferredListeners.splice(0)) attach(runtime, listener);
        // The existing APM includes its standing prompt for runtimes without a native prompt layer.
        return runtime.start(input);
      },
      send: (input) => runtime?.send(input) ?? { ok: false, reason: "closed" },
      async stop(options) { stopping = true; await runtime?.stop(options); },
      async dispose() { stopping = true; await runtime?.dispose?.(); },
    };
    return deferred;
  }

  spawn(_ctx: SpawnContext): SpawnResult { throw new Error("DSH uses createSession(), not the raw child-process adapter"); }
  parseLine(_line: string): ParsedEvent[] { return []; }
  encodeStdinMessage(): null { return null; }
  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, { supportsSubagents: false, extraCriticalRules: [
      "Camp owns platform roles and task execution. Never create, fork, or spawn private subagents. Coordinate through room messages and handoff tools.",
    ] });
  }
}

function attach(runtime: RuntimeSession, listener: { event: string; cb: (...args: never[]) => void }): void {
  // RuntimeSession's overload set is represented as a single event dispatch at this adapter seam.
  (runtime.on as (event: string, cb: (...args: never[]) => void) => void)(listener.event, listener.cb);
}
