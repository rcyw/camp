/** DSH's official ACP v1 transport, shared by Camp workers and the native daemon driver. */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ParsedEvent, RuntimeExitInfo, RuntimeSendResult, RuntimeSession, RuntimeSessionDescriptor } from "./types";

export interface DshRuntimeOptions {
  /** Executable and complete argv, also permitting an explicitly supplied docker-exec launcher. */
  command?: string;
  args?: string[];
  cwd: string;
  /** Local launcher cwd when the ACP workspace path exists only inside a container. */
  processCwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string | null;
  /** `profile` preserves the DSH profile's configured model. Other values must match its ACP catalog. */
  model?: string | null;
  reasoningEffort?: string | null;
  /** ACP has no developer-message slot; these instructions are logged in the first prompt. */
  standingPrompt?: string;
  handshakeTimeoutMs?: number;
  cancelGraceMs?: number;
  signal?: AbortSignal;
  assertLaunchCurrent?: () => void;
  /** Only enable automatic permission approval inside an operator-provisioned sandbox. */
  approvePermissions?: boolean;
}

type RecordValue = Record<string, unknown>;
type RpcId = number | string;
type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> };
type SessionEvents = {
  runtime_event: [ParsedEvent]; stdout: [string]; stderr: [string]; error: [Error];
  exit: [RuntimeExitInfo]; close: [RuntimeExitInfo];
};
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class DshAcpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = "DshAcpError"; }
}

/** Strip the supervisor credential even if a caller accidentally passes its entire environment. */
export function dshChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "0" };
  delete childEnv.CAMP_WORKER_TOKEN;
  return childEnv;
}

/** Resolve an ACP model's opaque JSON value from its advertised configuration, without guessing a provider. */
export function dshConfigValue(options: unknown, id: string, requested: string): string {
  const config = Array.isArray(options) ? options.map(record).find((option) => option?.id === id) : null;
  if (!config) throw new DshAcpError(`DSH does not advertise configuration option ${id}`);
  const entries: RecordValue[] = [];
  const visit = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const item = record(value);
      if (!item) continue;
      if (typeof item.value === "string") entries.push(item);
      visit(item.options);
    }
  };
  visit(config.options);
  const matches = entries.filter((entry) => {
    if (entry.value === requested) return true;
    if (id !== "model" || typeof entry.value !== "string") return false;
    try {
      const value: unknown = JSON.parse(entry.value);
      return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string")
        && `${value[0]}/${value[1]}` === requested;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new DshAcpError(`DSH ${id} selection is unavailable or ambiguous: ${requested}`);
  return matches[0]!.value as string;
}

/** One ACP process/session. Busy input is rejected for the caller to retain and queue until turn_end. */
export class DshAcpRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeSessionDescriptor = {
    transport: "child_process", lifecycle: "app_server", stdout: { channel: "structured_protocol" },
    input: { initial: "request", idle: "request", busy: "unsupported" }, readiness: "healthcheck",
    turnBoundary: "parsed_event", startPolicy: "immediate", inFlightWake: "queue", busyDelivery: "none", postTurn: "keep_alive",
  };
  private readonly events = new EventEmitter();
  private process: ChildProcess | null = null;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private requestId = 0;
  private sessionId: string | null = null;
  private started = false;
  private active = false;
  private stopping = false;
  private exited = false;
  private requestedStop = false;
  private stopPromise?: Promise<void>;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private readonly toolNames = new Map<string, string>();
  private readonly abort = () => { void this.stop({ reason: "aborted" }); };

  constructor(private readonly options: DshRuntimeOptions) {}
  get pid(): number | undefined { return this.process?.pid; }
  get currentSessionId(): string | null { return this.sessionId; }
  get currentRuntimeHomeDir(): string | undefined { return this.options.env?.DSH_HOME; }
  get exitCode(): number | null { return this.process?.exitCode ?? null; }
  get signalCode(): NodeJS.Signals | null { return this.process?.signalCode ?? null; }
  get closed(): boolean { return this.exited || this.stopping; }
  isAlive(): boolean | undefined {
    if (!this.pid) return this.started ? false : undefined;
    try { process.kill(this.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  on<K extends keyof SessionEvents>(event: K, cb: (...args: SessionEvents[K]) => void): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult> {
    if (this.started || this.stopping) return { ok: false, reason: "closed" };
    this.started = true;
    try {
      if (this.options.signal?.aborted) throw new DshAcpError("DSH start cancelled before spawn");
      this.options.assertLaunchCurrent?.();
      this.launch();
      this.options.signal?.addEventListener("abort", this.abort, { once: true });
      const initialized = record(await this.request("initialize", {
        protocolVersion: 1, clientInfo: { name: "camp", version: "0.1.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }));
      if (initialized?.protocolVersion !== 1) throw new DshAcpError("DSH did not negotiate ACP protocol version 1");
      if (this.stopping) throw new DshAcpError("DSH start cancelled during handshake");
      const resumeId = input.sessionId ?? this.options.sessionId;
      const session = record(await this.request(resumeId ? "session/resume" : "session/new", {
        ...(resumeId ? { sessionId: resumeId } : {}), cwd: this.options.cwd, mcpServers: [],
      }));
      // Resume failures are surfaced. Silently replacing a session would lose task context.
      const id = session?.sessionId ?? resumeId;
      if (typeof id !== "string" || !id) throw new DshAcpError("DSH returned no session identity");
      this.sessionId = id;
      let configOptions = session?.configOptions;
      if (this.options.model && this.options.model !== "profile") {
        const selected = record(await this.request("session/set_config_option", {
          sessionId: id, configId: "model", value: dshConfigValue(configOptions, "model", this.options.model),
        }));
        configOptions = selected?.configOptions ?? configOptions;
      }
      if (this.options.reasoningEffort) {
        await this.request("session/set_config_option", {
          sessionId: id, configId: "reasoning_effort", value: dshConfigValue(configOptions, "reasoning_effort", this.options.reasoningEffort),
        });
      }
      if (this.stopping) throw new DshAcpError("DSH start cancelled before first prompt");
      this.emit({ kind: "session_init", sessionId: id });
      const prompt = this.options.standingPrompt ? `${this.options.standingPrompt}\n\n${input.text}` : input.text;
      this.prompt(prompt);
      return { ok: true, acceptedAs: "prompt" };
    } catch (error) {
      if (!this.stopping) this.emit({ kind: "error", message: `DSH startup failed: ${messageOf(error)}` });
      await this.stop({ reason: "startup_failed" });
      return { ok: false, reason: "runtime_error", error: messageOf(error) };
    }
  }

  send(input: { mode: "idle" | "busy"; text: string; sessionId?: string | null }): RuntimeSendResult {
    if (this.closed || !this.sessionId) return { ok: false, reason: "closed" };
    if (input.sessionId && input.sessionId !== this.sessionId) return { ok: false, reason: "runtime_error", error: "DSH session identity mismatch" };
    if (this.active || input.mode === "busy") return { ok: false, reason: "busy_rejected" };
    this.prompt(input.text);
    return { ok: true, acceptedAs: "prompt" };
  }

  stop(opts?: { signal?: NodeJS.Signals; forceAfterMs?: number; reason?: string }): Promise<void> {
    if (opts?.signal === "SIGKILL") this.kill("SIGKILL");
    this.stopPromise ??= this.close(opts?.forceAfterMs);
    return this.stopPromise;
  }
  dispose(): Promise<void> { return this.stop(); }

  private launch(): void {
    this.exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
    const child = spawn(this.options.command ?? "dsh", this.options.args ?? ["--profile", "camp"], {
      cwd: this.options.processCwd ?? this.options.cwd, env: dshChildEnvironment(this.options.env), stdio: ["pipe", "pipe", "pipe"],
      shell: false, detached: process.platform !== "win32", windowsHide: true,
    });
    this.process = child;
    child.stdout?.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => this.events.emit("stderr", chunk.toString("utf8")));
    child.stdin?.on("error", (error: Error) => this.failTransport(error));
    child.on("error", (error) => this.failTransport(error));
    child.on("exit", (code, signal) => this.didExit(code, signal));
    child.on("close", (code, signal) => {
      this.didExit(code, signal);
      this.events.emit("close", { code, signal, reason: this.requestedStop ? "requested" : "runtime_exit" } satisfies RuntimeExitInfo);
    });
  }

  private request(method: string, params: RecordValue, timeoutMs: number | null = this.options.handshakeTimeoutMs ?? 30_000): Promise<unknown> {
    if (this.exited) return Promise.reject(new DshAcpError("DSH process has exited"));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs !== null) pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshAcpError(`DSH ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, pending);
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(pending.timer); reject(error); }
    });
  }
  private write(frame: RecordValue): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) throw new DshAcpError("DSH protocol input is closed");
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  private prompt(text: string): void {
    this.active = true;
    this.toolNames.clear();
    // Prompt duration belongs to the worker's lease/cancellation policy, not a short RPC timeout.
    void this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, null).then((response) => {
      this.active = false;
      const stopReason = record(response)?.stopReason;
      if (!this.stopping && stopReason !== "end_turn") {
        this.emit({ kind: "error", message: `DSH prompt stopped without completion (${String(stopReason ?? "missing stop reason")})` });
      }
      this.emit({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
    }, (error: unknown) => {
      this.active = false;
      if (!this.stopping) {
        this.emit({ kind: "error", message: `DSH prompt failed: ${messageOf(error)}`, startupRequestMethod: "session/prompt" });
        this.emit({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
      }
    });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > 16 * 1024 * 1024) {
      this.failTransport(new DshAcpError("DSH ACP frame exceeds 16 MiB"));
      this.buffer = "";
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: RecordValue | null;
      try { frame = record(JSON.parse(line)); }
      catch { this.failTransport(new DshAcpError("DSH wrote non-JSON data to its ACP stdout")); return; }
      if (!frame || frame.jsonrpc !== "2.0") { this.failTransport(new DshAcpError("Invalid DSH ACP frame")); return; }
      this.handleFrame(frame);
    }
  }
  private handleFrame(frame: RecordValue): void {
    const id = typeof frame.id === "number" || typeof frame.id === "string" ? frame.id : undefined;
    if (id !== undefined && typeof frame.method !== "string") {
      const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer);
      const error = record(frame.error);
      if (error) pending.reject(new DshAcpError(typeof error.message === "string" ? error.message : "DSH ACP request failed", typeof error.code === "number" ? error.code : undefined));
      else pending.resolve(frame.result);
      return;
    }
    if (id !== undefined) {
      if (frame.method === "session/request_permission") {
        const params = record(frame.params);
        const choices = Array.isArray(params?.options) ? params.options.map(record) : [];
        const allowed = this.options.approvePermissions && !this.stopping
          ? choices.find((choice) => choice?.kind === "allow_once" && typeof choice.optionId === "string") : undefined;
        this.write({ jsonrpc: "2.0", id, result: { outcome: allowed ? { outcome: "selected", optionId: allowed.optionId } : { outcome: "cancelled" } } });
      } else this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client method not supported by Camp" } });
      return;
    }
    if (frame.method !== "session/update") return;
    const params = record(frame.params);
    // Ignore stale/foreign session updates; DSH can multiplex sessions on one connection.
    if (!this.sessionId || params?.sessionId !== this.sessionId) return;
    const update = record(params.update); if (!update) return;
    const content = record(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      if (update.sessionUpdate === "agent_message_chunk") this.emit({ kind: "text", text: content.text });
      if (update.sessionUpdate === "agent_thought_chunk") this.emit({ kind: "thinking", text: content.text });
    }
    if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
      const name = typeof update.title === "string" ? update.title : "tool";
      this.toolNames.set(update.toolCallId, name);
      this.emit({ kind: "tool_call", name, input: update.rawInput ?? {}, callId: update.toolCallId });
    }
    if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string"
      && (update.status === "completed" || update.status === "failed")) {
      this.emit({ kind: "tool_output", name: this.toolNames.get(update.toolCallId) ?? "tool", callId: update.toolCallId, ok: update.status === "completed" });
      this.toolNames.delete(update.toolCallId);
    }
  }
  private emit(event: ParsedEvent): void { this.events.emit("runtime_event", event); }
  private failTransport(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.stopping) this.emit({ kind: "error", message: error.message });
    void this.stop({ reason: "protocol_failure" }).catch((stopError: unknown) => this.events.emit("stderr", messageOf(stopError)));
  }
  private didExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DshAcpError("DSH exited before replying")); }
    this.pending.clear();
    this.resolveExit?.();
    this.events.emit("exit", { code, signal, reason: this.requestedStop ? "requested" : "runtime_exit" } satisfies RuntimeExitInfo);
  }
  private async close(forceAfterMs = this.options.cancelGraceMs ?? 2_000): Promise<void> {
    this.stopping = true; this.requestedStop = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    if (!this.process || this.exited) return;
    if (this.sessionId) {
      try {
        this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
        await this.request("session/close", { sessionId: this.sessionId }, forceAfterMs);
      } catch { /* The owned process is terminated below even when ACP teardown fails. */ }
    }
    this.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exitPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, forceAfterMs); })]);
    clearTimeout(timer);
    if (!this.exited) {
      this.kill("SIGKILL");
      await Promise.race([this.exitPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
      clearTimeout(timer);
      if (!this.exited) throw new DshAcpError("DSH process exit is unconfirmed after SIGKILL");
    }
  }
  private kill(signal: NodeJS.Signals): void {
    if (!this.process || this.exited) return;
    try {
      if (process.platform !== "win32" && this.pid) process.kill(-this.pid, signal);
      else this.process.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

export function createDshRuntimeSession(options: DshRuntimeOptions): RuntimeSession {
  return new DshAcpRuntimeSession(options);
}
